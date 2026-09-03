"""Admin-only controls.

Deliberately small: the switches here exist to stop money burning during an
abuse or traffic spike, so they must be simple and instant.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import boto3
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import flags
from app.db import get_db
from app.models import LoginAttempt, Recipe, Setting, User
from app.owner import Principal, get_principal

router = APIRouter(prefix="/admin", tags=["admin"])
log = logging.getLogger("app.admin")


def require_admin(principal: Principal = Depends(get_principal)) -> Principal:
    """Gate for every route here.

    404 rather than 403 for non-admins: this surface shouldn't confirm it exists
    to someone who isn't allowed to use it.
    """
    if principal.user is None or not principal.user.is_admin:
        raise HTTPException(status_code=404, detail="Not found")
    return principal


class FlagsResponse(BaseModel):
    llm_enabled: bool
    updated_at: str | None = None
    updated_by: str | None = None


class StatsResponse(BaseModel):
    users: int
    recipes: int
    codes_last_hour: int


class SetLlmBody(BaseModel):
    enabled: bool


class CostResponse(BaseModel):
    month: str
    total: float
    currency: str
    by_service: list[dict]
    cached_at: str
    error: str | None = None


# Cost Explorer bills roughly $0.01 per request. An hour is a good balance: the
# figures only move a few times a day, and admin traffic is a handful of loads,
# so this is cents per month. /admin/costs?refresh=true bypasses it.
_COST_TTL = timedelta(hours=1)
_cost_cache: dict[str, Any] = {"at": None, "data": None}


def _fetch_costs() -> CostResponse:
    """Month-to-date spend by service, from Cost Explorer (us-east-1 only)."""
    today = datetime.now(timezone.utc).date()
    start = today.replace(day=1)
    # CE's End is exclusive and must be > Start, so always ask for at least a day.
    end = max(today + timedelta(days=1), start + timedelta(days=1))

    client = boto3.client("ce", region_name="us-east-1")
    resp = client.get_cost_and_usage(
        TimePeriod={"Start": start.isoformat(), "End": end.isoformat()},
        Granularity="MONTHLY",
        Metrics=["UnblendedCost"],
        GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
    )

    services: list[dict] = []
    total = 0.0
    currency = "USD"
    for period in resp.get("ResultsByTime", []):
        for group in period.get("Groups", []):
            amount = float(group["Metrics"]["UnblendedCost"]["Amount"])
            currency = group["Metrics"]["UnblendedCost"].get("Unit", currency)
            if amount <= 0:
                continue  # skip the long tail of $0.00 services
            services.append({"service": group["Keys"][0], "amount": round(amount, 2)})
            total += amount
    services.sort(key=lambda x: x["amount"], reverse=True)
    return CostResponse(
        month=start.strftime("%B %Y"),
        total=round(total, 2),
        currency=currency,
        by_service=services,
        cached_at=datetime.now(timezone.utc).isoformat(),
    )


@router.get("/costs", response_model=CostResponse)
def costs(_: Principal = Depends(require_admin), refresh: bool = False) -> CostResponse:
    now = datetime.now(timezone.utc)
    cached = _cost_cache.get("data")
    if cached and not refresh and _cost_cache["at"] and now - _cost_cache["at"] < _COST_TTL:
        return cached
    try:
        data = _fetch_costs()
    except Exception as exc:  # no credentials locally, permission missing, CE off
        log.warning("cost lookup failed: %s", exc)
        return CostResponse(
            month=now.strftime("%B %Y"), total=0.0, currency="USD", by_service=[],
            cached_at=now.isoformat(),
            # Name the permission, not a specific identity: in prod that's the EC2
            # instance role, but locally it's whatever boto3's credential chain
            # resolves to (backend/.env's IAM key, or the SSO profile).
            error=(
                "Couldn't read AWS costs. The credentials this server is using need "
                "ce:GetCostAndUsage — in production that's the EC2 instance role; "
                "locally it's the key in backend/.env or your SSO profile."
            ),
        )
    _cost_cache["at"], _cost_cache["data"] = now, data
    return data


@router.get("/flags", response_model=FlagsResponse)
def read_flags(_: Principal = Depends(require_admin), db: Session = Depends(get_db)) -> FlagsResponse:
    row = db.get(Setting, flags.LLM_ENABLED)
    return FlagsResponse(
        llm_enabled=flags.llm_enabled(db),
        updated_at=row.updated_at.isoformat() if row else None,
        updated_by=row.updated_by if row else None,
    )


@router.post("/flags/llm", response_model=FlagsResponse)
def set_llm(
    body: SetLlmBody,
    principal: Principal = Depends(require_admin),
    db: Session = Depends(get_db),
) -> FlagsResponse:
    flags.set_bool(db, flags.LLM_ENABLED, body.enabled, actor=principal.user.email if principal.user else None)
    return read_flags(principal, db)


@router.get("/stats", response_model=StatsResponse)
def stats(_: Principal = Depends(require_admin), db: Session = Depends(get_db)) -> StatsResponse:
    from datetime import datetime, timedelta, timezone

    hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    return StatsResponse(
        users=db.execute(select(func.count()).select_from(User)).scalar_one(),
        recipes=db.execute(select(func.count()).select_from(Recipe)).scalar_one(),
        codes_last_hour=db.execute(
            select(func.count()).select_from(LoginAttempt).where(LoginAttempt.created_at > hour_ago)
        ).scalar_one(),
    )
