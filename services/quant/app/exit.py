"""Adaptive exit management for open paper positions.

`rank.py` answers "which option to buy". This module answers the question
nothing in this project answered before it existed: once you're in one, when
do you get out, and does that answer change as the picture changes?

Two functions, deliberately split by when each runs:

* `compute_initial_exit_target` runs once, at entry — a first-pass profit
  target, stop-loss, and target exit date. Explicitly a starting rule, not a
  backtested one, same honesty this project already applies to the radar's
  unweighted composite score and to the vol-forecast's trailing-RV floor:
  flagged as tunable, not claimed as validated.

* `evaluate_exit` runs every time the intraday recheck job fires (see
  `apps/server/src/lib/options/exitEngine.ts`), and is deliberately cheap:
  pure arithmetic on a live price, greeks-adjacent DTE floor, and whatever
  EV/news signal the *once-daily* position-health check already computed.
  It does **not** re-run the feature panel or the model — `_forecast_inputs`
  in `rank.py` reads the entire bars/features panel from disk, and doing
  that on every intraday tick across every open position would be exactly
  the kind of unpaced cost this project has already been burned by once
  (see `polygon.ts`'s own module comment on the vendor rate-limit incident).
  A hard rule resolves the large majority of rechecks without needing the
  model at all; only a genuinely ambiguous case — an EV sign flip or new
  news since the last check — escalates to `needs_review`, which is the one
  outcome the caller should spend an LLM call on.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal

# First-pass constants. Explicitly not backtested — see module docstring.
# Profit target and stop-loss are a fraction of premium paid; the DTE floor
# forces an exit before an option's decay curve gets too steep to trust a
# static target.
DEFAULT_PROFIT_TARGET_PCT = 0.50
DEFAULT_STOP_LOSS_PCT = 0.50
MIN_DTE_FLOOR = 3


@dataclass(frozen=True)
class ExitTarget:
    target_exit_price: float
    stop_loss_price: float
    target_exit_date: str
    reason: str


def compute_initial_exit_target(
    entry_price: float,
    expiry: str,
    entry_day: str,
    forecast_horizon_days: int,
    profit_target_pct: float = DEFAULT_PROFIT_TARGET_PCT,
    stop_loss_pct: float = DEFAULT_STOP_LOSS_PCT,
    min_dte_floor: int = MIN_DTE_FLOOR,
) -> ExitTarget:
    """A first-pass exit plan computed at entry time.

    `target_exit_date` comes from the model's own forecast horizon — the
    number of days its prediction is actually about — capped so it never
    lands inside `min_dte_floor` days of expiry, rather than a horizon that
    could run right up against (or past) the contract's own last trading
    day. If the horizon alone would already violate that floor (a
    short-dated contract bought against a longer-horizon forecast), the
    floor wins: there is no honest target date to suggest past a contract's
    own useful life.
    """
    if entry_price <= 0:
        raise ValueError(f"entry_price must be positive, got {entry_price}")

    entry_date = date.fromisoformat(entry_day)
    expiry_date = date.fromisoformat(expiry)
    latest_sensible_day = (expiry_date - entry_date).days - min_dte_floor
    horizon_days = max(1, min(forecast_horizon_days, latest_sensible_day))
    target_date = entry_date + timedelta(days=horizon_days)

    return ExitTarget(
        target_exit_price=entry_price * (1.0 + profit_target_pct),
        stop_loss_price=entry_price * (1.0 - stop_loss_pct),
        target_exit_date=target_date.isoformat(),
        reason=(
            f"First-pass rule: {profit_target_pct:.0%} profit target, "
            f"{stop_loss_pct:.0%} stop-loss, target date from the model's own "
            f"{forecast_horizon_days}-day forecast horizon (capped to stay "
            f"{min_dte_floor}+ day(s) clear of expiry). Not backtested — a "
            f"tunable starting point, not a validated rule."
        ),
    )


ExitAction = Literal["hold", "exit_now", "needs_review"]
ExitTrigger = Literal[
    "profit_target", "stop_loss", "dte_floor", "ev_sign_flip", "new_news", "unchanged"
]


@dataclass(frozen=True)
class ExitDecision:
    action: ExitAction
    new_target_exit_price: float | None
    new_target_exit_date: str | None
    reason: str
    triggered_by: ExitTrigger


def evaluate_exit(
    current_price: float,
    dte: int,
    target: ExitTarget,
    entry_ev: float | None = None,
    current_ev: float | None = None,
    new_documents_count: int = 0,
    min_dte_floor: int = MIN_DTE_FLOOR,
) -> ExitDecision:
    """Recheck logic for an open position, run every time the intraday job
    fires. Deterministic rules first — checked in order of how urgent they
    are to act on — then a `needs_review` escalation for genuinely
    ambiguous cases. See the module docstring for why this never touches
    the model directly.
    """
    if current_price >= target.target_exit_price:
        return ExitDecision(
            action="exit_now",
            new_target_exit_price=None,
            new_target_exit_date=None,
            reason=(
                f"Live price {current_price:.2f} reached the "
                f"{target.target_exit_price:.2f} profit target."
            ),
            triggered_by="profit_target",
        )
    if current_price <= target.stop_loss_price:
        return ExitDecision(
            action="exit_now",
            new_target_exit_price=None,
            new_target_exit_date=None,
            reason=(
                f"Live price {current_price:.2f} hit the "
                f"{target.stop_loss_price:.2f} stop-loss."
            ),
            triggered_by="stop_loss",
        )
    if dte <= min_dte_floor:
        return ExitDecision(
            action="exit_now",
            new_target_exit_price=None,
            new_target_exit_date=None,
            reason=f"Only {dte} day(s) to expiry, inside the {min_dte_floor}-day floor.",
            triggered_by="dte_floor",
        )

    ev_flipped = (
        entry_ev is not None and current_ev is not None and (entry_ev >= 0) != (current_ev >= 0)
    )
    if ev_flipped:
        return ExitDecision(
            action="needs_review",
            new_target_exit_price=None,
            new_target_exit_date=None,
            reason=(
                f"Expected value flipped sign since entry "
                f"({entry_ev:.2f} → {current_ev:.2f})."
            ),
            triggered_by="ev_sign_flip",
        )
    if new_documents_count > 0:
        return ExitDecision(
            action="needs_review",
            new_target_exit_price=None,
            new_target_exit_date=None,
            reason=(
                f"{new_documents_count} new document(s) on the underlying "
                f"since the last check."
            ),
            triggered_by="new_news",
        )

    return ExitDecision(
        action="hold",
        new_target_exit_price=target.target_exit_price,
        new_target_exit_date=target.target_exit_date,
        reason="No trigger condition met; target unchanged.",
        triggered_by="unchanged",
    )
