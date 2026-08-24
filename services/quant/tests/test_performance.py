"""Model-performance payload tests.

The contract that matters here is not arithmetic — it is that a metric a
run never recorded arrives as *absent*, never as zero. Every run predating
a metric would otherwise plot as a model with no skill, which is a
different and much worse claim than "not measured".
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from app import performance as perf


@pytest.fixture
def registry(tmp_path, monkeypatch):
    """A market.db with a `model_runs` table and nothing else."""
    db = tmp_path / "market.db"
    conn = sqlite3.connect(db)
    conn.execute(
        """
        CREATE TABLE model_runs (
            run_id TEXT PRIMARY KEY, target TEXT, registered_at TEXT,
            status TEXT, metrics TEXT, history TEXT
        )
        """
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(perf, "reading", lambda: _reading(db))
    return db


class _reading:
    """Mirrors db.reading()'s context-manager shape against a test file."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def __enter__(self):
        self.conn = sqlite3.connect(self.path)
        return self.conn

    def __exit__(self, *exc):
        self.conn.close()
        return False


def _insert(
    db: Path,
    run_id: str,
    registered_at: str,
    metrics: dict | None,
    target="dir",
    status="challenger",
    history: dict | None = None,
):
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO model_runs VALUES (?,?,?,?,?,?)",
        (
            run_id,
            target,
            registered_at,
            status,
            json.dumps(metrics) if metrics is not None else None,
            json.dumps(history) if history is not None else None,
        ),
    )
    conn.commit()
    conn.close()


class TestRunHistory:
    def test_orders_by_registration_time_not_by_run_id(self, registry) -> None:
        # Run ids are date-prefixed but suffixed with a config hash, so they
        # sort chronologically only across dates — the same trap that let a
        # promoted champion go unserved. Sorting a *chart* that way plots
        # the series out of order, which reads as a model that improved and
        # regressed rather than as a sort bug.
        _insert(registry, "2026-08-24-dir-h5-fff", "2026-08-24T09:00:00Z", {"ic_mean": 0.03})
        _insert(registry, "2026-08-24-dir-h5-000", "2026-08-24T17:00:00Z", {"ic_mean": 0.04})

        runs = perf.read_run_history()

        assert [r.run_id[-3:] for r in runs] == ["fff", "000"]

    def test_a_metric_a_run_never_recorded_is_absent_not_zero(self, registry) -> None:
        # The whole point. An older run carries no `ic_mean` key at all, and
        # defaulting it to 0.0 would draw a real model as having no skill.
        _insert(registry, "old", "2026-08-19T00:00:00Z", {"beats_baseline": False})
        _insert(registry, "new", "2026-08-24T00:00:00Z", {"beats_baseline": True, "ic_mean": 0.0366})

        runs = perf.read_run_history()

        assert "ic_mean" not in runs[0].metrics
        assert runs[1].metrics["ic_mean"] == pytest.approx(0.0366)

    def test_an_unreadable_metrics_blob_keeps_the_run_on_the_chart(self, registry) -> None:
        # Dropping it would leave a gap that reads as "no training happened"
        # — a different and wrong story from "this run's metrics are
        # corrupt".
        conn = sqlite3.connect(registry)
        conn.execute(
            "INSERT INTO model_runs VALUES ('bad','dir','2026-08-20T00:00:00Z','challenger','{not json',NULL)"
        )
        conn.commit()
        conn.close()

        runs = perf.read_run_history()

        assert [r.run_id for r in runs] == ["bad"]
        assert runs[0].metrics == {}

    def test_filters_by_target(self, registry) -> None:
        _insert(registry, "d", "2026-08-20T00:00:00Z", {}, target="dir")
        _insert(registry, "v", "2026-08-21T00:00:00Z", {}, target="vrp")

        assert [r.run_id for r in perf.read_run_history("dir")] == ["d"]
        assert [r.run_id for r in perf.read_run_history("vrp")] == ["v"]
        assert len(perf.read_run_history()) == 2


class TestLossCurve:
    def test_a_run_without_history_returns_empty_not_a_fabricated_curve(self, tmp_path) -> None:
        (tmp_path / "run").mkdir()
        assert perf.read_loss_curve("run", tmp_path) == {}

    def test_reads_the_recorded_curve(self, tmp_path) -> None:
        d = tmp_path / "run"
        d.mkdir()
        (d / "history.json").write_text(json.dumps({"0": {"train": [1.0, 0.9], "validation": [1.1, 1.2]}}))

        curve = perf.read_loss_curve("run", tmp_path)

        assert curve["0"]["train"] == [1.0, 0.9]
        assert curve["0"]["validation"] == [1.1, 1.2]

    def test_a_corrupt_history_file_is_empty_rather_than_an_exception(self, tmp_path) -> None:
        # A dashboard must not 500 because one artifact is malformed.
        d = tmp_path / "run"
        d.mkdir()
        (d / "history.json").write_text("{not json")
        assert perf.read_loss_curve("run", tmp_path) == {}


