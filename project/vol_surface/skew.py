"""Descriptive constant-delta skew from local, validated quote brackets.

Listed wing IV solves Black forward delta on a linear total-variance segment in
log(K/F). Tenors interpolate each wing's total variance at fixed absolute delta.
This is NOT a fitted full smile or a global arbitrage-free surface. ATM uses the
independent forward-ATM estimator. No strike/maturity extrapolation or DVOL fill.
"""
from collections import defaultdict
from dataclasses import asdict
import math
from statistics import median

import numpy as np
from scipy.optimize import brentq
from scipy.stats import norm

from vol_surface.atm_term import build_atm_term_curve, select_atm_instruments, MAX_CAPTURE_SKEW_MS
from vol_surface.surface import quotes_from_greeks, YEAR_SECONDS, MAX_FORWARD_DISPERSION, MAX_QUOTE_AGE_MS, settle_ts_ms
from normalizer.instruments import parse_deribit_option_instrument_name

VERSION = "local_delta_skew.v1"
TENORS = (("7d", 7), ("30d", 30), ("60d", 60), ("90d", 90), ("180d", 180))
MAX_DELTA_SPAN = .20


def abs_delta(k, variance, side):
    d1 = (-k + variance/2)/math.sqrt(variance)
    return float(norm.cdf(d1 if side == "call" else -d1))


def select_skew_instruments(rows, *, as_of_ms):
    """Summary marks select candidates only; actual tickers supply all inputs."""
    names = set(select_atm_instruments(rows))
    groups = defaultdict(list)
    for row in rows:
        name = str(row.get("instrument_name") or "")
        parsed = parse_deribit_option_instrument_name(name)
        if parsed is None or parsed.underlying != "BTC":
            continue
        try:
            t = (settle_ts_ms(parsed.expiry_ts_ms)-as_of_ms)/(YEAR_SECONDS*1000)
            f, iv = float(row["underlying_price"]), float(row["mark_iv"])/100
            if not all(math.isfinite(v) and v > 0 for v in (t, f, iv)):
                continue
            k = math.log(float(parsed.strike)/f)
            if (k < 0 and parsed.option_type != "put") or (k > 0 and parsed.option_type != "call"):
                continue
            groups[(parsed.expiry_ts_ms, parsed.option_type)].append((abs_delta(k, iv*iv*t, parsed.option_type), name))
        except (KeyError, ValueError, TypeError):
            continue
    for points in groups.values():
        for target in (.25, .10):
            # Three candidates on each side tolerate a bad book at the closest
            # strike without fetching every far wing in the exchange chain.
            for subset in ([p for p in points if p[0] <= target], [p for p in points if p[0] >= target]):
                names.update(n for _, n in sorted(subset, key=lambda p: abs(p[0]-target))[:3])
    return sorted(names)


