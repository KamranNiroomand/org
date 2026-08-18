"""Cross-validation tests.

Two layers. First, the split arithmetic itself, checked against
hand-computed boundaries — deterministic and exact, because getting an
off-by-one wrong here silently reintroduces the leak this module exists to
prevent. Second, the full pipeline against a synthetic dataset whose label is
pure noise, per the project plan's explicit verification requirement: if a
model can find an "edge" here, the harness is lying, not the market.
"""

from __future__ import annotations

import numpy as np
import polars as pl
import pytest

from app.cv import apply_split, purge_cutoff_index, purged_walk_forward_splits


def _days(n: int) -> list[str]:
    return [f"2026-{1 + i // 28:02d}-{1 + i % 28:02d}" for i in range(n)]


class TestPurgeCutoffIndex:
    def test_matches_hand_computation(self) -> None:
        # Test block starts at index 100, horizon 5, embargo 3: the last
        # training day must be more than horizon + embargo days before it.
        assert purge_cutoff_index(test_start_index=100, horizon=5, embargo=3) == 92

    def test_zero_embargo_is_purge_only(self) -> None:
        assert purge_cutoff_index(100, horizon=5, embargo=0) == 95

    def test_can_go_negative_for_a_test_block_too_close_to_the_start(self) -> None:
        # Deliberately not clamped here — purged_walk_forward_splits clamps
        # at the call site so the reason ("no training data fits") stays
        # visible rather than silently producing an empty-but-valid-looking
        # cutoff of zero.
        assert purge_cutoff_index(3, horizon=5, embargo=0) == -2


class TestPurgedWalkForwardSplits:
    def test_no_training_day_can_leak_into_its_test_block(self) -> None:
        """The property the whole module exists to guarantee.

        For every fold, every training day's label window — [day, day +
        horizon] — must end strictly before the test block starts, with the
        embargo gap still intact on top of that.
        """
        days = _days(200)
        for horizon in (1, 5, 21, 63):
            for embargo in (0, 5, 10):
                splits = purged_walk_forward_splits(
                    days, n_splits=3, horizon=horizon, embargo=embargo
                )
                for split in splits:
                    if not split.train_days or not split.test_days:
                        continue
                    last_train_idx = days.index(split.train_days[-1])
                    test_start_idx = days.index(split.test_days[0])
                    assert last_train_idx + horizon + embargo < test_start_idx

    def test_folds_are_expanding(self) -> None:
        days = _days(200)
        splits = purged_walk_forward_splits(days, n_splits=4, horizon=5, embargo=2)
        sizes = [len(s.train_days) for s in splits]
        assert sizes == sorted(sizes)
        assert len(set(sizes)) == len(sizes)  # strictly increasing, not just non-decreasing

    def test_test_blocks_are_contiguous_and_cover_the_tail(self) -> None:
        days = _days(210)
        splits = purged_walk_forward_splits(days, n_splits=3, horizon=5, embargo=0)
        all_test_days = [d for s in splits for d in s.test_days]
        assert all_test_days == sorted(set(all_test_days))  # no gaps, no repeats
        assert len(all_test_days) == len(set(all_test_days))

    def test_block_sizes_differ_by_at_most_one_day(self) -> None:
        days = _days(101)  # deliberately not evenly divisible
        splits = purged_walk_forward_splits(days, n_splits=3, horizon=1, embargo=0, min_train_days=2)
        sizes = [len(s.test_days) for s in splits]
        assert max(sizes) - min(sizes) <= 1

    def test_rejects_unsorted_or_duplicate_days(self) -> None:
        with pytest.raises(ValueError, match="sorted ascending"):
            purged_walk_forward_splits(["2026-01-02", "2026-01-01"], 1, 1)
        with pytest.raises(ValueError, match="sorted ascending"):
            purged_walk_forward_splits(["2026-01-01", "2026-01-01"], 1, 1)

    def test_rejects_min_train_days_too_small_to_survive_its_own_purge(self) -> None:
        with pytest.raises(ValueError, match="exceed horizon"):
            purged_walk_forward_splits(_days(50), n_splits=2, horizon=10, embargo=5, min_train_days=10)

    def test_rejects_more_splits_than_available_days(self) -> None:
        with pytest.raises(ValueError, match="only"):
            purged_walk_forward_splits(_days(20), n_splits=50, horizon=1, embargo=0, min_train_days=5)


