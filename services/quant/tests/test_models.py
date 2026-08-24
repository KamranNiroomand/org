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
from app.models import inner_validation_split, beats_baseline, mean_baseline, train_lgbm_regressor


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


class TestLossHistory:
    """Per-round train/validation RMSE — the one diagnostic the out-of-fold
    summary metrics cannot provide."""

    def _panel(self, n_days: int = 40, n_symbols: int = 25, seed: int = 0) -> pl.DataFrame:
        rng = np.random.default_rng(seed)
        days = [f"2026-01-{d:02d}" for d in range(1, n_days + 1)]
        return pl.DataFrame(
            [
                {
                    "day": d,
                    "symbol": f"S{i}",
                    "f1": float(rng.normal()),
                    "f2": float(rng.normal()),
                    "label": float(rng.normal() * 0.01),
                }
                for d in days
                for i in range(n_symbols)
            ]
        )

    def _splits(self, panel: pl.DataFrame):
        days = sorted(panel["day"].unique().to_list())
        return purged_walk_forward_splits(days, 2, 2, 1, 10)

    def test_off_by_default_so_callers_that_only_want_predictions_pay_nothing(self) -> None:
        panel = self._panel()
        result = train_lgbm_regressor(panel, ["f1", "f2"], "label", self._splits(panel))
        assert result.history == {}
        assert len(result.folds) > 0  # predictions still produced

    def test_records_both_curves_for_every_fold_when_asked(self) -> None:
        panel = self._panel()
        splits = self._splits(panel)
        result = train_lgbm_regressor(panel, ["f1", "f2"], "label", splits, record_history=True)

        assert set(result.history) == {f.fold for f in result.folds}
        for curves in result.history.values():
            assert curves["train"] and curves["validation"]
            assert len(curves["train"]) == len(curves["validation"])

    def test_recording_does_not_change_the_predictions(self) -> None:
        # The curve is an observation of the fit, not a change to it. If
        # turning it on moved the model, every metric reported beside it
        # would describe a different model than the one that shipped.
        panel = self._panel()
        splits = self._splits(panel)
        without = train_lgbm_regressor(panel, ["f1", "f2"], "label", splits)
        with_history = train_lgbm_regressor(panel, ["f1", "f2"], "label", splits, record_history=True)

        assert np.allclose(without.predicted, with_history.predicted)

    def test_the_curve_can_show_overfitting(self) -> None:
        # On pure noise there is nothing to learn, so validation RMSE must
        # stop improving while training RMSE keeps falling. If the plumbing
        # were wrong — both curves scored on the same rows, say — this
        # would not hold, and the chart would quietly never show overfit.
        panel = self._panel(seed=7)
        splits = self._splits(panel)
        result = train_lgbm_regressor(panel, ["f1", "f2"], "label", splits, record_history=True)

        curves = result.history[min(result.history)]
        train, validation = curves["train"], curves["validation"]
        assert train[-1] < train[0]  # training error always falls on noise
        assert validation.index(min(validation)) < len(validation) - 1  # best round is not the last


class TestInnerValidationSplit:
    """The purge is the whole reason this function exists rather than a
    one-line slice — see its docstring."""

    def test_leaves_a_gap_covering_the_label_horizon_and_embargo(self) -> None:
        # Labels run `horizon` days forward, so without the gap the tail of
        # inner-train carries labels realized inside inner-validation and
        # early stopping would select against data it had already seen.
        days = tuple(f"2026-01-{d:02d}" for d in range(1, 31))

        train, val = inner_validation_split(days, horizon=5, embargo=2, inner_frac=0.2)

        assert len(train) + len(val) < len(days)  # something was purged
        gap = len(days) - len(train) - len(val)
        assert gap == 5 + 2
        # And the two blocks are disjoint and ordered.
        assert train[-1] < val[0]

    def test_the_validation_tail_is_the_most_recent_days(self) -> None:
        # Not a random sample: a walk-forward model is judged on what comes
        # after, so the inner split has to imitate that shape.
        days = tuple(f"2026-01-{d:02d}" for d in range(1, 31))

        _, val = inner_validation_split(days, horizon=0, embargo=0, inner_frac=0.2)

        assert val == days[-len(val) :]

    def test_refuses_rather_than_returning_a_degenerate_split(self) -> None:
        # Too short to give up a validation tail *and* a purge gap and
        # still leave anything to learn from. The caller then trains
        # without early stopping rather than on nonsense.
        assert inner_validation_split(tuple(f"d{i}" for i in range(8)), 5, 2, 0.2) is None
        assert inner_validation_split((), 5, 2, 0.2) is None

    def test_an_impossible_fraction_is_refused(self) -> None:
        days = tuple(f"d{i}" for i in range(40))
        for bad in (0.0, 1.0, -0.1, 1.5):
            with pytest.raises(ValueError, match="inner_frac"):
                inner_validation_split(days, 5, 2, bad)


class TestEarlyStopping:
    def test_is_off_unless_asked_for(self) -> None:
        # Measured and it does not help — see train_lgbm_regressor's
        # docstring. The machinery stays, defaulted off.
        panel = TestLossHistory()._panel()
        splits = TestLossHistory()._splits(panel)

        result = train_lgbm_regressor(panel, ["f1", "f2"], "label", splits)

        assert result.best_rounds == {}

    def test_records_the_round_count_it_chose_per_fold(self) -> None:
        panel = TestLossHistory()._panel()
        splits = TestLossHistory()._splits(panel)

        result = train_lgbm_regressor(
            panel, ["f1", "f2"], "label", splits,
            early_stopping_rounds=5, horizon=2, embargo=1,
        )

        # A fold whose training block was too short to purge an inner tail
        # out of simply has no entry — a real state, not an error.
        for fold, rounds in result.best_rounds.items():
            assert rounds > 0
            assert fold in {f.fold for f in result.folds}

    def test_still_produces_predictions_for_every_fold(self) -> None:
        # Whatever round count it lands on, the fold must still score its
        # test block — an early-stopping bug that silently dropped folds
        # would shrink the out-of-fold sample without saying so.
        panel = TestLossHistory()._panel()
        splits = TestLossHistory()._splits(panel)

        without = train_lgbm_regressor(panel, ["f1", "f2"], "label", splits)
        with_es = train_lgbm_regressor(
            panel, ["f1", "f2"], "label", splits,
            early_stopping_rounds=5, horizon=2, embargo=1,
        )

        assert len(with_es.folds) == len(without.folds)
        assert len(with_es.predicted) == len(without.predicted)