def _local_wing(quotes, snapshots, *, t, forward, side, target):
    points = sorted((math.log(q.strike/forward), q) for q in quotes
                    if q.option_type == side and ((side == "put" and q.strike <= forward)
                                                  or (side == "call" and q.strike >= forward)))
    brackets = []
    for (ka, a), (kb, b) in zip(points, points[1:]):
        da, db = abs_delta(ka, a.mark_iv**2*t, side), abs_delta(kb, b.mark_iv**2*t, side)
        if min(da, db) <= target <= max(da, db):
            brackets.append((ka, a, kb, b, da, db))
    if not brackets:
        return {"status": "unavailable", "reason": "delta_not_bracketed"}
    # Adjacent brackets can share an exact root; otherwise multiple roots signal
    # a nonmonotonic local delta map and must not be chosen opportunistically.
    if len(brackets) > 1:
        shared_exact_root = (len(brackets) == 2 and brackets[0][2] == brackets[1][0]
                             and abs(brackets[0][5]-target) < 1e-10)
        if not shared_exact_root:
            return {"status": "unavailable", "reason": "ambiguous_delta_root"}
    ka, a, kb, b, da, db = min(brackets, key=lambda r: r[2]-r[0])
    if kb <= ka or abs(db-da) > MAX_DELTA_SPAN:
        return {"status": "unavailable", "reason": "delta_bracket_too_wide"}
    used = [snapshots[(q.expiry_ts_ms, q.strike, q.option_type)] for q in (a, b)]
    stamps = [q.snapshot_ts for q in used]
    if max(stamps)-min(stamps) > MAX_CAPTURE_SKEW_MS:
        return {"status": "unavailable", "reason": "asynchronous_quotes"}
    wa, wb = a.mark_iv**2*t, b.mark_iv**2*t
    variance = lambda k: wa+(k-ka)/(kb-ka)*(wb-wa)
    x = np.linspace(math.exp(ka), math.exp(kb), 129)
    ws = variance(np.log(x))
    d1 = (-np.log(x)+ws/2)/np.sqrt(ws)
    calls = norm.cdf(d1)-x*norm.cdf(d1-np.sqrt(ws))
    slopes = np.diff(calls)/np.diff(x)
    if (np.any(calls < np.maximum(1-x, 0)-1e-9) or np.any(calls > 1+1e-9)
            or np.any(slopes < -1-1e-7) or np.any(slopes > 1e-7)
            or np.any(np.diff(slopes)/((np.diff(x)[:-1]+np.diff(x)[1:])/2) < -1e-5)):
        return {"status": "unavailable", "reason": "local_wing_price_checks_failed"}
    deltas = norm.cdf(d1 if side == "call" else -d1)
    if np.any(np.diff(deltas)*(1 if side == "call" else -1) > 1e-9):
        return {"status": "unavailable", "reason": "nonmonotonic_delta"}
    root = brentq(lambda k: abs_delta(k, variance(k), side)-target, ka, kb)
    w = variance(root)
    return {"status": "ok", "iv_percent": math.sqrt(w/t)*100, "total_variance": w,
            "strike": forward*math.exp(root), "forward_usd": forward,
            "lower_strike": a.strike, "upper_strike": b.strike,
            "oldest_quote_ts_ms": min(stamps), "newest_quote_ts_ms": max(stamps),
            "source_instruments": [q.instrument_name for q in used]}


