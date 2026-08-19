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
from .features import build_feature_panel
from .labels import direction_bucket, forward_return
from .metrics import information_coefficient, rmse
from .models import beats_baseline, mean_baseline, train_lgbm_regressor

FEATURE_COLS = [
    "momentum_1d",
    "momentum_5d",
    "momentum_10d",
    "momentum_21d",
    "momentum_63d",
    "volume_zscore_21d",
    # Second-generation features — see the module docstring above
    # features.py's residual_momentum for why the original six sit at
    # IC ~0.01: raw momentum on a 566-name panel is mostly a beta loading.
    "overnight_ret_5d",
    "overnight_ret_21d",
    "intraday_ret_5d",
    "intraday_ret_21d",
    "close_location_value_1d",
    "close_location_value_5d",
    "max_daily_return_21d",
    "signed_volume_imbalance_10d",
    "signed_volume_imbalance_21d",
    "residual_momentum_63d",
    "idio_vol_ratio_21d",
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


def _config_hash(target: str, horizon: int, feature_cols: list[str]) -> str:
    payload = json.dumps({"target": target, "horizon": horizon, "features": feature_cols}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:12]


def build_panel(target: str, horizon: int) -> pl.DataFrame:
    bars = read_bars()
    if bars.height == 0:
        raise SystemExit("No bars in market.db — run bars:backfill first.")

    features = build_feature_panel(bars)

    if target == "dir":
        labels = forward_return(bars, horizon)
        label_col = f"fwd_ret_{horizon}d"
    elif target == "vrp":
        raise SystemExit(
            "--target vrp needs a real trailing implied-vol history that does "
            "not exist yet — capture only started tonight. Use --target dir."
        )
    else:
        raise SystemExit(f"Unknown target: {target!r} (expected 'dir' or 'vrp')")

    panel = features.join(labels, on=["symbol", "day"], how="inner")
    return panel.rename({label_col: "label"})


def train(
    target: str = "dir",
    horizon: int = 5,
    n_splits: int = 4,
    embargo: int = 2,
    min_train_days: int | None = None,
    output_dir: Path | None = None,
) -> Path:
    panel = build_panel(target, horizon)
    if panel.height < 200:
        raise SystemExit(
            f"Only {panel.height} feature/label rows available — too few to "
            f"split into {n_splits} folds meaningfully. Backfill more history first."
        )

    days = sorted(panel["day"].unique().to_list())
    min_train = min_train_days or max(60, len(days) // (n_splits + 2))
    splits = purged_walk_forward_splits(days, n_splits, horizon, embargo, min_train)

    model_result = train_lgbm_regressor(panel, FEATURE_COLS, "label", splits)
    baseline_result = mean_baseline(panel, "label", splits)

    metrics = {
        "model_rmse": rmse(model_result.actual, model_result.predicted),
        "baseline_rmse": rmse(baseline_result.actual, baseline_result.predicted),
        "beats_baseline": beats_baseline(model_result, baseline_result),
        "information_coefficient": information_coefficient(model_result.actual, model_result.predicted),
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

    final_model = lgb.LGBMRegressor(**DEFAULT_LGBM_PARAMS)
    final_model.fit(panel[FEATURE_COLS].to_numpy(), panel["label"].to_numpy())

    run_id = f"{date.today().isoformat()}-{target}-h{horizon}-{_config_hash(target, horizon, FEATURE_COLS)}"
    base_dir = output_dir or (Path.home() / ".org" / "market" / "models")
    run_dir = base_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    final_model.booster_.save_model(str(run_dir / "model.txt"))
    (run_dir / "features.json").write_text(
        json.dumps({"feature_cols": FEATURE_COLS, "target": "label", "config_hash": _config_hash(target, horizon, FEATURE_COLS)}, indent=2)
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
                "metrics": metrics,
            },
            indent=2,
        )
    )

    print(f"\nTrained: {run_id}")
    print(f"  {metrics['n_train_days']} days, {metrics['n_symbols']} symbols, {metrics['n_test_rows']} out-of-fold rows")
    print(f"  model RMSE {metrics['model_rmse']:.5f} vs baseline {metrics['baseline_rmse']:.5f}"
          f" — {'beats' if metrics['beats_baseline'] else 'DOES NOT beat'} baseline")
    print(f"  information coefficient: {metrics['information_coefficient']:.4f}")
    print(f"  artifact: {run_dir}\n")

    return run_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a forecasting model against the local corpus.")
    parser.add_argument("--target", default="dir", choices=["dir", "vrp"])
    parser.add_argument("--horizon", type=int, default=5)
    parser.add_argument("--n-splits", type=int, default=4)
    parser.add_argument("--embargo", type=int, default=2)
    parser.add_argument("--min-train-days", type=int, default=None)
    args = parser.parse_args()

    train(
        target=args.target,
        horizon=args.horizon,
        n_splits=args.n_splits,
        embargo=args.embargo,
        min_train_days=args.min_train_days,
    )


if __name__ == "__main__":
    main()
