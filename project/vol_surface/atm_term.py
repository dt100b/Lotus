"""Current forward-ATM curve, with local checks independent of distant wings.

Interpolate mark total variance in log-forward moneyness between the closest
supported OTM strikes, then in time. No nearest-strike or maturity extrapolation.
This is a descriptive ATM estimator, not certification of a complete surface.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict
import math
from statistics import median
from typing import Any, Mapping, Sequence

import numpy as np
from scipy.stats import norm

from greeks.types import GreekSnapshot
from normalizer.instruments import parse_deribit_option_instrument_name
from vol_surface.surface import quotes_from_greeks, settle_ts_ms, MAX_FORWARD_DISPERSION, MAX_QUOTE_AGE_MS, YEAR_SECONDS
from vol_surface.atm_diagnostics import midpoint_diagnostic

VERSION = "atm_term_curve.v1"
FILENAME = "atm_term_curve.json"
TENORS = (("1d",1), ("7d",7), ("30d",30), ("60d",60), ("90d",90), ("180d",180), ("365d",365))
MAX_ATM_SIDE_DISTANCE = .025
MAX_CAPTURE_SKEW_MS = 60_000


def select_atm_instruments(rows: Sequence[Mapping[str, Any]]) -> list[str]:
    """Discover near-ATM candidates across the chain, independently of inventory."""
    groups: dict[tuple[int,str], list[tuple[float,str]]] = defaultdict(list)
    for row in rows:
        name = str(row.get("instrument_name") or "")
        parsed = parse_deribit_option_instrument_name(name)
        try:
            forward = float(row.get("underlying_price") or 0)
        except (TypeError, ValueError):
            continue
        if parsed is None or parsed.underlying != "BTC" or not math.isfinite(forward) or forward <= 0:
            continue
        k = math.log(float(parsed.strike)/forward)
        if (k < 0 and parsed.option_type != "put") or (k > 0 and parsed.option_type != "call"):
            continue
        groups[(parsed.expiry_ts_ms, parsed.option_type)].append((abs(k),name))
    return sorted({name for group in groups.values() for _,name in sorted(group)[:6]})


def build_atm_term_curve(greeks: Mapping[str, GreekSnapshot], *, as_of_ms: int) -> dict[str, Any]:
    accepted = quotes_from_greeks(greeks, as_of_ms=as_of_ms)
    snapshots = {}
    for snapshot in greeks.values():
        parsed = parse_deribit_option_instrument_name(snapshot.instrument_name)
        if parsed:
            snapshots[(snapshot.expiration_timestamp or settle_ts_ms(parsed.expiry_ts_ms),
                       float(parsed.strike), parsed.option_type)] = snapshot
    groups: dict[int,list] = defaultdict(list)
    for snapshot in greeks.values():
        parsed = parse_deribit_option_instrument_name(snapshot.instrument_name)
        if parsed is not None and parsed.underlying == "BTC":
            groups[snapshot.expiration_timestamp or settle_ts_ms(parsed.expiry_ts_ms)]
    for quote in accepted:
        groups[quote.expiry_ts_ms].append(quote)
    listed = []
    stamps: list[int] = []
    for expiry, quotes in sorted(groups.items()):
        t = (expiry-as_of_ms)/(YEAR_SECONDS*1000)
        if t <= 60/YEAR_SECONDS:
            continue
        row: dict[str,Any] = {"expiry_ts_ms":expiry,"dte_days":t*365,"status":"unavailable"}
        # Wings must not change either the local forward or its validity.
        quotes = [q for q in quotes if abs(math.log(q.strike/q.forward_usd)) <= MAX_ATM_SIDE_DISTANCE]
        if not quotes:
            row["validation_reasons"] = ["no_valid_near_atm_quotes"]
            listed.append(row)
            continue
        forward = median(q.forward_usd for q in quotes)
        reason = None
        if max(abs(q.forward_usd/forward-1) for q in quotes) > MAX_FORWARD_DISPERSION:
            reason = "inconsistent_forward"
        knots: dict[float,list[float]] = defaultdict(list)
        inputs: dict[float,list[GreekSnapshot]] = defaultdict(list)
        for q in quotes:
            k = math.log(q.strike/forward)
            if k == 0 or (k < 0 and q.option_type == "put") or (k > 0 and q.option_type == "call"):
                knots[k].append(q.mark_iv**2*t)
                inputs[k].append(snapshots[(expiry,q.strike,q.option_type)])
        lower = max((k for k in knots if k <= 0),default=None)
        upper = min((k for k in knots if k >= 0),default=None)
        if lower is None or upper is None:
            reason = reason or "atm_not_bracketed"
        elif max(abs(lower),abs(upper)) > MAX_ATM_SIDE_DISTANCE:
            reason = reason or "atm_strikes_too_distant"
        if reason is None:
            used = [s for k in {lower,upper} for s in inputs[k]]
            used_stamps = [s.snapshot_ts for s in used]
            if max(used_stamps)-min(used_stamps) > MAX_CAPTURE_SKEW_MS:
                reason = "asynchronous_atm_quotes"
        if reason is None:
            a,b = median(knots[lower]),median(knots[upper])
            weight = 0 if lower == upper else -lower/(upper-lower)
            w = a+weight*(b-a)
            # Validate the local interpolant in normalized Black call prices.
            if lower != upper:
                x = np.linspace(math.exp(lower),math.exp(upper),129)
                ws = a+(np.log(x)-lower)/(upper-lower)*(b-a)
                d1 = (-np.log(x)+ws/2)/np.sqrt(ws)
                calls = norm.cdf(d1)-x*norm.cdf(d1-np.sqrt(ws))
                slopes = np.diff(calls)/np.diff(x)
                if (np.any(calls < np.maximum(1-x,0)-1e-9) or np.any(calls > 1+1e-9)
                        or np.any(slopes < -1-1e-7) or np.any(slopes > 1e-7)
                        or np.any(np.diff(slopes)/((np.diff(x)[:-1]+np.diff(x)[1:])/2) < -1e-5)):
                    reason = "local_atm_price_checks_failed"
            if reason is None:
                row.update(status="ok",atm_iv_percent=math.sqrt(w/t)*100,total_variance=w,
                           forward_usd=forward,lower_strike=forward*math.exp(lower),
                           upper_strike=forward*math.exp(upper),quote_count=len(used),
                           oldest_quote_ts_ms=min(used_stamps),newest_quote_ts_ms=max(used_stamps),
                           source_quotes=[asdict(s) for s in used])
                stamps.extend(used_stamps)
                for field, output in (("bid_iv","bid"),("ask_iv","ask")):
                    lo = median((getattr(s,field)/100)**2*t for s in inputs[lower])
                    hi = median((getattr(s,field)/100)**2*t for s in inputs[upper])
                    variance = lo+weight*(hi-lo)
                    row[f"{output}_total_variance"] = variance
                    row[f"atm_{output}_iv_percent"] = math.sqrt(variance/t)*100
                mids = {}
                mid_reasons = set()
                for k in {lower,upper}:
                    values = []
                    for s in inputs[k]:
                        parsed = parse_deribit_option_instrument_name(s.instrument_name)
                        mid, why = midpoint_diagnostic(s,strike=float(parsed.strike),expiry=expiry,side=parsed.option_type)
                        if why:
                            mid_reasons.add(why)
                        elif mid is not None:
                            values.append(mid**2*t)
                    if len(values) == len(inputs[k]):
                        mids[k] = median(values)
                row["midpoint_validation_reasons"] = sorted(mid_reasons)
                if not mid_reasons and lower in mids and upper in mids:
                    mid_w = mids[lower]+weight*(mids[upper]-mids[lower])
                    row.update(mid_total_variance=mid_w,atm_mid_iv_percent=math.sqrt(mid_w/t)*100,
                               mark_minus_mid_vol_points=(math.sqrt(w/t)-math.sqrt(mid_w/t))*100)
        row["validation_reasons"] = [reason] if reason else []
        listed.append(row)

    tenors = []
    for name,days in TENORS:
        row = {"tenor":name,"target_days":days,"status":"unavailable","calendar_ok":None}
        # Do not skip an unavailable immediate expiry to manufacture a wider bracket.
        left = max((r for r in listed if r["dte_days"] <= days),key=lambda r:r["dte_days"],default=None)
        right = min((r for r in listed if r["dte_days"] >= days),key=lambda r:r["dte_days"],default=None)
        reason = None
        if left is None or right is None:
            reason = "no_maturity_bracket"
        elif left["status"] != "ok" or right["status"] != "ok":
            reason = "source_atm_unavailable"
        elif (max(left["newest_quote_ts_ms"],right["newest_quote_ts_ms"])
              - min(left["oldest_quote_ts_ms"],right["oldest_quote_ts_ms"]) > MAX_CAPTURE_SKEW_MS):
            reason = "asynchronous_atm_quotes"
        elif right["total_variance"]+1e-10 < left["total_variance"]:
            reason = "atm_calendar_rejected"
            row["calendar_ok"] = False
        elif any(
            a["status"] == "ok" and b["status"] == "ok"
            and b["total_variance"]+1e-10 < a["total_variance"]
            for a,b in zip(listed,listed[1:]) if a is left or b is left or a is right or b is right
        ):
            reason = "atm_calendar_rejected"
            row["calendar_ok"] = False
        else:
            weight = 0 if left is right else (days-left["dte_days"])/(right["dte_days"]-left["dte_days"])
            w = left["total_variance"]+weight*(right["total_variance"]-left["total_variance"])
            row.update(status="ok",calendar_ok=True,atm_iv_percent=math.sqrt(w/(days/365))*100,
                       method="exact_expiry" if left is right else "atm_total_variance_interpolation",
                       lower_expiry_ts_ms=left["expiry_ts_ms"],upper_expiry_ts_ms=right["expiry_ts_ms"],
                       lower_dte_days=left["dte_days"],upper_dte_days=right["dte_days"],
                       interpolation_weight=weight)
            for source in ("bid","ask","mid"):
                key = f"{source}_total_variance"
                if key not in left or key not in right:
                    if source == "mid":
                        row["midpoint_validation_reasons"] = sorted(set(
                            left.get("midpoint_validation_reasons",[]) + right.get("midpoint_validation_reasons",[])))
                    continue
                if source == "mid" and (right[key]+1e-10 < left[key] or any(
                    key in a and key in b and b[key]+1e-10 < a[key]
                    for a,b in zip(listed,listed[1:]) if a is left or b is left or a is right or b is right
                )):
                    row["midpoint_validation_reasons"] = ["midpoint_calendar_rejected"]
                    continue
                variance = left[key]+weight*(right[key]-left[key])
                row[f"atm_{source}_iv_percent"] = math.sqrt(variance/(days/365))*100
            if "atm_mid_iv_percent" in row:
                row["mark_minus_mid_vol_points"] = row["atm_iv_percent"]-row["atm_mid_iv_percent"]
        row["validation_reasons"] = [reason] if reason else []
        tenors.append(row)
    return {"version":VERSION,"as_of_ms":as_of_ms,"term_structure":tenors,"listed_expiries":listed,
            "valid_until_ms":min(stamps)+MAX_QUOTE_AGE_MS if stamps else as_of_ms,
            "oldest_quote_ts_ms":min(stamps) if stamps else None,
            "newest_quote_ts_ms":max(stamps) if stamps else None,
            "quote_count":len(greeks),"accepted_quote_count":len(accepted),"day_count":"ACT/365",
            "iv_source":"deribit_mark_iv", "diagnostics_version":"atm_diagnostics.v1",
            "uncertainty_scope":"same-bracket bid/ask IV estimates; not executable or statistical confidence bounds",
            "midpoint_method":"BTC inverse normalized Black; ticker-time inversion; bid/ask repricing tolerance 0.5 vol points",
            "atm_definition":"K=forward; local total-variance interpolation",
            "validation_scope":"fresh two-sided quotes, local ATM price checks, ATM calendar only",
            "source":"Deribit full-chain near-ATM tickers; independent of dealer inventory"}