def build_skew_snapshot(greeks, *, as_of_ms):
    atm = build_atm_term_curve(greeks, as_of_ms=as_of_ms)
    accepted = quotes_from_greeks(greeks, as_of_ms=as_of_ms)
    groups = defaultdict(list)
    for q in accepted:
        groups[q.expiry_ts_ms].append(q)
    snapshots = {}
    for s in greeks.values():
        p = parse_deribit_option_instrument_name(s.instrument_name)
        if p:
            snapshots[(s.expiration_timestamp or settle_ts_ms(p.expiry_ts_ms), float(p.strike), p.option_type)] = s
    listed = []
    for source in atm["listed_expiries"]:
        expiry = source["expiry_ts_ms"]
        t = source["dte_days"]/365
        quotes = groups[expiry]
        f = median(q.forward_usd for q in quotes) if quotes else None
        reason = "no_valid_quotes" if f is None else (
            "inconsistent_forward" if max(abs(q.forward_usd/f-1) for q in quotes) > MAX_FORWARD_DISPERSION else None)
        wings = {}
        for label, target in (("25", .25), ("10", .10)):
            for side in ("put", "call"):
                wings[f"{side}_{label}"] = ({"status": "unavailable", "reason": reason} if reason else
                    _local_wing(quotes, snapshots, t=t, forward=f, side=side, target=target))
        listed.append({"expiry_ts_ms": expiry, "dte_days": source["dte_days"], "wings": wings})
    tenors, all_stamps = [], []
    for name, days in TENORS:
        atm_row = next(r for r in atm["term_structure"] if r["tenor"] == name)
        left = max((r for r in listed if r["dte_days"] <= days), key=lambda r:r["dte_days"], default=None)
        right = min((r for r in listed if r["dte_days"] >= days), key=lambda r:r["dte_days"], default=None)
        row = {"tenor": name, "target_days": days, "status": "unavailable",
               "method": "fixed_delta_total_variance_interpolation", "validation_reasons": [], "metric_reasons": {}}
        if left is not None and right is not None:
            weight = 0 if left is right else (days-left["dte_days"])/(right["dte_days"]-left["dte_days"])
            row.update(lower_expiry_ts_ms=left["expiry_ts_ms"], upper_expiry_ts_ms=right["expiry_ts_ms"],
                       lower_dte_days=left["dte_days"], upper_dte_days=right["dte_days"], interpolation_weight=weight)
        for label in ("25", "10"):
            reasons, used_stamps, values = [], [], {}
            if left is None or right is None:
                reasons.append("no_maturity_bracket")
            else:
                for side in ("put", "call"):
                    a, b = left["wings"][f"{side}_{label}"], right["wings"][f"{side}_{label}"]
                    if a["status"] != "ok" or b["status"] != "ok":
                        reasons.extend(f"{side}_{s['reason']}" for s in (a,b) if s["status"] != "ok")
                        continue
                    w = a["total_variance"]+weight*(b["total_variance"]-a["total_variance"])
                    values[side] = math.sqrt(w/(days/365))*100
                    used_stamps.extend(s[k] for s in (a,b) for k in ("oldest_quote_ts_ms", "newest_quote_ts_ms"))
                if used_stamps and max(used_stamps)-min(used_stamps) > MAX_CAPTURE_SKEW_MS:
                    reasons.append("asynchronous_quotes")
            if not reasons:
                # Raw RR is available independently of the ATM normalization.
                row[f"rr_{label}_vol_points"] = values["put"]-values["call"]
                row[f"put_{label}_iv_percent"], row[f"call_{label}_iv_percent"] = values["put"], values["call"]
                if atm_row["status"] != "ok":
                    reasons.append("normalization_atm_unavailable")
                else:
                    atm_sources = [r for r in atm["listed_expiries"] if r["expiry_ts_ms"] in
                                   (atm_row["lower_expiry_ts_ms"], atm_row["upper_expiry_ts_ms"])]
                    used_stamps.extend(r[k] for r in atm_sources for k in ("oldest_quote_ts_ms", "newest_quote_ts_ms"))
                    if max(used_stamps)-min(used_stamps) > MAX_CAPTURE_SKEW_MS:
                        reasons.append("asynchronous_quotes")
                    else:
                        row["atm_iv_percent"] = atm_row["atm_iv_percent"]
                        row[f"skew_{label}_normalized"] = row[f"rr_{label}_vol_points"]/atm_row["atm_iv_percent"]
                        all_stamps.extend(used_stamps)
            row["metric_reasons"][f"skew_{label}"] = sorted(set(reasons))
        row["validation_reasons"] = row["metric_reasons"]["skew_25"]
        if not row["validation_reasons"]:
            row["status"] = "ok"
        row["metric_reasons"]["tail_gap"] = sorted(set(row["metric_reasons"]["skew_25"]+row["metric_reasons"]["skew_10"]))
        if not row["metric_reasons"]["tail_gap"]:
            row["tail_gap_vol_points"] = row["rr_10_vol_points"]-row["rr_25_vol_points"]
        tenors.append(row)
    return {"version": VERSION, "as_of_ms": as_of_ms,
            "valid_until_ms": min(all_stamps)+MAX_QUOTE_AGE_MS if all_stamps else as_of_ms,
            "quote_count": len(greeks), "accepted_quote_count": len(accepted),
            "delta_model": "black76_forward_delta", "skew_sign": "put_iv_minus_call_iv",
            "iv_source": "deribit_mark_iv_percent", "day_count": "ACT/365",
            "validation_scope": "local_wing_segments_and_independent_atm; not_full_surface",
            "term_interpolation": "total_variance_at_fixed_absolute_delta; not_fixed_moneyness_calendar_validation",
            "listed_expiries": listed, "term_structure": tenors,
            "source_quotes": [asdict(s) for s in greeks.values()]}