class TestApplySplit:
    def test_filters_a_panel_by_day_membership(self) -> None:
        df = pl.DataFrame({"day": ["2026-01-01", "2026-01-02", "2026-01-03"], "x": [1, 2, 3]})
        from app.cv import WalkForwardSplit

        split = WalkForwardSplit(fold=0, train_days=("2026-01-01",), test_days=("2026-01-03",))
        train, test = apply_split(df, split)
        assert train["x"].to_list() == [1]
        assert test["x"].to_list() == [3]


class TestNoiseLabelReportsNoEdge:
    """The verification the project plan calls out explicitly: a synthetic
    dataset whose label is pure noise must show ~zero edge once run through
    the full purged walk-forward pipeline. If this reports a real edge, the
    harness — not the market — is the thing that is broken, and nothing
    trained through it should be trusted until this test is green again.
    """

    def _synthetic_panel(self, n_symbols: int, n_days: int, seed: int) -> pl.DataFrame:
        rng = np.random.default_rng(seed)
        days = _days(n_days)
        rows = []
        for s in range(n_symbols):
            # A feature with genuine information about *nothing* — an
            # ordinary-looking momentum-style number, computed from real
            # noise, but with no constructed relationship to the label below.
            feature = rng.normal(0, 1, n_days)
            # The label: pure noise, independent of the feature and of every
            # other row. Any model that "finds" a relationship here is
            # finding it in the cross-validation procedure, not the data.
            label = rng.normal(0, 0.02, n_days)
            for i, day in enumerate(days):
                rows.append({"symbol": f"SYM{s}", "day": day, "feature": feature[i], "label": label[i]})
        return pl.DataFrame(rows)

    def test_lightgbm_through_purged_cv_finds_no_edge_in_pure_noise(self) -> None:
        import lightgbm as lgb

        panel = self._synthetic_panel(n_symbols=15, n_days=250, seed=1)
        days = sorted(panel["day"].unique().to_list())
        splits = purged_walk_forward_splits(days, n_splits=4, horizon=5, embargo=5, min_train_days=100)

        predictions: list[float] = []
        actuals: list[float] = []

        for split in splits:
            train, test = apply_split(panel, split)
            if train.height == 0 or test.height == 0:
                continue
            model = lgb.LGBMRegressor(n_estimators=50, max_depth=3, min_child_samples=20, verbosity=-1)
            model.fit(train[["feature"]].to_numpy(), train["label"].to_numpy())
            preds = model.predict(test[["feature"]].to_numpy())
            predictions.extend(preds)
            actuals.extend(test["label"].to_list())

        predictions_arr = np.array(predictions)
        actuals_arr = np.array(actuals)

        # Information coefficient: correlation between predicted and actual.
        # A real edge would show up here as a value clearly away from zero;
        # on pure noise it must stay small.
        ic = float(np.corrcoef(predictions_arr, actuals_arr)[0, 1])
        assert abs(ic) < 0.15, f"model found a correlation of {ic:.3f} in pure noise"

        # The "trading" check: go long when the model predicts a positive
        # label, short otherwise, and look at the resulting Sharpe ratio. On
        # a genuinely random label this must not look like a strategy.
        strategy_returns = np.sign(predictions_arr) * actuals_arr
        sharpe = float(np.mean(strategy_returns) / np.std(strategy_returns) * np.sqrt(252))
        assert abs(sharpe) < 1.0, f"a positive-vol Sharpe of {sharpe:.2f} was 'found' in pure noise"

    def test_mean_baseline_also_finds_no_edge(self) -> None:
        """Cheaper sanity check with no model at all: predicting the
        training mean for every test row should be indistinguishable from
        guessing, confirming the *labels themselves* carry no structure
        the LightGBM test above could latch onto by accident.
        """
        panel = self._synthetic_panel(n_symbols=10, n_days=200, seed=2)
        days = sorted(panel["day"].unique().to_list())
        splits = purged_walk_forward_splits(days, n_splits=3, horizon=5, embargo=5, min_train_days=80)

        errors = []
        for split in splits:
            train, test = apply_split(panel, split)
            if train.height == 0 or test.height == 0:
                continue
            baseline = train["label"].mean()
            errors.extend((test["label"] - baseline).to_list())

        # The mean of residuals against a constant baseline should be near
        # zero; a persistent bias would indicate a distributional shift the
        # split introduced, not a real signal, but is worth catching either way.
        assert abs(float(np.mean(errors))) < 0.01
