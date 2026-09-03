"""Training entrypoint.

The one thing that was missing to make "train on the runner Mac" concrete
rather than aspirational: everything in `cv.py`, `models.py`, `metrics.py`
and `labels.py` had test coverage but no command a person could actually run.
This is that command.

    cd services/quant && uv run python -m app.train --target dir --horizon 5

Reads bars from the local `market.db`, builds features and a label, runs the
purged walk-forward split, trains LightGBM against the mean baseline, and
writes a self-contained artifact bundle. Nothing here writes back to
`market.db` — Python is read-only on that database throughout this project;
a trained model is a file, not a row, and stays that way until a Node-side
script reads its manifest and registers it (not yet built — see the module
docstring's last paragraph).

**Today, only `--target dir` (forward return / direction) is meaningfully
trainable end to end.** The vrp target needs a real trailing history of
captured implied vol to mean anything, and capture only started running
tonight — the code path exists and is exercised in tests, but a manifest
produced from it right now would be trained on a few hours of chain history,
which is not enough to trust.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import subprocess
import sys
from datetime import date
from pathlib import Path

import numpy as np
import polars as pl

from .cv import purged_walk_forward_splits
from .db import read_bars
from .features import (
    NEWS_FEATURE_COLS,
    build_feature_panel,
    earnings_feature_panel,
    news_feature_panel,
    option_feature_panel,
    rank_features_per_day,
    sector_feature_panel,
)
from .labels import direction_bucket, forward_return, vol_scaled_forward_return
from .metrics import ic_summary, information_coefficient, rmse
from .models import beats_baseline, mean_baseline, train_lgbm_regressor

FEATURE_COLS = [
    "momentum_21d",
    "momentum_63d",
    "volume_zscore_21d",
    # Second-generation features — see the module docstring above
    # features.py's residual_momentum for why the original six sit at
    # IC ~0.01: raw momentum on a 566-name panel is mostly a beta loading.
    "overnight_ret_21d",
    "intraday_ret_21d",
    "close_location_value_5d",
    "signed_volume_imbalance_21d",
    "residual_momentum_63d",
    "idio_vol_ratio_21d",
    # Third generation — the axis the panel did not have. Nine of the
    # columns above are a price change over some window; these describe how
    # a move was funded and how hard it is to trade against. See
    # features.py::reversal_and_liquidity.
    "amihud_illiquidity_21d",
]


def _git_sha() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5, check=True,
        )
        return out.stdout.strip()
    except Exception:
        return None  # a missing git sha should not fail a training run


def _config_hash(
    target: str,
    horizon: int,
    feature_cols: list[str],
    early_stopping_rounds: int | None = None,
    label_kind: str = "raw",
    rank_features: bool = False,
    label_vol_window: int = 21,
) -> str:
    """Identifies a training configuration. Anything that changes the
    fitted model must be in here.

    `early_stopping_rounds` is included because leaving it out collided
    immediately: the three runs measuring it — off, patience 50, patience
    10 — all produced run_id `2026-08-24-dir-h5-f47646104951` and wrote
    into the same artifact directory, so the last one left the registry's
    champion pointing at the *worst* of the three. Restoring it took a
    retrain, a re-register, a re-snapshot and a re-pull on both machines.

    `models:pull` compounds a collision rather than correcting it: a reader
    already holding the directory keeps whichever version arrived first.

    Still not covered, and worth knowing: feature *implementations*. Two
    different definitions of the same column name hash identically, which
    has also happened. A source hash over features.py would close that.
    """
    payload = json.dumps(
        {
            "target": target,
            "horizon": horizon,
            "features": feature_cols,
            "early_stopping_rounds": early_stopping_rounds,
            "label_kind": label_kind,
            "rank_features": rank_features,
            "label_vol_window": label_vol_window,
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:12]


#: The current training configuration's preprocessing — both halves of
#: trial #20 (see MODEL_TRIAL_COUNT in apps/server/src/config.ts).
#:
#: `LABEL_KIND = "vol_scaled"`: the label is the forward return in the
#: symbol's own trailing-sigma units — see `vol_scaled_forward_return`
#: for why predicting raw returns mostly teaches a cross-sectional model
#: which names are volatile. Inference multiplies the prediction back by
#: the current trailing sigma (manifest-gated in rank.py, so older raw-
#: label models keep scoring unchanged).
#:
#: `RANK_FEATURES = True`: features are per-day cross-sectional ranks in
#: [-1, 1] — see `rank_features_per_day`. Applied identically at
#: training and inference, keyed off the same manifest.
LABEL_KIND = "vol_scaled"
LABEL_VOL_WINDOW = 21
RANK_FEATURES = True

#: The STOCK engine's feature sets — trials #21 and #22 (see
#: MODEL_TRIAL_COUNT in apps/server/src/config.ts). Short-horizon leans
#: on short-window momentum/reversal plus the news pulse; long-horizon on
#: slow momentum, residual momentum, and liquidity, with the slow news
#: axis. Both ride the same vol-scaled label and per-day rank transform
#: as `dir`.
DIR_COLS = [
    *FEATURE_COLS,
    "news_count_1d",
    "news_count_5d",
    "news_sent_net_1d",
    "news_sent_net_5d",
    # Trial #27 (2026-09-04): the five MATURE options-derived columns —
    # full corpus history, and the most theory-motivated features in the
    # repo pointed at the target they describe (options flow -> options
    # direction). The three young skew_* columns deliberately stay out
    # until their ~late-Oct history flip. Counted in MODEL_TRIAL_COUNT.
    "cpiv_spread",
    "iv_term_slope",
    "risk_reversal_25d",
    "put_call_oi_ratio",
    "put_call_volume_ratio",
]

STOCK_SHORT_COLS = [
    *FEATURE_COLS,
    "momentum_5d",
    "momentum_10d",
    "reversal_21d",
    "news_count_1d",
    "news_count_5d",
    "news_sent_net_1d",
    "news_sent_net_5d",
    # Trial #24 (2026-09-01) RAN AND WAS REJECTED: sector-spillover
    # columns dropped daily IC from 0.0063 to 0.0025 on the healed
    # corpus (artifact 2026-09-01-stk_short-h21-a74037e82ee6). The
    # columns stay ride-alongs; the ledger keeps the trial — counted on
    # running, not on winning.
]
STOCK_LONG_COLS = [
    "momentum_21d",
    "momentum_63d",
    "residual_momentum_63d",
    "idio_vol_ratio_21d",
    "amihud_illiquidity_21d",
    "volume_zscore_21d",
    "overnight_ret_21d",
    "news_count_21d",
    "news_sent_net_21d",
]


@dataclass(frozen=True)
class TargetSpec:
    """Everything that defines one trainable configuration. One spec = one
    counted trial; editing a spec's fields is a *new* configuration and
    must bump the trial ledger, which is why every field here feeds
    `_config_hash`."""

    horizon: int
    feature_cols: list[str]
    label_vol_window: int
    default_n_splits: int
    include_news: bool
    #: CV floor. None = the generic len//(n_splits+2) heuristic, which is
    #: fine until the horizon itself approaches it: at h=126 the purge
    #: (horizon + embargo = 128 days) exceeds the heuristic's 125 on a
    #: 2-year corpus and the first fold starves. A long-horizon target
    #: must state its own floor.
    min_train_days: int | None = None


TARGETS: dict[str, TargetSpec] = {
    # The original options-direction config, unchanged in substance.
    # Trial #25 (2026-09-01) RAN AND WAS ADOPTED: news columns lifted
    # dir's daily IC from 0.0060 to 0.0132 (pooled 0.0353) — the
    # strongest dir signal recorded (artifact
    # 2026-09-01-dir-h5-359f97363a0d). Still below the hurdle; the
    # banner stands.
    "dir": TargetSpec(5, DIR_COLS, LABEL_VOL_WINDOW, 4, include_news=True),
    # Stock engine: ~1-4 week swings.
    "stk_short": TargetSpec(21, STOCK_SHORT_COLS, 21, 4, include_news=True),
    # Stock engine: ~6-12 month positions. Two folds until the bar corpus
    # is deep enough for four (the CV math, not a preference: a 126-day
    # horizon plus purge eats ~128 training days per fold).
    "stk_long": TargetSpec(126, STOCK_LONG_COLS, 63, 2, include_news=True, min_train_days=180),
}


def build_panel(target: str, horizon: int) -> pl.DataFrame:
    if target == "vrp":
        raise SystemExit(
            "--target vrp needs a real trailing implied-vol history that does "
            "not exist yet — capture only started tonight. Use --target dir."
        )
    spec = TARGETS.get(target)
    if spec is None:
        raise SystemExit(f"Unknown target: {target!r} (expected one of {sorted(TARGETS)})")

    bars = read_bars()
    if bars.height == 0:
        raise SystemExit("No bars in market.db — run bars:backfill first.")

    # The option-derived columns ride along in the panel from day one so
    # their history accrues with the corpus, but they are NOT in any
    # target's feature set yet — see OPTION_FEATURE_COLS in features.py
    # for the coverage threshold and the trial-count cost.
    features = build_feature_panel(bars, option_panel=option_feature_panel())
    if spec.include_news:
        # Sector spillover rides along with the news panel — same left
        # join, same not-yet-in-FEATURE_COLS status, same reasoning: see
        # SECTOR_FEATURE_COLS in features.py.
        sector = sector_feature_panel(bars)
        if sector.height > 0:
            features = features.join(sector, on=["symbol", "day"], how="left")
        news = news_feature_panel()
        if news.height > 0:
            # Left, same reasoning as the option panel: news coverage is
            # per-symbol sparse and must never shrink the bars panel.
            features = features.join(news, on=["symbol", "day"], how="left")
        else:
            for c in NEWS_FEATURE_COLS:
                features = features.with_columns(pl.lit(None, dtype=pl.Float64).alias(c))
        # Post-earnings drift, ride-along — see EARNINGS_FEATURE_COLS.
        earnings = earnings_feature_panel()
        if earnings.height > 0:
            features = features.join(earnings, on=["symbol", "day"], how="left")

    if LABEL_KIND == "vol_scaled":
        labels = vol_scaled_forward_return(bars, horizon, vol_window=spec.label_vol_window)
    else:
        labels = forward_return(bars, horizon)
    label_col = f"fwd_ret_{horizon}d"

    if RANK_FEATURES:
        panel_features = rank_features_per_day(features, spec.feature_cols)
    else:
        panel_features = features
    panel = panel_features.join(labels, on=["symbol", "day"], how="inner")
    return panel.rename({label_col: "label"})


def train(
    target: str = "dir",
    horizon: int | None = None,
    n_splits: int | None = None,
    embargo: int = 2,
    min_train_days: int | None = None,
    output_dir: Path | None = None,
    n_trials: int = 1,
    early_stopping_rounds: int | None = None,
) -> Path:
    spec = TARGETS.get(target)
    if spec is None:
        raise SystemExit(f"Unknown target: {target!r} (expected one of {sorted(TARGETS)})")
    horizon = horizon if horizon is not None else spec.horizon
    n_splits = n_splits if n_splits is not None else spec.default_n_splits
    feature_cols = spec.feature_cols

    panel = build_panel(target, horizon)
    if panel.height < 200:
        raise SystemExit(
            f"Only {panel.height} feature/label rows available — too few to "
            f"split into {n_splits} folds meaningfully. Backfill more history first."
        )

    days = sorted(panel["day"].unique().to_list())
    min_train = min_train_days or spec.min_train_days or max(60, len(days) // (n_splits + 2))
    splits = purged_walk_forward_splits(days, n_splits, horizon, embargo, min_train)

    model_result = train_lgbm_regressor(
        panel,
        feature_cols,
        "label",
        splits,
        record_history=True,
        early_stopping_rounds=early_stopping_rounds,
        horizon=horizon,
        embargo=embargo,
    )
    baseline_result = mean_baseline(panel, "label", splits)

    metrics = {
        # RMSE against a fold-mean predictor is kept for continuity, but it is
        # not a useful gate at the effect sizes this problem has. Expected R²
        # is roughly IC², so an IC of 0.02 — a respectable cross-sectional
        # number — implies R² ≈ 0.04%, far below what RMSE can resolve against
        # a mean predictor. Published best-in-class stock-level out-of-sample
        # R² is itself only ~0.3-0.4% (Gu, Kelly & Xiu, RFS 2020). Failing
        # `beats_baseline` therefore says almost nothing; read the IC block.
        "model_rmse": rmse(model_result.actual, model_result.predicted),
        "baseline_rmse": rmse(baseline_result.actual, baseline_result.predicted),
        "beats_baseline": beats_baseline(model_result, baseline_result),
        # Pooled over every symbol-day. Retained only so the historical series
        # on `model_runs` stays comparable — see the docstring on
        # `information_coefficient` for why this number reads high.
        "information_coefficient": information_coefficient(model_result.actual, model_result.predicted),
        # The honest read: daily cross-sectional rank IC, its dispersion, and
        # a t-statistic on non-overlapping periods against a
        # multiple-testing-aware hurdle.
        **ic_summary(
            model_result.days,
            model_result.actual,
            model_result.predicted,
            horizon=horizon,
            n_trials=n_trials,
        ),
        "n_trials": n_trials,
        # What early stopping chose per fold, when it ran — so a run's
        # round counts are recoverable from the registry rather than only
        # from a terminal that has since scrolled away.
        "early_stopping_rounds": early_stopping_rounds,
        "best_rounds": model_result.best_rounds,
        "n_folds": len(model_result.folds),
        "n_test_rows": int(len(model_result.actual)),
        "n_train_days": len(days),
        "n_symbols": panel["symbol"].n_unique(),
    }

    # Refit on ALL data for the artifact that actually gets deployed — the
    # walk-forward folds above exist to produce an honest out-of-fold metric,
    # not to decide which fold's model ships. Shipping a fold model would
    # throw away the most recent training days for no reason.
    import lightgbm as lgb
    from .models import DEFAULT_LGBM_PARAMS

    final_params = dict(DEFAULT_LGBM_PARAMS)
    if model_result.best_rounds:
        # The deployed model gets the *median* fold's round count, not the
        # default 100. Median rather than mean because a single fold whose
        # inner split barely fit can pick an extreme count, and rather than
        # max because the whole point is to stop before the noise-fitting
        # the curve exposed. A refit on all data with a count learned from
        # folds is the standard construction; it never touches the test
        # blocks, which is what keeps the reported metrics out-of-fold.
        chosen = sorted(model_result.best_rounds.values())
        final_params["n_estimators"] = chosen[len(chosen) // 2]
    final_model = lgb.LGBMRegressor(**final_params)
    final_model.fit(panel[feature_cols].to_numpy(), panel["label"].to_numpy())

    config_hash = _config_hash(
        target, horizon, feature_cols, early_stopping_rounds,
        label_kind=LABEL_KIND, rank_features=RANK_FEATURES,
        label_vol_window=spec.label_vol_window,
    )
    run_id = f"{date.today().isoformat()}-{target}-h{horizon}-{config_hash}"
    base_dir = output_dir or (Path.home() / ".org" / "market" / "models")
    run_dir = base_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    final_model.booster_.save_model(str(run_dir / "model.txt"))
    # The loss curve. Written as its own artifact rather than folded into
    # manifest.json because it is two arrays per fold of a few hundred
    # floats each, and the manifest is read on every model load — by
    # `load_model`, by the registry, by every rank. A curve nobody needs at
    # scoring time should not be parsed at scoring time.
    (run_dir / "history.json").write_text(
        json.dumps({str(fold): curves for fold, curves in model_result.history.items()}, indent=2)
    )
    (run_dir / "features.json").write_text(
        json.dumps({"feature_cols": feature_cols, "target": "label", "config_hash": config_hash}, indent=2)
    )
    (run_dir / "manifest.json").write_text(
        json.dumps(
            {
                "run_id": run_id,
                "target": target,
                "horizon": horizon,
                "git_sha": _git_sha(),
                "trained_at": None,  # stamped by the caller — see module docstring on Date.now()-style restrictions
                "train_days": {"first": days[0], "last": days[-1], "count": len(days)},
                "n_splits": n_splits,
                "embargo": embargo,
                "label": {"kind": LABEL_KIND, "vol_window": spec.label_vol_window},
                "rank_features": RANK_FEATURES,
                "metrics": metrics,
            },
            indent=2,
        )
    )

    verdict = "CLEARS" if metrics["ic_clears_hurdle"] else "does NOT clear"
    print(f"\nTrained: {run_id}")
    print(f"  {metrics['n_train_days']} days, {metrics['n_symbols']} symbols, {metrics['n_test_rows']} out-of-fold rows")
    print(
        f"  daily cross-sectional rank IC: {metrics['ic_mean']:+.4f} "
        f"(std {metrics['ic_std']:.4f}, ICIR {metrics['icir']:+.3f}, "
        f"hit rate {metrics['ic_hit_rate']:.0%} over {metrics['ic_n_days']} days)"
    )
    print(
        f"  t = {metrics['ic_t_stat']:+.2f} on {metrics['ic_n_effective']} non-overlapping periods "
        f"vs hurdle {metrics['ic_t_hurdle']:.2f} for {metrics['n_trials']} trial(s) — {verdict}"
    )
    print(f"  daily Pearson IC {metrics['ic_mean_pearson']:+.4f} (gap vs rank flags outlier dependence)")
    print(
        f"  [legacy, not a gate] pooled IC {metrics['information_coefficient']:.4f}; "
        f"RMSE {metrics['model_rmse']:.5f} vs baseline {metrics['baseline_rmse']:.5f} "
        f"({'beats' if metrics['beats_baseline'] else 'does not beat'})"
    )
    print(f"  artifact: {run_dir}\n")

    return run_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a forecasting model against the local corpus.")
    parser.add_argument("--target", default="dir", choices=sorted([*TARGETS, "vrp"]))
    parser.add_argument("--horizon", type=int, default=None)
    parser.add_argument("--n-splits", type=int, default=None)
    parser.add_argument("--embargo", type=int, default=2)
    parser.add_argument("--min-train-days", type=int, default=None)
    parser.add_argument(
        "--early-stopping-rounds",
        type=int,
        default=None,
        help=(
            "Stop each fold's fit once a purged inner validation split has not "
            "improved for this many rounds. The inner split is carved from the "
            "*training* days with the same purge gap as the outer one, so round "
            "selection never touches the test block the reported metrics are "
            "computed on. Off by default until measured."
        ),
    )
    parser.add_argument(
        "--n-trials",
        type=int,
        default=1,
        help=(
            "How many distinct configurations have been tried in this line of "
            "work — every feature set, horizon, target and hyperparameter "
            "combination considered, not just the runs that were kept. Raises "
            "the t-statistic hurdle the IC must clear, because the more "
            "configurations you look at, the better the luckiest one looks. "
            "Leaving this at 1 while iterating quietly understates the bar."
        ),
    )
    args = parser.parse_args()

    train(
        target=args.target,
        horizon=args.horizon,
        n_splits=args.n_splits,
        embargo=args.embargo,
        min_train_days=args.min_train_days,
        n_trials=args.n_trials,
        early_stopping_rounds=args.early_stopping_rounds,
    )


if __name__ == "__main__":
    main()
