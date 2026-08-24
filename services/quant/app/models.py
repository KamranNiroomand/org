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
    #: The round count early stopping chose per fold, when it ran. Absent
    #: for a fold whose training block was too short to purge an inner
    #: validation tail out of, which is a real state and not an error.
    best_rounds: dict[int, int] = field(default_factory=dict)

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


def inner_validation_split(
    train_days: tuple[str, ...],
    horizon: int,
    embargo: int,
    inner_frac: float,
) -> tuple[tuple[str, ...], tuple[str, ...]] | None:
    """Carve a purged validation tail out of a fold's *training* days.

    This is the whole fix in one function, and the purge is the reason it
    exists rather than a one-line slice.

    A fold's loss curve showed validation error bottoming after ~7 of 100
    boosting rounds and rising thereafter — the model spent the other 93
    fitting noise. The obvious response, stopping early against that curve,
    is not available: the curve's validation set *is* the outer test block,
    so selecting a round count against it would convert every out-of-fold
    number reported beside it into an in-sample one. Round selection has to
    happen inside the training data, never touching the test block.

    So the last `inner_frac` of the training days becomes an inner
    validation set — and the days immediately before it are dropped. Labels
    run `horizon` days forward, so without that gap the tail of inner-train
    carries labels realized inside inner-validation, and early stopping
    would be selecting against data it had already seen. Exactly the leak
    `purge_cutoff_index` prevents at the outer boundary, at an inner one.

    Returns None when the training block is too short to give up a
    validation tail *and* a purge gap and still leave something to learn
    from — the caller then trains without early stopping rather than on a
    degenerate split.
    """
    if not 0.0 < inner_frac < 1.0:
        raise ValueError(f"inner_frac must be in (0, 1), got {inner_frac}")

    n = len(train_days)
    n_val = max(1, int(n * inner_frac))
    cutoff = n - n_val - (horizon + embargo)
    if cutoff < 2 or n_val < 1:
        return None
    return train_days[:cutoff], train_days[n - n_val :]


def train_lgbm_regressor(
    panel: pl.DataFrame,
    feature_cols: list[str],
    label_col: str,
    splits: list[WalkForwardSplit],
    day_col: str = "day",
    params: dict[str, object] | None = None,
    record_history: bool = False,
    early_stopping_rounds: int | None = None,
    horizon: int = 0,
    embargo: int = 0,
    inner_validation_frac: float = 0.2,
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

    The recorded curve's validation set is the fold's own **test** block,
    which is worth being explicit about: those rows are out-of-fold for the
    model, so the curve is an honest generalization curve and not a
    training signal. Nothing selects on it. `early_stopping_rounds` uses a
    *separate*, purged split carved out of the training days — see
    `inner_validation_split` — precisely so that round selection never
    touches the block the reported metrics are computed on.

    With `early_stopping_rounds` set, each fold fits twice: once on the
    inner-train block to discover how many rounds actually help, then again
    on the **full** training block for that many rounds. The refit is the
    point — having learned the round count, there is no reason to also
    throw away the validation tail's rows when producing the model that
    scores the test block.

    **Off by default because it was measured and it does not help.** The
    loss curve showed validation error on the outer test block bottoming
    after 1-7 rounds of 100, which reads as "the model wastes 93 rounds
    fitting noise" and makes early stopping look like free improvement. It
    is not. Measured on the real corpus, each configuration counted as its
    own trial against the multiple-testing hurdle:

        no early stopping   rank IC 0.0366  ICIR 0.251  t 1.76  RMSE 0.11809
        patience 50         rank IC 0.0366  ICIR 0.255  t 1.79  RMSE 0.11807
        patience 10         rank IC 0.0324  ICIR 0.219  t 1.53  RMSE 0.11832

    Patience 50 is a wash — an ICIR gap of 0.004 against a per-period
    standard error near 0.02 is noise — and tightening it is worse.

    The reason is worth keeping, because it says something about the data
    rather than about this function. The rounds the two validations pick
    disagree by an order of magnitude:

        outer test block bottoms at:   1, 6, 7, 65
        inner validation chooses:     61, 47, 57, 94

    The inner split is a purged tail of the *training* days — near in time,
    so the model generalizes to it well and its optimum sits late. The
    outer test block is further into the future, where the model decays far
    faster. That gap is non-stationarity, not overfitting, and no amount of
    stopping earlier fixes it: selecting the outer optimum would require
    looking at the outer block, which is exactly the cheat that would turn
    every out-of-fold metric reported beside it into an in-sample one.

    So the honest reading of that loss curve is not "we are wasting 93
    rounds" but "the future does not look like the recent past" — which
    points at retraining cadence and regime handling, not at the boosting
    round count. The machinery is kept, correct and off, so that this
    experiment does not get run a third time.
    """
    result = TrainingResult(target=label_col, feature_cols=feature_cols)
    model_params = {**DEFAULT_LGBM_PARAMS, **(params or {})}

    for split in splits:
        train, test = apply_split(panel, split, day_col)
        if train.height == 0 or test.height == 0:
            continue
        # Round selection first, on data the test block never sees.
        fold_params = dict(model_params)
        if early_stopping_rounds is not None:
            inner = inner_validation_split(split.train_days, horizon, embargo, inner_validation_frac)
            if inner is not None:
                inner_train_days, inner_val_days = inner
                itr = train.filter(pl.col(day_col).is_in(list(inner_train_days)))
                iva = train.filter(pl.col(day_col).is_in(list(inner_val_days)))
                if itr.height > 0 and iva.height > 0:
                    probe = lgb.LGBMRegressor(**model_params)
                    probe.fit(
                        itr[feature_cols].to_numpy(),
                        itr[label_col].to_numpy(),
                        eval_X=iva[feature_cols].to_numpy(),
                        eval_y=iva[label_col].to_numpy(),
                        eval_metric="rmse",
                        callbacks=[lgb.early_stopping(early_stopping_rounds, verbose=False)],
                    )
                    best = probe.best_iteration_
                    if best and best > 0:
                        fold_params["n_estimators"] = best
                        result.best_rounds[split.fold] = int(best)

        model = lgb.LGBMRegressor(**fold_params)
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
