"""Meta-labeling — a second model that learns which of the first model's
picks to trust (trial #32).

Lopez de Prado's framing: the primary model decides DIRECTION (which
names look strong); the meta model decides CONVICTION (given everything
observable about this pick, what is the probability it actually works?).
The primary optimizes ranking across all names; the meta specializes in
the only rows that cost money — the ones acted on — and its output is a
probability that can gate or size entries.

Training data: the primary model's own out-of-fold predictions across
the full corpus (oof.parquet in each artifact — leakage-guarded by the
purged walk-forward splits the metrics already trust). Under the
vol_scaled_xs label, `actual > 0` IS "beat the cross-sectional field
over the horizon", so the meta label needs no reconstruction.

Features are deliberately few and observable at pick time:
  - predicted        (the primary's sigma-unit forecast, signed)
  - abs_predicted    (its magnitude — is bold different from timid?)
  - day_rank_pct     (where the pick sat in that day's field)
  - day_dispersion   (how spread the day's forecasts were — a crowded
                      quiet day and a violent day are different regimes)
  - day_breadth      (names forecast that day)
A logistic fit (pure numpy IRLS — five coefficients, no new deps, no
capacity to memorize) with a strictly out-of-time evaluation: fit on
the first 80% of days, judge on the last 20% the fit never saw.

The evaluation prints the only numbers that matter: AUC, and the
realized average outcome of top-trust vs bottom-trust picks in the
holdout. If top-minus-bottom is not clearly positive, the meta model
has no seat — the ledger keeps the attempt either way.

Run (either machine with models synced):
    uv run python -m app.meta --target stk_short
    uv run python -m app.meta --target stk_long --fit-final  # also writes meta-<target>.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import polars as pl

MODELS_DIR = Path.home() / ".org" / "market" / "models"
FEATURES = ["predicted", "abs_predicted", "day_rank_pct", "day_dispersion", "day_breadth"]


def latest_oof(target: str) -> tuple[str, pl.DataFrame]:
    dirs = sorted(
        (d for d in MODELS_DIR.iterdir() if d.is_dir() and f"-{target}-h" in d.name and (d / "oof.parquet").exists()),
        key=lambda d: (d / "oof.parquet").stat().st_mtime,
        reverse=True,
    )
    if not dirs:
        raise SystemExit(
            f"No artifact for {target} carries oof.parquet yet — retrain once on current code first."
        )
    return dirs[0].name, pl.read_parquet(dirs[0] / "oof.parquet")


def build_dataset(oof: pl.DataFrame) -> pl.DataFrame:
    return (
        oof.filter(pl.col("symbol") != "")
        .with_columns(
            pl.col("predicted").abs().alias("abs_predicted"),
            (pl.col("predicted").rank("average").over("day") / pl.col("predicted").count().over("day")).alias(
                "day_rank_pct"
            ),
            pl.col("predicted").std().over("day").alias("day_dispersion"),
            pl.col("predicted").count().over("day").cast(pl.Float64).alias("day_breadth"),
            (pl.col("actual") > 0).cast(pl.Int8).alias("won"),
        )
        .drop_nulls(FEATURES)
    )


def _standardize(X: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mu = X.mean(axis=0)
    sd = X.std(axis=0)
    sd[sd == 0] = 1.0
    return (X - mu) / sd, mu, sd


def fit_logistic(X: np.ndarray, y: np.ndarray, iters: int = 60, l2: float = 1e-3) -> np.ndarray:
    """IRLS with a touch of ridge — five coefficients cannot overfit
    143k rows, but a singular step on a degenerate day still deserves a
    guard rail."""
    Xb = np.hstack([np.ones((len(X), 1)), X])
    w = np.zeros(Xb.shape[1])
    for _ in range(iters):
        p = 1.0 / (1.0 + np.exp(-Xb @ w))
        W = p * (1 - p)
        H = (Xb * W[:, None]).T @ Xb + l2 * np.eye(Xb.shape[1])
        g = Xb.T @ (y - p) - l2 * w
        step = np.linalg.solve(H, g)
        w = w + step
        if np.max(np.abs(step)) < 1e-8:
            break
    return w


def predict(w: np.ndarray, X: np.ndarray) -> np.ndarray:
    Xb = np.hstack([np.ones((len(X), 1)), X])
    return 1.0 / (1.0 + np.exp(-Xb @ w))


def auc(y: np.ndarray, p: np.ndarray) -> float:
    order = np.argsort(p)
    ranks = np.empty_like(order, dtype=float)
    ranks[order] = np.arange(1, len(p) + 1)
    pos = y == 1
    n1, n0 = pos.sum(), (~pos).sum()
    if n1 == 0 or n0 == 0:
        return float("nan")
    return float((ranks[pos].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def evaluate(target: str, fit_final: bool) -> None:
    run_id, oof = latest_oof(target)
    ds = build_dataset(oof)
    days = sorted(ds["day"].unique().to_list())
    cut = days[int(len(days) * 0.8)]
    train = ds.filter(pl.col("day") < cut)
    hold = ds.filter(pl.col("day") >= cut)
    print(f"{target} · oof from {run_id}")
    print(f"rows: {ds.height:,} | train days: {len([d for d in days if d < cut])} | holdout days: {len(days) - len([d for d in days if d < cut])}")

    Xtr, mu, sd = _standardize(train.select(FEATURES).to_numpy())
    w = fit_logistic(Xtr, train["won"].to_numpy().astype(float))
    Xho = (hold.select(FEATURES).to_numpy() - mu) / sd
    p = predict(w, Xho)
    y = hold["won"].to_numpy()

    print(f"holdout AUC: {auc(y, p):.4f}  (0.50 = no skill)")
    q = np.quantile(p, [0.2, 0.8])
    lo, hi = hold.filter(pl.Series(p <= q[0])), hold.filter(pl.Series(p >= q[1]))
    print(
        f"bottom-trust quintile: n={lo.height:,} win={lo['won'].mean():.3f} avg outcome={lo['actual'].mean():+.4f}σ\n"
        f"top-trust quintile:    n={hi.height:,} win={hi['won'].mean():.3f} avg outcome={hi['actual'].mean():+.4f}σ\n"
        f"top-minus-bottom outcome spread: {hi['actual'].mean() - lo['actual'].mean():+.4f}σ"
    )

    if fit_final:
        Xall, mu, sd = _standardize(ds.select(FEATURES).to_numpy())
        w = fit_logistic(Xall, ds["won"].to_numpy().astype(float))
        out = MODELS_DIR / f"meta-{target}.json"
        out.write_text(
            json.dumps(
                {
                    "target": target,
                    "oof_run": run_id,
                    "features": FEATURES,
                    "coef": w.tolist(),
                    "mu": mu.tolist(),
                    "sd": sd.tolist(),
                },
                indent=2,
            )
        )
        print(f"final fit written: {out}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True, choices=["stk_short", "stk_long", "dir"])
    ap.add_argument("--fit-final", action="store_true")
    args = ap.parse_args()
    evaluate(args.target, args.fit_final)


if __name__ == "__main__":
    main()
