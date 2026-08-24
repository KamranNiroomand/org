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
#:
#: Their fixed 0.8–1.2 band selected near-ATM ~45-day options for a study
#: universe; review showed a fixed band applied across this system's whole
#: 14–60 DTE, 4%–80% vol universe gets it backwards at both ends. In
#: standardized terms — |ln(K/S)| / (σ√T), distance from ATM measured in
#: the underlying's own volatility units — their band is ≈1.7σ for a
#: typical 30%-vol name at 45 days. A 55%-IV biotech's sensible directional
#: strikes at K/S ≈ 1.3 sit *inside* 1.7σ but were hard-dropped by the raw
#: band, silently emptying the underlying from the board; IEF at 4% vol
#: listed 20σ+ strikes with no economic content that the raw band happily
#: admitted. So the band is standardized at 2.0σ.
#:
#: The σ reference is max(caller's HAR realized-vol forecast, the chain's
#: own ATM implied vol) — see `screen_quotes` for why the max of the two
#: and why the ATM sample is guarded. When neither exists — or the caller
#: passed no `trading_day`, so time-to-expiry cannot be computed — the
#: screen degrades to the literature's flat 0.8–1.2 band rather than to
#: nothing: review of the first version found the degraded path admitted
#: the exact $122,440 incident print, because degrading meant "skip the
#: screen" instead of "fall back to the conservative one".
STANDARDIZED_MONEYNESS_MAX = 2.0
LITERATURE_MONEYNESS_MIN = 0.8
LITERATURE_MONEYNESS_MAX = 1.2
MIN_PRICE = 0.125  # the literature's $1/8 minimum, against our close
#: The unbelievable-IV ceiling, in **total volatility** σ√T rather than
#: annualized σ. A flat annualized ceiling bites hardest at the short end,
#: where genuinely-priced event vol is mechanically highest: 250% IV two
#: weeks before earnings is a real market (σ√T ≈ 0.49), while the SNDK
#: stale print's 447% at 28 days is σ√T ≈ 1.24 — no listed equity option
#: prices a ±124% one-sigma move over a month. 0.75 separates the two
#: populations the flat ceiling conflated.
#:
#: The scaled ceiling is **floored at the flat `MAX_IV_FLAT`** it
#: replaced: σ√T ≤ 0.75 alone crosses below the old 2.0 ceiling at ~51
#: DTE (1.85 at 60 days), which would have silently *tightened* the long
#: end of the universe while the change was only ever argued as a
#: short-end loosening. So a row passes when either its total vol is
#: believable or its annualized vol was believable under the old regime.
#: The deliberate residual: between roughly 14 and 51 DTE the effective
#: ceiling sits above the old flat 2.0 (3.83 at 14 days, 2.71 at 28), so
#: a stale print solving just under it clears this screen — the staleness
#: screen, not this one, is the defense there, which is why rank_day
#: audits `stale_screen_unavailable_symbols` so loudly.
MAX_TOTAL_VOL = 0.75
MAX_IV_FLAT = 2.0
#: Absolute insanity rail, applied even where the scaled ceiling is
#: generous (it reaches 8.27 at 3 DTE, where score_held_contracts — which
#: has no DTE floor — still prices held positions). No listed equity
#: option prices a 500% annualized vol as anything but noise.
MAX_IV_ABSOLUTE = 5.0


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
    history, while the audit line looked normal. `vol_screens_ran` makes
    the same distinction for the vol-aware screens: False means no
    `trading_day` was supplied, so moneyness and the IV ceiling ran in
    their flat, pre-standardization form rather than the σ-scaled one.
    """

    passed: pl.DataFrame
    dropped: dict[str, int] = field(default_factory=dict)
    dropped_rows: dict[str, list[str]] = field(default_factory=dict)
    staleness_ran: bool = False
    vol_screens_ran: bool = False


def screen_quotes(
    quotes: pl.DataFrame,
    prior_stats: pl.DataFrame | None = None,
    trading_day: str | None = None,
    symbol_vol: float | None = None,
    standardized_max: float = STANDARDIZED_MONEYNESS_MAX,
    min_price: float = MIN_PRICE,
    max_total_vol: float = MAX_TOTAL_VOL,
    max_iv_absolute: float = MAX_IV_ABSOLUTE,
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

    `trading_day` gates the σ-scaled forms of the moneyness and IV-ceiling
    screens (√T is uncomputable without it). Omitting it does **not** skip
    them — they degrade to the literature's flat band and the flat ceiling,
    the exact protections that predate standardization — and
    `vol_screens_ran=False` reports the degradation. Production callers
    should always pass it.

    Screens run in a fixed order and each row is attributed to the *first*
    screen that rejects it, so the audit counts sum to the rows dropped.
    """
    dropped: dict[str, int] = {}
    if quotes.height == 0:
        # An empty chain filtered on named columns raises if the frame also
        # has no schema — and there is nothing to screen anyway.
        return ScreenResult(passed=quotes, dropped=dropped, vol_screens_ran=trading_day is not None)
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

    # Years to expiry, calendar-day convention (the same 365 denominator
    # pricing.py uses; the clip to one day exists only here, to keep √T
    # nonzero for a same-day expiry). Parsed non-strictly: `expiry` is
    # vendor text, and a strict parse would abort the *entire* ranking
    # run on one malformed string — review found exactly that, an
    # InvalidOperationError raising out of rank_day's symbol loop. A row
    # whose expiry does not parse is instead dropped under its own name,
    # for the same reason no_spot exists: a null threaded silently into
    # the moneyness arithmetic would attribute the drop to "moneyness"
    # when the truth is "the contract had no usable expiry".
    years = None
    if trading_day is not None:
        expiry_date = pl.col("expiry").str.to_date(strict=False)
        apply("bad_expiry", expiry_date.is_not_null())
        years = (
            (expiry_date - pl.lit(trading_day).str.to_date()).dt.total_days().clip(lower_bound=1)
            / 365.0
        )

    # Moneyness — distance from ATM, standardized to the underlying's own
    # volatility units when σ√T is computable, the literature's flat
    # 0.8–1.2 band otherwise. See the constants block for why a fixed
    # band gets a mixed-vol universe backwards at both ends, and why the
    # degraded path is the conservative flat band rather than nothing.
    #
    # σ is max(caller's HAR forecast, the chain's ATM implied vol):
    #
    # - The HAR forecast alone is a *realized*-vol floor, and under the
    #   variance risk premium RV runs below IV in the normal state — a
    #   55%-IV biotech with 32% trailing RV would see the band the
    #   constants block promises it at ≈1.3σ instead applied at ≈3σ,
    #   tightest exactly when a name is quiet before an event. The
    #   market's own ATM vol is the standard reference for standardized
    #   moneyness in the literature; the HAR floor guards the mirror case
    #   where the chain's IVs are junk-low.
    # - The ATM sample is the fixed 0.8–1.2 band with IVs above
    #   MAX_IV_FLAT excluded — never the row's own IV, and never a median
    #   over the whole chain: review showed three stale 400%+ prints
    #   moving a whole-chain median from 0.60 to 4.40, widening the band
    #   until an economically empty 7.7σ strike passed. A frozen 447%
    #   print cannot enter this reference at all.
    if years is not None:
        atm = df.filter(
            (pl.col("strike") / pl.col("underlying_price")).is_between(
                LITERATURE_MONEYNESS_MIN, LITERATURE_MONEYNESS_MAX
            )
            & (pl.col("iv") <= MAX_IV_FLAT)
        )
        atm_iv = float(atm["iv"].median()) if atm.height > 0 else 0.0
        sigma = max(symbol_vol or 0.0, atm_iv)
        if sigma > 0:
            std_moneyness = (pl.col("strike") / pl.col("underlying_price")).log().abs() / (
                sigma * years.sqrt()
            )
            apply("moneyness", std_moneyness <= standardized_max)
        else:
            apply(
                "moneyness",
                (pl.col("strike") / pl.col("underlying_price")).is_between(
                    LITERATURE_MONEYNESS_MIN, LITERATURE_MONEYNESS_MAX
                ),
            )
    else:
        apply(
            "moneyness",
            (pl.col("strike") / pl.col("underlying_price")).is_between(
                LITERATURE_MONEYNESS_MIN, LITERATURE_MONEYNESS_MAX
            ),
        )

    apply("min_price", pl.col("price") >= min_price)
    apply("zero_volume", pl.col("volume") > 0)

    # Unbelievable IV. With a computable √T: the absolute insanity rail,
    # then the total-vol ceiling floored at the flat ceiling it replaced —
    # see MAX_TOTAL_VOL's comment for both regimes. Without one, the flat
    # pre-standardization ceiling, so the degraded path never admits what
    # the old code rejected.
    if years is not None:
        apply("extreme_iv", pl.col("iv") <= max_iv_absolute)
        apply(
            "extreme_total_vol",
            (pl.col("iv") * years.sqrt() <= max_total_vol) | (pl.col("iv") <= MAX_IV_FLAT),
        )
    else:
        apply("extreme_iv", pl.col("iv") <= MAX_IV_FLAT)

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
        passed=df,
        dropped=dropped,
        dropped_rows=dropped_rows,
        staleness_ran=staleness_ran,
        vol_screens_ran=trading_day is not None,
    )