class TestPayload:
    def test_attaches_the_curve_of_the_latest_run_only(self, registry, tmp_path) -> None:
        _insert(registry, "older", "2026-08-19T00:00:00Z", {"ic_mean": 0.01})
        _insert(registry, "latest", "2026-08-24T00:00:00Z", {"ic_mean": 0.0366})
        for name in ("older", "latest"):
            d = tmp_path / name
            d.mkdir()
            (d / "history.json").write_text(json.dumps({"0": {"train": [1.0], "validation": [1.0]}}))

        payload = perf.model_performance("dir", tmp_path)

        # Nothing is promoted here, so the newest run is featured.
        assert payload["featured_run_id"] == "latest"
        assert payload["featured_is_champion"] is False
        assert payload["latest_run_id"] == "latest"
        assert len(payload["runs"]) == 2
        assert payload["loss_curve"]["0"]["train"] == [1.0]

    def test_headlines_the_champion_not_the_newest_registration(self, registry, tmp_path) -> None:
        """The defect this prevents: the page's stat tiles and pass/fail
        banner describing a model the system is not serving. Model
        selection resolves the registry champion, so registering a
        challenger after a promotion would otherwise re-headline the page
        with a run that never scores anything."""
        _insert(registry, "champ", "2026-08-20T00:00:00Z", {"ic_mean": 0.04}, status="champion")
        _insert(registry, "newer", "2026-08-24T00:00:00Z", {"ic_mean": 0.01}, status="challenger")

        payload = perf.model_performance("dir", tmp_path)

        assert payload["featured_run_id"] == "champ"
        assert payload["featured_is_champion"] is True
        # Still reported, because "what was registered last" is a real and
        # separate question — it just must not drive the headline.
        assert payload["latest_run_id"] == "newer"

    def test_falls_back_to_the_newest_run_and_says_so_when_nothing_is_promoted(
        self, registry, tmp_path
    ) -> None:
        _insert(registry, "a", "2026-08-20T00:00:00Z", {}, status="challenger")
        _insert(registry, "b", "2026-08-24T00:00:00Z", {}, status="challenger")

        payload = perf.model_performance("dir", tmp_path)

        assert payload["featured_run_id"] == "b"
        assert payload["featured_is_champion"] is False

    def test_the_curve_follows_the_featured_run(self, registry, tmp_path) -> None:
        # A champion's curve, not the newest run's — otherwise the page
        # would show one model's overfitting under another model's name.
        _insert(
            registry, "champ", "2026-08-20T00:00:00Z", {}, status="champion",
            history={"0": {"train": [1.0], "validation": [1.0]}},
        )
        _insert(
            registry, "newer", "2026-08-24T00:00:00Z", {}, status="challenger",
            history={"0": {"train": [9.0], "validation": [9.0]}},
        )

        payload = perf.model_performance("dir", tmp_path)

        assert payload["loss_curve"]["0"]["train"] == [1.0]

    def test_the_registry_curve_wins_over_a_stale_artifact_file(self, registry, tmp_path) -> None:
        # Both exist for a run that was retrained: the registry row is
        # rewritten on re-registration, the artifact file may not have been
        # re-pulled. The database is the source of truth.
        _insert(
            registry, "run", "2026-08-24T00:00:00Z", {},
            history={"0": {"train": [1.0], "validation": [1.0]}},
        )
        d = tmp_path / "run"
        d.mkdir()
        (d / "history.json").write_text(json.dumps({"0": {"train": [99.0], "validation": [99.0]}}))

        payload = perf.model_performance("dir", tmp_path)

        assert payload["loss_curve"]["0"]["train"] == [1.0]

    def test_falls_back_to_the_artifact_when_the_registry_has_no_curve(self, registry, tmp_path) -> None:
        # A run registered before the column existed, or whose files
        # arrived before its registry row did.
        _insert(registry, "run", "2026-08-24T00:00:00Z", {})
        d = tmp_path / "run"
        d.mkdir()
        (d / "history.json").write_text(json.dumps({"0": {"train": [7.0], "validation": [7.0]}}))

        payload = perf.model_performance("dir", tmp_path)

        assert payload["loss_curve"]["0"]["train"] == [7.0]

    def test_an_empty_registry_is_a_valid_payload(self, registry, tmp_path) -> None:
        payload = perf.model_performance("dir", tmp_path)
        assert payload["runs"] == []
        assert payload["latest_run_id"] is None
        assert payload["loss_curve"] == {}
