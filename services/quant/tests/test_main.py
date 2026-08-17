"""API tests. The contract these pin is that a refusal survives the wire.

An unidentifiable implied vol must arrive at the caller as null with a reason,
not as a zero, not as an error, and not as a plausible-looking number. Every
guarantee in `pricing.py` is worthless if serialization quietly launders it.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures" / "options"
NVDA = json.loads((FIXTURES / "nvda-chain.json").read_text())
YEARS_2D = 2 / 365


def test_health() -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_prices_a_real_chain() -> None:
    rows = [
        {
            "key": f"K{row['strike']}",
            "price": (row["bid"] + row["ask"]) / 2,
            "spot": NVDA["spot"],
            "strike": row["strike"],
            "years": YEARS_2D,
            "rate": NVDA["assumedRate"],
            "div_yield": NVDA["assumedDividendYield"],
            "is_call": True,
        }
        for row in NVDA["rows"]
    ]
    r = client.post("/price", json={"rows": rows})
    assert r.status_code == 200

    results = {x["key"]: x for x in r.json()["results"]}
    assert len(results) == len(NVDA["rows"])

    for row in NVDA["rows"]:
        got = results[f"K{row['strike']}"]
        assert got["iv_bps"] is not None
        # Within 200 basis points of the broker's published vol.
        assert abs(got["iv_bps"] - round(row["iv"] * 10_000)) < 200
        assert got["delta"] == abs(got["delta"])  # calls have positive delta


def test_refusal_survives_serialization() -> None:
    """The $390 penny row must come back null, not zero and not 435%."""
    r = client.post(
        "/price",
        json={
            "rows": [
                {
                    "key": "penny",
                    "price": 0.005,
                    "spot": 225.05,
                    "strike": 390.0,
                    "years": YEARS_2D,
                    "rate": 0.0425,
                    "is_call": True,
                }
            ]
        },
    )
    got = r.json()["results"][0]
    assert got["iv_bps"] is None
    assert got["delta"] is None
    assert got["skipped"] == "unidentified-vol"


def test_theoretical_round_trips_against_the_solver() -> None:
    body = {
        "spot": 225.05,
        "strike": 227.5,
        "years": 0.25,
        "rate": 0.0425,
        "div_yield": 0.0,
        "vol": 0.32,
        "is_call": True,
    }
    priced = client.post("/theoretical", json=body).json()
    back = client.post(
        "/price",
        json={
            "rows": [
                {
                    "key": "rt",
                    "price": priced["price"],
                    **{k: v for k, v in body.items() if k != "vol"},
                }
            ]
        },
    ).json()["results"][0]
    assert back["iv_bps"] == 3200
