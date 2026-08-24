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

#: How far below the running price the trailing stop sits once the profit
#: target has been reached. See `evaluate_exit` for why reaching the target
#: raises a stop rather than closing the position.
DEFAULT_TRAIL_PCT = 0.30


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

    Raises `ValueError` when the contract's entire remaining life is at or
    inside `min_dte_floor` — a contract with 2 days to expiry and a 3-day
    floor has no day left that both exists and clears the floor, and an
    earlier version of this function silently clamped `horizon_days` up to
    1 in that case, producing a target date *inside* the floor it was meant
    to guarantee. The caller (see `main.py`'s `from_ranked`) treats this the
    same as any other "no target computable" case: null suggested fields,
    not a fabricated one.
    """
    if entry_price <= 0:
        raise ValueError(f"entry_price must be positive, got {entry_price}")

    entry_date = date.fromisoformat(entry_day)
    expiry_date = date.fromisoformat(expiry)
    latest_sensible_day = (expiry_date - entry_date).days - min_dte_floor
    if latest_sensible_day < 1:
        raise ValueError(
            f"{expiry} is only {(expiry_date - entry_date).days} day(s) out from {entry_day} — "
            f"no target date exists that both exists and stays {min_dte_floor}+ day(s) clear of expiry."
        )
    # Safe now that latest_sensible_day >= 1 is guaranteed above: this only
    # clamps a non-positive forecast_horizon_days up to 1, never back into
    # the floor the guard above already ruled out.
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
    "trail_raised", "stop_loss", "dte_floor", "ev_sign_flip", "new_news", "unchanged"
]


@dataclass(frozen=True)
class ExitDecision:
    action: ExitAction
    new_target_exit_price: float | None
    new_target_exit_date: str | None
    #: A raised trailing stop, or None when the stop is unchanged. Only
    #: ever higher than the stop it replaces — see `evaluate_exit`.
    new_stop_loss_price: float | None
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
    trail_pct: float = DEFAULT_TRAIL_PCT,
) -> ExitDecision:
    """Recheck logic for an open position, run every time the intraday job
    fires. Deterministic rules first — checked in order of how urgent they
    are to act on — then a `needs_review` escalation for genuinely
    ambiguous cases. See the module docstring for why this never touches
    the model directly.

    **The profit target no longer closes the position.** v1 exited at a
    fixed +50%, which capped the one tail a long option is bought for
    while leaving the losing tail untouched. The target is now the level
    at which the stop starts trailing the price; see the comment on that
    branch. `new_stop_loss_price` carries the raised stop, and the caller
    must persist it — a ratchet that is not written down resets on every
    pass and the position never actually trails anything.
    """
    # The stop is checked first, and it is the *current* stop — which may
    # have been ratcheted upward by an earlier pass (see below). A trailing
    # stop being hit and an original stop being hit are the same event:
    # price fell to the floor the position was willing to give back.
    if current_price <= target.stop_loss_price:
        return ExitDecision(
            action="exit_now",
            new_target_exit_price=None,
            new_target_exit_date=None,
            new_stop_loss_price=None,
            reason=(
                f"Live price {current_price:.2f} hit the "
                f"{target.stop_loss_price:.2f} stop."
            ),
            triggered_by="stop_loss",
        )
    if dte <= min_dte_floor:
        return ExitDecision(
            action="exit_now",
            new_target_exit_price=None,
            new_target_exit_date=None,
            new_stop_loss_price=None,
            reason=f"Only {dte} day(s) to expiry, inside the {min_dte_floor}-day floor.",
            triggered_by="dte_floor",
        )

    # Reaching the profit target raises the stop; it does not close the
    # position. This is the one rule in this module that is a real
    # departure from v1 rather than a tunable constant, so the reasoning
    # is spelled out.
    #
    # A long option's payoff is convex: the loss is bounded at the premium
    # paid, while the gain is not bounded at all. That asymmetry is the
    # entire reason to own one rather than the underlying. Closing every
    # winner at a fixed +50% truncates exactly the right tail the position
    # exists to capture, while leaving the full left tail intact — the
    # losers still run to -50% or to zero. A rule that caps the upside and
    # not the downside inverts the payoff that was bought.
    #
    # So the target becomes an *activation* level. Above it, the stop
    # ratchets up to trail the running price and the position keeps
    # running until either the trail is hit or the DTE floor forces the
    # issue. The ratchet is monotone by construction — `max` against the
    # existing stop — because a stop that can move down is not a stop; it
    # is how a small loss becomes a large one.
    #
    # The ratchet is *computed* here but not returned yet. Returning early
    # would skip the review triggers below, and under the old rule that
    # cost nothing — the position was closed at the target, so there was
    # nothing left to review. Now it holds above the target indefinitely,
    # and an early return would mean a winning position could never
    # escalate again: a restatement or an EV collapse would ride the
    # trailing stop down with nobody looking. So the raised stop travels
    # with whatever decision the checks below reach.
    trailed_stop: float | None = None
    if current_price >= target.target_exit_price:
        trailed = current_price * (1.0 - trail_pct)
        if trailed > target.stop_loss_price:
            trailed_stop = trailed

    ev_flipped = (
        entry_ev is not None and current_ev is not None and (entry_ev >= 0) != (current_ev >= 0)
    )
    if ev_flipped:
        return ExitDecision(
            action="needs_review",
            new_target_exit_price=None,
            new_target_exit_date=None,
            new_stop_loss_price=trailed_stop,
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
            new_stop_loss_price=trailed_stop,
            reason=(
                f"{new_documents_count} new document(s) on the underlying "
                f"since the last check."
            ),
            triggered_by="new_news",
        )

    if trailed_stop is not None:
        return ExitDecision(
            action="hold",
            new_target_exit_price=target.target_exit_price,
            new_target_exit_date=target.target_exit_date,
            new_stop_loss_price=trailed_stop,
            reason=(
                f"Live price {current_price:.2f} is at or above the "
                f"{target.target_exit_price:.2f} target; letting it run with the stop "
                f"raised from {target.stop_loss_price:.2f} to {trailed_stop:.2f} "
                f"({trail_pct:.0%} below the running price)."
            ),
            triggered_by="trail_raised",
        )

    return ExitDecision(
        action="hold",
        new_target_exit_price=target.target_exit_price,
        new_target_exit_date=target.target_exit_date,
        new_stop_loss_price=None,
        reason="No trigger condition met; target unchanged.",
        triggered_by="unchanged",
    )
