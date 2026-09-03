"""LLM usage metering, rate limits, and the automatic spend backstop.

Why this exists: /generate is unauthenticated (anyone can use the product
without an account) and every call costs money. Without a ceiling, a single
script — or a bad day of ad traffic — can run up an unbounded Bedrock bill
before anyone notices, and AWS billing data lags hours behind.

Three layers:
  1. per-IP limits    — stops one abuser
  2. a daily budget   — stops the aggregate, including distributed abuse
  3. auto-pause+alert — flips the kill switch rather than just logging
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app import flags
from app.models import LlmUsage

log = logging.getLogger("app.usage")

# Per-IP ceilings. A busy legitimate session is tens of turns, not hundreds.
MAX_CALLS_PER_IP_HOUR = 60
MAX_CALLS_PER_IP_DAY = 300

# Daily spend ceiling (USD, estimated from tokens). Crossing it pauses all model
# calls until an admin raises the ceiling and resumes. This is a backstop against
# runaway cost, not a capacity plan.
#
# Configurable three ways, most specific first:
#   1. the admin page (stored in `settings`, takes effect immediately)
#   2. LLM_DAILY_BUDGET_USD in the environment (sets the starting default)
#   3. the constant below
# At roughly $0.012 per agent turn, $50/day is ~4,000 turns — far above expected
# early traffic, so it should only ever trip on genuine runaway usage.
DAILY_BUDGET_USD = "llm_daily_budget_usd"


def _default_budget() -> float:
    import os

    try:
        return float(os.environ.get("LLM_DAILY_BUDGET_USD", "50"))
    except ValueError:
        return 50.0


DEFAULT_DAILY_BUDGET_USD = _default_budget()
# Warn once per day at this fraction of the budget.
WARN_FRACTION = 0.6

# USD per 1M tokens. Approximate on purpose: this drives a safety cutoff, not
# billing. Unknown models fall back to the Sonnet rate (the expensive case).
_RATES = {
    "sonnet": (3.0, 15.0),
    "haiku": (1.0, 5.0),
    "opus": (5.0, 25.0),
}


def _rate_for(model: str) -> tuple[float, float]:
    m = (model or "").lower()
    for key, rate in _RATES.items():
        if key in m:
            return rate
    return _RATES["sonnet"]


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    inp, out = _rate_for(model)
    return (input_tokens / 1_000_000) * inp + (output_tokens / 1_000_000) * out


def _day_start(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def record(
    db: Session,
    *,
    kind: str,
    model: str,
    ip: str = "",
    session_id: Optional[str] = None,
    input_tokens: int = 0,
    output_tokens: int = 0,
) -> None:
    """Log one model call. Never raises — metering must not break generation."""
    try:
        db.add(LlmUsage(
            kind=kind, model=model, ip=ip[:64], session_id=session_id,
            input_tokens=int(input_tokens or 0), output_tokens=int(output_tokens or 0),
        ))
        # Keep the table bounded; 30 days is plenty for limits and the admin view.
        db.execute(delete(LlmUsage).where(LlmUsage.created_at < datetime.now(timezone.utc) - timedelta(days=30)))
        db.commit()
    except Exception:
        log.exception("failed to record llm usage")
        db.rollback()


def today_totals(db: Session) -> dict:
    """Calls, tokens and estimated spend since 00:00 UTC."""
    since = _day_start(datetime.now(timezone.utc))
    rows = db.execute(
        select(LlmUsage.model, func.count(), func.sum(LlmUsage.input_tokens), func.sum(LlmUsage.output_tokens))
        .where(LlmUsage.created_at >= since)
        .group_by(LlmUsage.model)
    ).all()
    calls = tokens_in = tokens_out = 0
    cost = 0.0
    for model, n, tin, tout in rows:
        tin, tout = int(tin or 0), int(tout or 0)
        calls += int(n or 0)
        tokens_in += tin
        tokens_out += tout
        cost += estimate_cost(model or "", tin, tout)
    return {
        "calls": calls,
        "input_tokens": tokens_in,
        "output_tokens": tokens_out,
        "estimated_cost": round(cost, 4),
    }


def daily_budget(db: Session) -> float:
    from app.models import Setting

    row = db.get(Setting, DAILY_BUDGET_USD)
    if row is None:
        return _default_budget()
    try:
        return float(row.value)
    except (TypeError, ValueError):
        return _default_budget()


def ip_calls(db: Session, ip: str, window: timedelta) -> int:
    if not ip:
        return 0
    since = datetime.now(timezone.utc) - window
    return db.execute(
        select(func.count()).select_from(LlmUsage).where(LlmUsage.ip == ip, LlmUsage.created_at >= since)
    ).scalar_one()


def over_ip_limit(db: Session, ip: str) -> bool:
    return (
        ip_calls(db, ip, timedelta(hours=1)) >= MAX_CALLS_PER_IP_HOUR
        or ip_calls(db, ip, timedelta(days=1)) >= MAX_CALLS_PER_IP_DAY
    )


def enforce_budget(db: Session) -> bool:
    """Pause model calls if today's estimated spend is over budget.

    Returns True when the budget is exhausted (caller must refuse the request).
    Flipping the same switch the admin page uses means the state is visible and
    an admin can resume deliberately, rather than it silently resetting.
    """
    totals = today_totals(db)
    budget = daily_budget(db)
    if budget <= 0:
        return False
    spent = totals["estimated_cost"]

    if spent >= budget:
        if flags.llm_enabled(db):
            log.error("daily LLM budget exhausted ($%.2f >= $%.2f) — pausing generation", spent, budget)
            flags.set_bool(db, flags.LLM_ENABLED, False, actor="auto: daily budget")
            _notify_admins(db, spent, budget, paused=True)
        return True

    if spent >= budget * WARN_FRACTION:
        _warn_once(db, spent, budget)
    return False


_WARNED_KEY = "llm_budget_warned_on"


def _warn_once(db: Session, spent: float, budget: float) -> None:
    from app.models import Setting

    today = datetime.now(timezone.utc).date().isoformat()
    row = db.get(Setting, _WARNED_KEY)
    if row is not None and row.value == today:
        return
    if row is None:
        row = Setting(key=_WARNED_KEY)
        db.add(row)
    row.value = today
    db.commit()
    _notify_admins(db, spent, budget, paused=False)


def _notify_admins(db: Session, spent: float, budget: float, *, paused: bool) -> None:
    """Email admins. Best-effort: alerting must never break the request."""
    try:
        import os

        from app.auth import _send_code  # noqa: F401  (ensures MAIL_FROM semantics stay in one place)
        from app.models import User

        sender = os.environ.get("MAIL_FROM")
        admins = [u.email for u in db.execute(select(User).where(User.is_admin.is_(True))).scalars()]
        subject = (
            "Abracadata: AI generation auto-paused (daily budget reached)"
            if paused else
            f"Abracadata: AI spend at {spent / budget:.0%} of today's budget"
        )
        body = (
            f"Estimated spend today: ${spent:.2f} of a ${budget:.2f} budget.\n\n"
            + ("Generation has been PAUSED automatically. Resume it at "
               "https://abracadata.me/admin once you've checked the traffic.\n"
               if paused else
               "No action taken yet; generation pauses automatically at 100%.\n")
        )
        if not sender or not admins:
            log.warning("budget alert (no mailer/admins): %s — %s", subject, body.replace("\n", " "))
            return

        import boto3

        boto3.client("sesv2", region_name=os.environ.get("AWS_REGION", "us-east-2")).send_email(
            FromEmailAddress=sender,
            Destination={"ToAddresses": admins},
            Content={"Simple": {
                "Subject": {"Data": subject, "Charset": "UTF-8"},
                "Body": {"Text": {"Data": body, "Charset": "UTF-8"}},
            }},
        )
        log.info("budget alert sent to %s", ", ".join(admins))
    except Exception:
        log.exception("failed to send budget alert")
