"""Model training over purged walk-forward folds, and the baseline every
model has to beat before it earns any trust.

Two rules this module exists to enforce structurally rather than by
convention. Every prediction returned here is genuinely **out-of-fold** — a
model never sees the day it is scored on, only days from a `WalkForwardSplit`
whose training set has already been purged and embargoed against that test
period (see `cv.py`). And a trivial baseline runs through the identical fold
structure as the real model, on the identical data, so the comparison is
fair rather than an apples-to-a-different-orchard measurement taken at a
different time or on a different split.

If the real model cannot beat the baseline out-of-fold, that is a finding,
and callers are expected to say so rather than promote the model anyway —
see `metrics.deflated_sharpe_ratio` for why "the backtest looked good" is not
sufficient justification on its own.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import lightgbm as lgb
import numpy as np
import polars as pl

from .cv import WalkForwardSplit, apply_split


@dataclass
class FoldPrediction:
    fold: int
    days: list[str]
    actual: np.ndarray
    predicted: np.ndarray


@dataclass
class TrainingResult:
    target: str
    feature_cols: list[str]
    folds: list[FoldPrediction] = field(default_factory=list)
    #: Per-boosting-round RMSE for each fold, as
    #: `{fold: {"train": [...], "validation": [...]}}`. Empty until a caller
    #: asks for it — see `train_lgbm_regressor`'s `record_history`.
    #:
    #: The out-of-fold metrics elsewhere in this class say whether the model
    #: generalizes; this says *how it got there*, which is the one question
    #: they cannot answer. A model whose validation curve turns up while its
    #: training curve keeps falling is overfitting, and until this existed
    #: there was no way to see that at all — only a final number that had
    #: already absorbed it.
    history: dict[int, dict[str, list[float]]] = field(default_factory=dict)

    @property
    def actual(self) -> np.ndarray:
        return np.concatenate([f.actual for f in self.folds]) if self.folds else np.array([])

    @property
    def predicted(self) -> np.ndarray:
        return np.concatenate([f.predicted for f in self.folds]) if self.folds else np.array([])

    @property
    def days(self) -> np.ndarray:
        """The trading day each out-of-fold row belongs to.

        Needed to score the model the way it is actually used: a *daily
        cross-sectional* comparison of predictions against outcomes. Pooling
        every symbol-day into one correlation instead measures something
        else — see `metrics.daily_ic_series`.
        """
        return (
            np.concatenate([np.asarray(f.days, dtype=object) for f in self.folds])
            if self.folds
            else np.array([], dtype=object)
        )


# Deliberately small and shallow. This is a first model over a corpus that,
# as of this build, does not yet have a year of real captured chains behind
# it — a large, deep model has more capacity to memorize noise than the data
# can support, which is exactly the overfitting purged CV is built to expose
# rather than paper over with more trees.
DEFAULT_LGBM_PARAMS: dict[str, object] = {
    "n_estimators": 100,
    "max_depth": 4,
    "num_leaves": 15,
    "min_child_samples": 30,
    "learning_rate": 0.05,
    "verbosity": -1,
}


def mean_baseline(
    panel: pl.DataFrame,
    label_col: str,
    splits: list[WalkForwardSplit],
    day_col: str = "day",
) -> TrainingResult:
    """The floor: predict the training-fold mean for every test row.

    Any feature-driven model that cannot clear this has learned nothing a
    constant could not have told you, regardless of how sophisticated its
    cross-validated metrics otherwise look.
    """
    result = TrainingResult(target=label_col, feature_cols=[])
    for split in splits:
        train, test = apply_split(panel, split, day_col)
        if train.height == 0 or test.height == 0:
            continue
        prediction = float(train[label_col].mean())
        result.folds.append(
            FoldPrediction(
                fold=split.fold,
                days=test[day_col].to_list(),
                actual=test[label_col].to_numpy(),
                predicted=np.full(test.height, prediction),
            )
        )
    return result


def train_lgbm_regressor(
    panel: pl.DataFrame,
    feature_cols: list[str],
    label_col: str,
    splits: list[WalkForwardSplit],
    day_col: str = "day",
    params: dict[str, object] | None = None,
    record_history: bool = False,
) -> TrainingResult:
    """Trains one LightGBM regressor per fold and collects out-of-fold predictions.

    A fresh model per fold, not one model updated across folds — an expanding
    walk-forward already grows the training set fold over fold, so refitting
    from scratch each time is what "retrain weekly on an expanding window"
    (the project plan's retraining policy) actually means in miniature.

    `record_history` additionally captures per-round train and validation
    RMSE into `TrainingResult.history`. Off by default because it makes the
    fit evaluate both sets on every boosting round, which is real work for a
    caller that only wants predictions. `train.py` turns it on; the metric
    functions and every test that only needs out-of-fold predictions leave
    it off.

    The validation set is the fold's own **test** block, which is worth
    being explicit about: those rows are out-of-fold for the model, so the
    curve is an honest generalization curve and not a second training
    signal — nothing selects on it, no early stopping, no round count tuned
    against it. It is drawn, not optimized against. Using it to pick an
    iteration count would quietly turn the out-of-fold metrics reported
    beside it into in-sample ones.
    """
    result = TrainingResult(target=label_col, feature_cols=feature_cols)
    model_params = {**DEFAULT_LGBM_PARAMS, **(params or {})}

    for split in splits:
        train, test = apply_split(panel, split, day_col)
        if train.height == 0 or test.height == 0:
            continue
        model = lgb.LGBMRegressor(**model_params)
        if record_history:
            evals: dict[str, dict[str, list[float]]] = {}
            model.fit(
                train[feature_cols].to_numpy(),
                train[label_col].to_numpy(),
                # `eval_X`/`eval_y`, not the `eval_set` tuple list: LightGBM
                # 4.7 deprecated the latter and warns on every fit.
                # Tuples, not lists: LightGBM 4.7 treats a tuple as "several
                # eval sets" and a list as "one set", which is the difference
                # between two curves and a TypeError.
                eval_X=(train[feature_cols].to_numpy(), test[feature_cols].to_numpy()),
                eval_y=(train[label_col].to_numpy(), test[label_col].to_numpy()),
                eval_names=["train", "validation"],
                eval_metric="rmse",
                callbacks=[lgb.record_evaluation(evals)],
            )
            result.history[split.fold] = {
                name: [float(v) for v in metrics["rmse"]]
                for name, metrics in evals.items()
                if "rmse" in metrics
            }
        else:
            model.fit(train[feature_cols].to_numpy(), train[label_col].to_numpy())
        predicted = model.predict(test[feature_cols].to_numpy())
        result.folds.append(
            FoldPrediction(
                fold=split.fold,
                days=test[day_col].to_list(),
                actual=test[label_col].to_numpy(),
                predicted=np.asarray(predicted),
            )
        )
    return result


def beats_baseline(model_result: TrainingResult, baseline_result: TrainingResult) -> bool:
    """Whether the model's out-of-fold error is lower than the baseline's.

    Compares RMSE on the identical out-of-fold rows both were scored on —
    the two results must come from `WalkForwardSplit`s built from the same
    `days`, or this comparison is meaningless. Not enforced here by an
    assertion on the split objects themselves, since by the time both
    `TrainingResult`s exist the splits are gone; callers must construct both
    from one shared `splits` list, as every test and every intended call site
    in this codebase does.
    """
    from .metrics import rmse

    model_rmse = rmse(model_result.actual, model_result.predicted)
    baseline_rmse = rmse(baseline_result.actual, baseline_result.predicted)
    return model_rmse < baseline_rmse
