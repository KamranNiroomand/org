"""Model training tests.

Two contrasting cases, matching the two the plan asks for: a synthetic
dataset with a genuine, strong signal, where the real model must beat the
baseline decisively — and, reusing the harness from `test_cv.py`, a
confirmation that this module's `beats_baseline` correctly reports "no" when
there is nothing to find. Also run once against the real backfilled SPY
history, so this is validated on the actual corpus and not only on synthetic
constructions.
"""

from __future__ import annotations

import numpy as np
import polars as pl
import pytest

from app.cv import apply_split, purged_walk_forward_splits
from app.models import beats_baseline, mean_baseline, train_lgbm_regressor


def _days(n: int) -> list[str]:
    return [f"2026-{1 + i // 28:02d}-{1 + i % 28:02d}" for i in range(n)]


def _signal_panel(n_symbols: int, n_days: int, seed: int) -> pl.DataFrame:
    """A label that is a genuine, noisy-but-real function of the feature —
    the contrasting case to the pure-noise panel in `test_cv.py`.
    """
    rng = np.random.default_rng(seed)
    days = _days(n_days)
    rows = []
    for s in range(n_symbols):
        feature = rng.normal(0, 1, n_days)
        # A real, strong linear relationship plus modest noise — enough
        # structure that a tree model with a few hundred rows should find it
        # comfortably, without making the test a coin flip on sample size.
        label = 0.02 * feature + rng.normal(0, 0.003, n_days)
        for i, day in enumerate(days):
            rows.append({"symbol": f"SYM{s}", "day": day, "feature": feature[i], "label": label[i]})
    return pl.DataFrame(rows)


class TestBeatsBaselineOnASignal:
    def test_the_model_beats_the_mean_baseline_when_a_real_relationship_exists(self) -> None:
        panel = _signal_panel(n_symbols=20, n_days=250, seed=11)
        days = sorted(panel["day"].unique().to_list())
        splits = purged_walk_forward_splits(days, n_splits=4, horizon=1, embargo=1, min_train_days=100)

        model_result = train_lgbm_regressor(panel, ["feature"], "label", splits)
        baseline_result = mean_baseline(panel, "label", splits)

        assert beats_baseline(model_result, baseline_result)

        from app.metrics import information_coefficient

        ic = information_coefficient(model_result.actual, model_result.predicted)
        # A real, strong relationship should show up as a clear positive IC —
        # not the near-zero the noise-label test in test_cv.py requires.
        assert ic > 0.3

    def test_out_of_fold_predictions_cover_every_test_row_exactly_once(self) -> None:
        panel = _signal_panel(n_symbols=5, n_days=150, seed=12)
        days = sorted(panel["day"].unique().to_list())
        splits = purged_walk_forward_splits(days, n_splits=3, horizon=1, embargo=1, min_train_days=60)

        result = train_lgbm_regressor(panel, ["feature"], "label", splits)

        # Every test day belongs to exactly one fold — walk-forward test
        # blocks are contiguous and non-overlapping by construction (see
        # test_cv.py), so the union of scored days must match the union of
        # each fold's own test days with no day counted twice.
        expected_days: list[str] = []
        for split in splits:
            _, test = apply_split(panel, split)
            expected_days.extend(test["day"].to_list())

        scored_days = [d for fold in result.folds for d in fold.days]
        assert sorted(scored_days) == sorted(expected_days)
        assert result.predicted.shape == result.actual.shape


class TestMeanBaseline:
    def test_predicts_the_training_mean_exactly(self) -> None:
        panel = pl.DataFrame(
            {
                "symbol": ["X"] * 10,
                "day": _days(10),
                "label": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0],
            }
        )
        splits = purged_walk_forward_splits(_days(10), n_splits=1, horizon=1, embargo=0, min_train_days=6)
        result = mean_baseline(panel, "label", splits)
        train, _ = apply_split(panel, splits[0])
        expected_mean = train["label"].mean()
        assert np.all(result.predicted == pytest.approx(expected_mean))


class TestNoEdgeOnPureNoise:
    """The counterpart to test_cv.py's leakage test, phrased through this
    module's own API: a model trained on pure noise must not claim to beat
    the baseline.
    """

    def test_model_does_not_reliably_beat_baseline_on_pure_noise(self) -> None:
        rng = np.random.default_rng(99)
        n_days = 250
        days = _days(n_days)
        rows = []
        for s in range(15):
            feature = rng.normal(0, 1, n_days)
            label = rng.normal(0, 0.02, n_days)  # independent of feature
            for i, day in enumerate(days):
                rows.append({"symbol": f"SYM{s}", "day": day, "feature": feature[i], "label": label[i]})
        panel = pl.DataFrame(rows)

        splits = purged_walk_forward_splits(days, n_splits=4, horizon=5, embargo=5, min_train_days=100)
        model_result = train_lgbm_regressor(panel, ["feature"], "label", splits)
        baseline_result = mean_baseline(panel, "label", splits)

        from app.metrics import rmse

        model_rmse = rmse(model_result.actual, model_result.predicted)
        baseline_rmse = rmse(baseline_result.actual, baseline_result.predicted)
        # Not asserting the model never edges out the baseline by chance —
        # with enough noise a tiny RMSE improvement is possible — but it must
        # not do so by a margin that would look like a real result.
        assert model_rmse > baseline_rmse * 0.97


class TestAgainstRealBackfilledData:
    def test_trains_without_error_on_the_real_spy_history(self) -> None:
        from app.db import read_bars
        from app.features import underlying_features
        from app.labels import forward_return

        bars = read_bars(symbols=["SPY", "AAPL", "NVDA", "BRK.B"])
        if bars.height == 0:
            pytest.skip("no bars in market.db yet — run bars:backfill first")

        features = underlying_features(bars)
        labels = forward_return(bars, horizon=5)
        panel = features.join(labels, on=["symbol", "day"], how="inner")
        if panel.height < 50:
            pytest.skip("not enough overlapping feature/label rows yet")

        days = sorted(panel["day"].unique().to_list())
        feature_cols = [c for c in features.columns if c not in ("symbol", "day")]
        splits = purged_walk_forward_splits(
            days, n_splits=2, horizon=5, embargo=2, min_train_days=max(40, len(days) // 3)
        )

        model_result = train_lgbm_regressor(panel, feature_cols, "fwd_ret_5d", splits)
        baseline_result = mean_baseline(panel, "fwd_ret_5d", splits)

        # No claim about whether the model beats the baseline on four names
        # and roughly a year of history — that would be a real empirical
        # question this test is not powered to answer. Only that the full
        # pipeline runs end to end on the actual corpus and produces finite,
        # sane numbers.
        assert model_result.predicted.shape == model_result.actual.shape
        assert np.all(np.isfinite(model_result.predicted))
        assert np.all(np.isfinite(baseline_result.predicted))
