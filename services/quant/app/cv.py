"""Purged, embargoed walk-forward cross-validation.

The reason this file exists rather than calling `sklearn.model_selection.
KFold`: an h-day-ahead label is not independent of its neighbours. The label
stamped on day `t` reads returns through day `t + h`, and the label on day
`t + 1` reads returns through `t + 1 + h` — the two share `h - 1` days of the
same underlying return realizations. Plain k-fold shuffles rows randomly, so
a training row and a test row that are adjacent in time — and therefore
built from almost the same window — can land on opposite sides of a fold.
A model can then exploit that overlap rather than any genuine relationship
between features and outcomes, and the resulting cross-validated score is
optimistic in a way that will not survive contact with live data. This is
widely regarded as the single most common way a backtest fabricates an edge
(see Lopez de Prado, *Advances in Financial Machine Learning*, ch. 7).

Two mechanisms fix it, applied to every fold:

**Purge** — drop any training day whose label window could reach into the
test period. A day `d` is purged from training if `d + horizon` falls on or
after the test block's first day.

**Embargo** — drop a further stretch of days immediately before the test
block, beyond what purging alone removes. Even a training row whose label
window does *not* overlap the test period can have *features* — rolling
means, realized vol — built from a window that abuts it, and short-horizon
serial correlation in returns can leak information across that boundary too.

Folds are **expanding**: training always uses every day strictly before the
purge/embargo cutoff, growing as later folds move forward, which is the
correct scheme for finance where "train only on the past" is the actual
constraint being validated, not merely a convention.
"""

from __future__ import annotations

from dataclasses import dataclass

import polars as pl


@dataclass(frozen=True)
class WalkForwardSplit:
    fold: int
    train_days: tuple[str, ...]
    test_days: tuple[str, ...]


def purge_cutoff_index(test_start_index: int, horizon: int, embargo: int) -> int:
    """The last valid training-day index (exclusive) for a test block starting
    at `test_start_index`, given a label horizon and an embargo.

    Isolated as its own function because it is the one line of arithmetic this
    whole module exists to get right, and it is worth being able to test it
    directly against hand-computed boundaries rather than only indirectly
    through a full split.
    """
    return test_start_index - horizon - embargo


def purged_walk_forward_splits(
    days: list[str],
    n_splits: int,
    horizon: int,
    embargo: int = 0,
    min_train_days: int | None = None,
) -> list[WalkForwardSplit]:
    """Builds `n_splits` expanding, purged, embargoed folds over `days`.

    `days` must be sorted ascending and unique — every caller in this codebase
    derives it from a `SELECT DISTINCT day ... ORDER BY day` over the panel,
    so this is asserted rather than silently sorted, to catch a caller that
    passed something else by mistake.

    `min_train_days` gates how much history the *first* fold requires before
    the purge/embargo cutoff. Defaulting it to `2 * (horizon + embargo)` is a
    minimum, not a recommendation — a model trained on barely more than the
    purge window itself has nothing to learn from; it exists so the function
    fails on too little data rather than silently producing a degenerate
    first fold.
    """
    if n_splits < 1:
        raise ValueError(f"n_splits must be at least 1, got {n_splits}")
    if horizon < 1:
        raise ValueError(f"horizon must be at least 1, got {horizon}")
    if embargo < 0:
        raise ValueError(f"embargo must not be negative, got {embargo}")
    if days != sorted(set(days)):
        raise ValueError("days must be sorted ascending and unique")

    min_train = min_train_days if min_train_days is not None else 2 * (horizon + embargo)
    if min_train <= horizon + embargo:
        raise ValueError(
            f"min_train_days ({min_train}) must exceed horizon + embargo "
            f"({horizon + embargo}) or the first fold has no usable training data"
        )

    available = len(days) - min_train
    if available < n_splits:
        raise ValueError(
            f"only {available} day(s) available for test blocks after the "
            f"{min_train}-day training minimum, but {n_splits} splits were requested"
        )

    # Roughly equal contiguous test blocks over the days remaining after burn-in.
    block_size = available // n_splits
    remainder = available - block_size * n_splits

    splits: list[WalkForwardSplit] = []
    cursor = min_train
    for fold in range(n_splits):
        # Earlier folds absorb the remainder so blocks differ by at most one
        # day rather than leaving a short final fold.
        size = block_size + (1 if fold < remainder else 0)
        test_start = cursor
        test_end = test_start + size
        cutoff = purge_cutoff_index(test_start, horizon, embargo)

        splits.append(
            WalkForwardSplit(
                fold=fold,
                train_days=tuple(days[: max(0, cutoff)]),
                test_days=tuple(days[test_start:test_end]),
            )
        )
        cursor = test_end

    return splits


def apply_split(
    df: pl.DataFrame, split: WalkForwardSplit, day_col: str = "day"
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Filters a panel DataFrame into the train and test rows for one fold."""
    train = df.filter(pl.col(day_col).is_in(split.train_days))
    test = df.filter(pl.col(day_col).is_in(split.test_days))
    return train, test
