"""Research-grade quote screens — which captured prices are believable
enough to rank against.

This module exists because a $122,440 position was opened on a price that
was never real. SNDK's 2270-strike put printed an identical close
($1,224.40), identical volume (10) and identical open interest (107) on
every captured day, while its solved IV read 447% — a stale print carried
forward, not a market. Nothing in the pipeline questioned it, so it topped
the EV ranking, and the fix that had been assumed — a no-arbitrage bounds
check — would not have caught it: the price sits comfortably inside the
put's [K−S, K] = [$483, $2,270] band. Arbitrage bounds catch *impossible*
prices; this one was merely *fictional*. Measured against the whole
corpus, 40.4% of contracts with 3+ captured days have a completely frozen
close, so this is two-fifths of the data, not one bad row.

The screens follow the standard set the empirical options literature
applies to exactly this kind of daily close data (Cao & Han, Journal of
Financial Economics 2013, whose list is quoted above the constants below;
substantively the same set appears across the OptionMetrics-based
literature — Goyal & Saretto 2009, Boyer & Vorkink 2014, Bali,
Beckmeyer, Moerke & Weigert RFS 2023). Where they screen on bid/ask
fields this corpus does not have (no quote entitlement), the staleness
screen substitutes: unchanged close + unchanged volume across consecutive
captures is this data's observable symptom of the same underlying
condition — a price nobody is actually making.

Deliberately a *ranking* screen, not a capture filter: everything is still
stored. A screen that deleted rows would destroy the record of its own
false positives, and surface features (put/call ratios, term structure)
legitimately want the whole chain including strikes nobody would trade.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import polars as pl

#: Cao & Han (JFE 2013), quoted from the published paper: "We exclude the
#: following option observations: moneyness is lower than 0.8 or higher
#: than 1.2; option price violates obvious no-arbitrage option bounds;
#: reported option trading volume is zero; option bid quote is zero or
#: midpoint of bid and ask quotes is less than $1/8."
MONEYNESS_MIN = 0.8
MONEYNESS_MAX = 1.2
MIN_PRICE = 0.125  # the literature's $1/8 minimum, against our close
#: Above this solved IV, treat the print as unreliable regardless of how it
#: got there. 200%+ IV on a listed equity option is overwhelmingly a data
#: artifact at daily-close resolution (the SNDK print solved at 447%);
#: genuine triple-digit IV exists (biotech binaries, meme squeezes) but a
#: system with no intraday quotes cannot tell those apart from staleness,
#: and the cost of skipping a real one is far below the cost of ranking a
#: fictional one first.
MAX_IV = 2.0


@dataclass
class ScreenResult:
    """What survived, and an audit of what did not.

    The counts exist so a screen can never silently eat the board: the
    caller logs them, and a day where `stale` suddenly claims half the
    chain is visible instead of just producing a mysteriously thin ranking.

    `dropped_rows` carries the occ_symbols per reason so a rejection can be
    traced to a *contract*, not just a count — "why didn't it buy X?" must
    have an answer when X was screened out, and an aggregate count cannot
    give one. `staleness_ran` distinguishes "screened, nothing stale" from
    "could not screen" (no prior day for this chain), which the counts
    alone cannot express: review of the first version found the screen
    silently no-oping for exactly the symbols with the patchiest capture
    history, while the audit line looked normal.
    """

    passed: pl.DataFrame
    dropped: dict[str, int] = field(default_factory=dict)
    dropped_rows: dict[str, list[str]] = field(default_factory=dict)
    staleness_ran: bool = False


def screen_quotes(
    quotes: pl.DataFrame,
    prior_stats: pl.DataFrame | None = None,
    moneyness_min: float = MONEYNESS_MIN,
    moneyness_max: float = MONEYNESS_MAX,
    min_price: float = MIN_PRICE,
    max_iv: float = MAX_IV,
) -> ScreenResult:
    """Apply the literature's screens to one underlying's chain for one day.

    `prior_stats` is `db.read_day_stats(prior_day)` — the whole prior day's
    close/volume/open-interest, unfiltered by liquidity, joined here per
    contract. One unchanged day is deliberately enough — with no bid/ask to
    corroborate, a close that did not move while its volume or open
    interest also did not move has no evidence of being current, and the
    cost asymmetry (skipping a real-but-quiet contract for a day, versus
    ranking a fiction first) runs entirely one way. Pass `None` when no
    prior day exists; the staleness screen is then skipped, and
    `staleness_ran=False` says so rather than hiding it.

    Screens run in a fixed order and each row is attributed to the *first*
    screen that rejects it, so the audit counts sum to the rows dropped.
    """
    dropped: dict[str, int] = {}
    if quotes.height == 0:
        # An empty chain filtered on named columns raises if the frame also
        # has no schema — and there is nothing to screen anyway.
        return ScreenResult(passed=quotes, dropped=dropped)
    df = quotes

    dropped_rows: dict[str, list[str]] = {}

    def apply(name: str, keep: pl.Expr) -> None:
        nonlocal df
        removed = df.filter(~keep.fill_null(False))
        df = df.filter(keep.fill_null(False))
        if removed.height:
            dropped[name] = removed.height
            dropped_rows[name] = removed["occ_symbol"].to_list()

    # Rows with no price or no solved IV never had a basis for ranking.
    apply("no_price", pl.col("price").is_not_null() & (pl.col("price") > 0))
    apply("no_iv", pl.col("iv").is_not_null())

    # A zero or null spot must be named as its own failure, not laundered
    # through the moneyness arithmetic: strike/0 is inf, inf is outside any
    # band, and the audit would read "the whole chain was far OTM today"
    # when the truth is "the underlying had no price".
    apply("no_spot", pl.col("underlying_price").is_not_null() & (pl.col("underlying_price") > 0))

    # Cao & Han's screens, adapted to close-only data.
    apply(
        "moneyness",
        (pl.col("strike") / pl.col("underlying_price")).is_between(moneyness_min, moneyness_max),
    )
    apply("min_price", pl.col("price") >= min_price)
    apply("zero_volume", pl.col("volume") > 0)

    # Unbelievable IV — see MAX_IV's comment.
    apply("extreme_iv", pl.col("iv") <= max_iv)

    # No-arbitrage bounds. Kept even though the incident price passed them:
    # they are nearly free, and a hard violation is certainly bad data.
    # American options on a non-dividend screen: call within
    # [max(S-K, 0), S], put within [max(K-S, 0), K].
    #
    # The lower edge carries a 5% tolerance because `price` for the
    # no-quote contracts this corpus is full of is the day's *last trade*
    # while `underlying_price` is the *closing* spot. On a day the stock
    # rallies into the close, a deep-ITM call last traded at 11:00
    # legitimately prints below its 16:00 intrinsic — an artifact of
    # non-synchronous closes (the known OptionMetrics timing problem), not
    # bad data, and rejecting it would eat ITM contracts specifically on
    # the highest-move days. The gate's own below-intrinsic rule scopes
    # itself to two-sided quotes for exactly this reason.
    intrinsic_call = (pl.col("underlying_price") - pl.col("strike")).clip(lower_bound=0)
    intrinsic_put = (pl.col("strike") - pl.col("underlying_price")).clip(lower_bound=0)
    call_ok = (pl.col("price") >= intrinsic_call * 0.95) & (pl.col("price") <= pl.col("underlying_price"))
    put_ok = (pl.col("price") >= intrinsic_put * 0.95) & (pl.col("price") <= pl.col("strike"))
    apply(
        "arbitrage_bounds",
        pl.when(pl.col("type") == "call").then(call_ok).otherwise(put_ok),
    )

    # Staleness — this corpus's substitute for the bid-based screens, and
    # the one that actually catches the incident.
    #
    # Compared on **close**, not the mid-falling-back-to-close `price`
    # column: the claim being tested is "this end-of-day print never
    # moved", and `price` silently changes meaning per row depending on
    # whether a two-sided quote existed. Stale means close unchanged AND at
    # least one of volume / open interest also unchanged — the incident had
    # all three frozen, and requiring close+volume alone let its nearest
    # neighbour through (a vendor that jitters reconstructed volume while
    # carrying the close forward). A genuinely pinned-but-trading contract
    # moves both volume and OI day to day, and survives.
    staleness_ran = False
    if prior_stats is not None and prior_stats.height > 0 and df.height > 0:
        staleness_ran = True
        # Deduped locally rather than trusting the caller: option_quotes is
        # append-only on (occ_symbol, as_of), a recaptured day really does
        # hold duplicate rows, and a duplicate here fans the left join out —
        # a frozen contract survives because one duplicate differs, the
        # audit counts a drop that corresponds to no contract, and in the
        # mirror case one contract reaches the board twice.
        prior = prior_stats.unique(subset=["occ_symbol"], keep="first").select(
            pl.col("occ_symbol"),
            pl.col("close").alias("_prior_close"),
            pl.col("volume").alias("_prior_volume"),
            pl.col("open_interest").alias("_prior_oi"),
        )
        df = df.join(prior, on="occ_symbol", how="left")
        stale = (
            pl.col("_prior_close").is_not_null()
            & (pl.col("close") == pl.col("_prior_close"))
            & (
                (pl.col("volume") == pl.col("_prior_volume"))
                | (pl.col("open_interest") == pl.col("_prior_oi"))
            )
        )
        removed = df.filter(stale.fill_null(False))
        df = df.filter(~stale.fill_null(False))
        if removed.height:
            dropped["stale_price"] = removed.height
            dropped_rows["stale_price"] = removed["occ_symbol"].to_list()
        df = df.drop(["_prior_close", "_prior_volume", "_prior_oi"])

    return ScreenResult(
        passed=df, dropped=dropped, dropped_rows=dropped_rows, staleness_ran=staleness_ran
    )
