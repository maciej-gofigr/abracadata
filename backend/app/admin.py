"""Grant/revoke admin on an account, from the command line.

Admin is deliberately not settable through the API — it's granted out of band:

    docker compose exec backend python -m app.admin list
    docker compose exec backend python -m app.admin grant you@example.com
    docker compose exec backend python -m app.admin revoke you@example.com

The account must already exist (i.e. it has signed in at least once).
"""

from __future__ import annotations

import sys

from sqlalchemy import select

from app.db import SessionLocal
from app.models import User


def _set_admin(email: str, value: bool) -> int:
    email = email.strip().lower()
    with SessionLocal() as db:
        user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
        if user is None:
            print(f"No account for {email!r}. They must sign in once first.", file=sys.stderr)
            return 1
        user.is_admin = value
        db.commit()
        print(f"{email}: is_admin={value}")
        return 0


def _list() -> int:
    with SessionLocal() as db:
        users = db.execute(select(User).order_by(User.created_at)).scalars().all()
        if not users:
            print("(no accounts yet)")
            return 0
        for u in users:
            print(f"{'ADMIN' if u.is_admin else '     '}  {u.email}  (joined {u.created_at:%Y-%m-%d})")
        return 0


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in {"grant", "revoke", "list"}:
        print(__doc__, file=sys.stderr)
        return 2
    if argv[0] == "list":
        return _list()
    if len(argv) < 2:
        print(f"usage: python -m app.admin {argv[0]} <email>", file=sys.stderr)
        return 2
    return _set_admin(argv[1], argv[0] == "grant")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
