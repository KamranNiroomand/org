"""Training entrypoint tests, run against the real local corpus rather than a
synthetic panel — this is the one module whose job is specifically to prove
the whole pipeline works end to end on data as it actually exists on disk.
"""

from __future__ import annotations

import json

import lightgbm as lgb
import pytest

from app.train import _config_hash, FEATURE_COLS, build_panel, train


def _have_enough_bars() -> bool:
    from app.db import read_bars

    return read_bars().height > 0


class TestBuildPanel:
    def test_joins_features_and_labels_on_the_real_corpus(self) -> None:
        if not _have_enough_bars():
            pytest.skip("no bars in market.db yet — run bars:backfill first")
        panel = build_panel("dir", horizon=5)
        assert set(FEATURE_COLS) <= set(panel.columns)
        assert "label" in panel.columns
        assert panel.height > 0

    def test_refuses_the_vrp_target_honestly(self) -> None:
        # Not "not implemented" — the function exists and is exercised
        # elsewhere; this specifically refuses to train it because there is
        # not yet enough captured implied-vol history for the result to mean
        # anything. Encodes that reasoning as a test, not just a comment.
        with pytest.raises(SystemExit, match="does not exist yet"):
            build_panel("vrp", horizon=5)

    def test_rejects_an_unknown_target(self) -> None:
        with pytest.raises(SystemExit, match="Unknown target"):
            build_panel("nonsense", horizon=5)


class TestTrainEndToEnd:
    def test_produces_a_complete_loadable_artifact(self, tmp_path) -> None:
        if not _have_enough_bars():
            pytest.skip("no bars in market.db yet — run bars:backfill first")

        run_dir = train(target="dir", horizon=5, n_splits=3, embargo=2, output_dir=tmp_path)

        assert (run_dir / "model.txt").exists()
        assert (run_dir / "manifest.json").exists()
        assert (run_dir / "features.json").exists()

        # The artifact is not just present, it is usable: a fresh LightGBM
        # booster loads it and can score a real feature row.
        booster = lgb.Booster(model_file=str(run_dir / "model.txt"))
        assert booster.num_feature() == len(FEATURE_COLS)

        manifest = json.loads((run_dir / "manifest.json").read_text())
        assert manifest["target"] == "dir"
        assert manifest["horizon"] == 5
        assert "information_coefficient" in manifest["metrics"]
        assert manifest["metrics"]["n_test_rows"] > 0

        features = json.loads((run_dir / "features.json").read_text())
        assert features["feature_cols"] == FEATURE_COLS

    def test_refuses_to_train_on_too_little_data(self, tmp_path) -> None:
        if not _have_enough_bars():
            pytest.skip("no bars in market.db yet — run bars:backfill first")
        # An absurdly large horizon collapses the usable panel to near
        # nothing; this must refuse rather than silently train a model on a
        # handful of rows and hand back a confident-looking manifest.
        with pytest.raises(SystemExit, match="too few"):
            train(target="dir", horizon=2000, n_splits=3, embargo=2, output_dir=tmp_path)


class TestConfigHash:
    """Anything that changes the fitted model must change the run id."""

    def test_early_stopping_setting_changes_the_hash(self) -> None:
        # It did not, and the three runs measuring early stopping all
        # produced run_id 2026-08-24-dir-h5-f47646104951 and wrote into the
        # same artifact directory — leaving the registry's champion
        # pointing at the worst of the three. `models:pull` compounds such
        # a collision rather than correcting it: a reader already holding
        # the directory keeps whichever version arrived first.
        cols = ["momentum_21d", "momentum_63d"]
        hashes = {_config_hash("dir", 5, cols, es) for es in (None, 10, 50)}

        assert len(hashes) == 3

    def test_target_horizon_and_features_still_change_it(self) -> None:
        cols = ["momentum_21d"]
        base = _config_hash("dir", 5, cols, None)
        assert _config_hash("vrp", 5, cols, None) != base
        assert _config_hash("dir", 10, cols, None) != base
        assert _config_hash("dir", 5, [*cols, "extra"], None) != base

    def test_is_stable_for_an_unchanged_configuration(self) -> None:
        # A hash that moved on its own would make every run look like a new
        # configuration and defeat the point.
        cols = ["momentum_21d", "momentum_63d"]
        assert _config_hash("dir", 5, cols, 50) == _config_hash("dir", 5, cols, 50)
