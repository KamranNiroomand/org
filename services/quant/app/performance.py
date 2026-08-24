"""Everything the model-performance dashboard shows, assembled here.

Deliberately in Python rather than in the Node route that serves it: every
number on this page is a model-quality statistic, and model-quality
statistics live with the model. A TypeScript reimplementation of, say, the
significance hurdle would be a second definition of "is this model any
good" free to drift from `metrics.py`'s — which is the one disagreement
this project can least afford, since the whole apparatus exists to stop a
weak model from looking strong.

Two series, kept rigidly apart because conflating them is the classic way
a trading system flatters itself:

* **Model quality** — out-of-fold rank IC, its dispersion, the
  significance hurdle, whether the run beat its baseline. Says whether the
  forecast has skill. Says nothing about money.
* **The loss curve** — per-boosting-round train and validation RMSE, which
  says *how* a fit got where it did. A model whose validation curve turns
  up while its training curve keeps falling is overfitting, and no
  end-of-run summary metric can show that.

Trading P&L is the third thing and lives on the paper book, not here. It
is a different question with a different denominator, and a dashboard that
puts them in one number is how "the model is good" and "the trades made
money" stop being separable claims.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from .db import reading


@dataclass
class RunSummary:
    """One registered training run, as the dashboard plots it."""

    run_id: str
    target: str
    registered_at: str
    status: str
    #: Every metric the run recorded, passed through rather than
    #: cherry-picked. The dashboard decides what to show; this decides
    #: nothing, so a metric added to `train.py` appears here without a
    #: change on this side.
    metrics: dict = field(default_factory=dict)


def read_run_history(target: str | None = None) -> list[RunSummary]:
    """Registered runs oldest-first, which is the order a chart wants.

    Ordered by `registered_at` rather than by `run_id`: run ids are
    date-prefixed but suffixed with a config hash, so they sort
    chronologically only across dates — the same trap that let a promoted
    champion go unserved (see `rank.py::resolve_model`). Sorting a *chart*
    that way would silently plot the series out of order, which looks like
    a model that improved and regressed rather than a sort bug.
    """
    query = """
        SELECT run_id, target, registered_at, status, metrics
        FROM model_runs
    """
    params: tuple = ()
    if target is not None:
        query += " WHERE target = ?"
        params = (target,)
    query += " ORDER BY registered_at ASC"

    with reading() as conn:
        rows = conn.execute(query, params).fetchall()

    out: list[RunSummary] = []
    for run_id, run_target, registered_at, status, metrics_json in rows:
        try:
            metrics = json.loads(metrics_json) if metrics_json else {}
        except (TypeError, ValueError):
            # A run whose metrics blob is unreadable still belongs on the
            # chart as a point in time — dropping it would leave a gap that
            # reads as "no training happened", which is a different and
            # wrong story.
            metrics = {}
        out.append(
            RunSummary(
                run_id=run_id,
                target=run_target,
                registered_at=registered_at,
                status=status,
                metrics=metrics,
            )
        )
    return out


def read_loss_curve(run_id: str, base_dir: Path | None = None) -> dict[str, dict[str, list[float]]]:
    """Per-fold train/validation RMSE for one run, or `{}` if not recorded.

    Empty is the normal answer for any run trained before `history.json`
    existed, and the caller must render that as "not recorded" rather than
    as a flat line at zero — an invented curve is worse than an absent one,
    because it is the shape a perfectly-fit model would have.
    """
    base = base_dir or (Path.home() / ".org" / "market" / "models")
    path = base / run_id / "history.json"
    if not path.exists():
        return {}
    try:
        loaded = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    if not isinstance(loaded, dict):
        return {}
    return loaded


def model_performance(target: str = "dir", base_dir: Path | None = None) -> dict:
    """The whole dashboard payload for one target.

    The loss curve is attached only for the most recent run. Every run's
    curve would be several hundred floats per fold per run, and the
    question a loss curve answers — did *this* fit overfit — is asked of
    the model in front of you, not of one from three weeks ago.
    """
    runs = read_run_history(target)
    latest = runs[-1] if runs else None
    return {
        "target": target,
        "runs": [
            {
                "run_id": r.run_id,
                "registered_at": r.registered_at,
                "status": r.status,
                "metrics": r.metrics,
            }
            for r in runs
        ],
        "latest_run_id": latest.run_id if latest else None,
        "loss_curve": read_loss_curve(latest.run_id, base_dir) if latest else {},
    }
