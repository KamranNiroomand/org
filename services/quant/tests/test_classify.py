"""Classifier tests, built from real collisions found in this app's own
universe — see classify.py's module docstring for how they were found.
"""

from __future__ import annotations

from app.classify import SymbolRow, classify_universe, normalize_name


def test_flags_a_real_warrant_unit_pair_sharing_the_common_stocks_name() -> None:
    rows = [
        SymbolRow("AACI", "Armada Acquisition Corp. III Class A"),
        SymbolRow("AACIU", "Armada Acquisition Corp. III"),
        SymbolRow("AACIW", "Armada Acquisition Corp. III"),
    ]
    result = classify_universe(rows)
    assert result == {"AACIU": "unit", "AACIW": "warrant"}


def test_leaves_a_standalone_stock_alone_with_no_base_row_present() -> None:
    rows = [SymbolRow("GROW", "U.S. Global Investors, Inc. Class A")]
    assert classify_universe(rows) == {}


def test_does_not_flag_a_coincidental_ticker_collision_between_two_real_companies() -> None:
    # Stripping the trailing R off TKR lines up TK, but they are unrelated
    # companies — the real bug this module exists to avoid reintroducing.
    rows = [
        SymbolRow("TK", "Teekay Corporation Ltd."),
        SymbolRow("TKR", "Timken Company (The)"),
    ]
    assert classify_universe(rows) == {}


def test_matches_despite_a_share_class_suffix_difference() -> None:
    rows = [
        SymbolRow("BETR", "Better Home & Finance Holding Company Class A"),
        SymbolRow("BETRW", "Better Home & Finance Holding Company"),
    ]
    assert classify_universe(rows) == {"BETRW": "warrant"}


def test_ignores_hyphenated_share_class_symbols() -> None:
    # BRK-B must never be treated as a derivative of a "BRK-" base — the
    # hyphen marks a real share class, not a warrant/unit/right suffix.
    rows = [
        SymbolRow("BRK-A", "Berkshire Hathaway Inc. Class A"),
        SymbolRow("BRK-B", "Berkshire Hathaway Inc. Class B"),
    ]
    assert classify_universe(rows) == {}


def test_right_suffix_only_flagged_with_a_similar_named_base() -> None:
    rows = [
        SymbolRow("TVIV", "Texas Ventures Acquisition IV Corp Class A"),
        SymbolRow("TVIVU", "Texas Ventures Acquisition IV Corp"),
    ]
    assert classify_universe(rows) == {"TVIVU": "unit"}


def test_normalize_name_strips_class_and_corporate_boilerplate() -> None:
    assert normalize_name("Armada Acquisition Corp. III Class A") == normalize_name(
        "Armada Acquisition Corp. III"
    )


def test_normalize_name_does_not_collapse_genuinely_different_companies() -> None:
    assert normalize_name("Timken Company (The)") != normalize_name("Teekay Corporation Ltd.")


def test_empty_batch_returns_empty() -> None:
    assert classify_universe([]) == {}


def test_does_not_match_two_blank_names() -> None:
    # normalize_name("") == normalize_name("") would otherwise score 100% —
    # the exact false-positive a malformed or missing name field must not
    # produce, since the caller deletes an excluded symbol outright.
    rows = [SymbolRow("AB", ""), SymbolRow("ABW", "")]
    assert classify_universe(rows) == {}


def test_does_not_match_two_different_explicit_share_classes() -> None:
    # Two distinct real securities of the same company, not a warrant of
    # one and the common of the other — normalize_name alone would strip
    # both class markers and wrongly equate them.
    rows = [
        SymbolRow("ABC", "Example Holdco Inc. Class A"),
        SymbolRow("ABCW", "Example Holdco Inc. Class B"),
    ]
    assert classify_universe(rows) == {}


def test_similarity_threshold_is_overridable() -> None:
    rows = [
        SymbolRow("AB", "Roughly Similar Corp"),
        SymbolRow("ABW", "Roughly Similarish Corporation"),
    ]
    assert classify_universe(rows, similarity_threshold=101) == {}
    assert classify_universe(rows, similarity_threshold=50) == {"ABW": "warrant"}
