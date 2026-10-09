"""Independent, read-only checks of the dashboard surface (no production edits).

Run with --live to freeze one public Deribit book-summary response. Results
describe the marks surface, not executable arbitrage or production promotion.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import UTC, datetime
from pathlib import Path

from project.scripts import _bootstrap  # noqa: F401
import numpy as np
from scipy.stats import norm

from greeks.types import GreekSnapshot
from vol_surface.parkinson import rolling_parkinson_series
from vol_surface.snapshot import build_vol_surface_payload
from vol_surface.surface import (
    SurfaceQuote, build_slices, decimal_iv, quotes_from_greeks, smile_at_tenor,
)

DAY = 86_400_000
HOUR = 3_600_000
ASOF = 1_780_000_000_000
F = 100_000.0


def chain(days, ks, ivs):
    return [SurfaceQuote("BTC", ASOF + int(days * DAY), F * math.exp(k),
                         "put" if k < 0 else "call", float(iv), F, 1.0)
            for k, iv in zip(ks, ivs)]


def price_checks(smile, n=2001):
    # Uniform strike grid; vectorized Black calls normalized by forward.
    strikes = np.linspace(math.exp(smile.k_min), math.exp(smile.k_max), n)
    w = np.array([smile.total_variance(math.log(float(k)))[0] for k in strikes])
    d1 = (-np.log(strikes) + w / 2) / np.sqrt(w)
    calls = norm.cdf(d1) - strikes * norm.cdf(d1 - np.sqrt(w))
    slopes = np.diff(calls) / np.diff(strikes)
    curvature = np.diff(slopes) / ((np.diff(strikes)[:-1] + np.diff(strikes)[1:]) / 2)
    return {
        "grid_points": n,
        "increasing_call_steps": int(np.sum(np.diff(calls) > 1e-10)),
        "negative_curvature_points": int(np.sum(curvature < -1e-6)),
        "min_normalized_call_curvature": float(curvature.min()),
        "digital_bound_violations": int(np.sum((slopes < -1 - 1e-8) | (slopes > 1e-8))),
    }


def synthetic_checks():
    ks = np.array([-.30, -.15, 0., .15, .30])
    flat = build_slices(chain(30, ks, [.50] * 5), as_of_ms=ASOF)[0]
    flat_checks = price_checks(flat)
    assert flat_checks["negative_curvature_points"] == 0
    assert flat_checks["increasing_call_steps"] == 0
    assert abs(flat.iv(0)[0] - .5) < 1e-12
    noisy_quotes = chain(30, ks, [.55, .52, .70, .48, .50])
    noisy = build_slices(noisy_quotes, as_of_ms=ASOF)[0]
    noisy_payload = build_vol_surface_payload(noisy_quotes, as_of_ms=ASOF)
    row30 = lambda p: next(r for r in p["term_structure"] if r["tenor"] == "30d")
    calendar_quotes = chain(7, ks, [.90] * 5) + chain(90, ks, [.15] * 5)
    cal = row30(build_vol_surface_payload(calendar_quotes, as_of_ms=ASOF))
    old = GreekSnapshot("BTC-6OCT26-90000-P", 0.0, F, 1, mark_iv=50.0)
    bars = [(ASOF + i * HOUR, 101., 100.) for i in range(25)]
    missing = bars[:10] + bars[11:]
    duplicate = bars[:23] + [bars[22]]
    malformed = bars[:10] + [{"ts_ms": bars[10][0], "high": "bad", "low": 100}] + bars[11:]

    # Ordered knot variances can still cross between knots with independent PCHIPs.
    rng = np.random.default_rng(20261007)
    calendar_between = None
    refit = None
    for trial in range(500):
        w1 = rng.uniform(.005, .045, len(ks))
        w2 = w1 + rng.uniform(.00001, .004, len(ks))
        smiles = build_slices(chain(20, ks, np.sqrt(w1 / (20/365))) +
                              chain(40, ks, np.sqrt(w2 / (40/365))), as_of_ms=ASOF)
        interp, _, calendar_ok = smile_at_tenor(smiles, target_years=30/365)
        grid = np.linspace(ks[0], ks[-1], 1001)
        a = np.array([smiles[0].total_variance(float(k))[0] for k in grid])
        b = np.array([smiles[1].total_variance(float(k))[0] for k in grid])
        if interp is not None:
            actual = np.array([interp.total_variance(float(k))[0] for k in grid])
            error = np.abs(np.sqrt(actual/(30/365)) - np.sqrt((a+b)/2/(30/365))) * 100
            if refit is None or error.max() > refit["max_iv_error_vol_points"]:
                refit = {"max_iv_error_vol_points": float(error.max()), "w1": w1.tolist(), "w2": w2.tolist()}
        if (b-a).min() < -1e-5:
            calendar_between = {"seed": 20261007, "trial": trial, "calendar_ok": calendar_ok,
                                "served": interp is not None,
                                "min_calendar_dw_dense": float((b-a).min()),
                                "w1": w1.tolist(), "w2": w2.tolist()}
            break
    assert calendar_between is not None
    return {
        "flat_vol_recovery": flat_checks,
        "butterfly_counterexample": {"reported_status": row30(noisy_payload)["status"], **price_checks(noisy)},
        "calendar_violation_published": cal,
        "calendar_violation_between_knots": calendar_between,
        "interpolated_smile_refit_error": refit,
        "ancient_quote_accepted_count": len(quotes_from_greeks({old.instrument_name: old},as_of_ms=ASOF)),
        "deribit_raw_2_percent_decoded_decimal": decimal_iv(2.0,unit="percent"),
        "missing_hour_publishes_24bar_rv": bool(rolling_parkinson_series(missing, lookback_bars=24)),
        "duplicate_hour_publishes_24bar_rv": bool(rolling_parkinson_series(duplicate, lookback_bars=24)),
        "malformed_range_removed_publishes_rv": bool(rolling_parkinson_series(malformed, lookback_bars=24)),
    }


def live_checks(output, replay=None):
    if replay:
        raw = json.loads(replay.read_text(encoding="utf-8"))
        prior = json.loads((replay.parent / "audit_results.json").read_text(encoding="utf-8"))["live"]
        started = prior["request_started_utc"]
        asof = int(datetime.fromisoformat(prior["as_of_utc"]).timestamp()*1000)
    else:
        import httpx
        started = datetime.now(UTC).isoformat()
        response = httpx.get("https://www.deribit.com/api/v2/public/get_book_summary_by_currency",
                            params={"currency": "BTC", "kind": "option"}, timeout=20)
        response.raise_for_status()
        raw = response.json()
        asof = int(datetime.now(UTC).timestamp() * 1000)
        (output / "deribit_book_summary.json").write_text(json.dumps(raw, indent=2), encoding="utf-8")
    rows = raw["result"]
    greeks = {r["instrument_name"]: GreekSnapshot(r["instrument_name"], 0.,
              float(r["underlying_price"]), int(r["creation_timestamp"]),
              r.get("open_interest"), r.get("mark_iv"))
              for r in rows if r.get("underlying_price") and r.get("mark_iv")}
    quotes = quotes_from_greeks(greeks)
    smiles = build_slices(quotes, as_of_ms=asof)
    diagnostics = []
    for s in smiles:
        expiry = int(asof + s.time_to_expiry_years * 365 * DAY)
        diagnostics.append({"expiry_utc": datetime.fromtimestamp(expiry/1000, UTC).isoformat(),
                            "days": s.time_to_expiry_years * 365, "knots": len(s.knot_k),
                            **price_checks(s),
                            "grid_sensitivity":[price_checks(s,n) for n in (1001,4001)]})
    # All-row counts are unambiguous; quote selection counts are omitted because
    # summary responses have no bid/ask IV, size, or true quote-update timestamp.
    calendar = []
    for a, b in zip(smiles, smiles[1:]):
        lo, hi = max(a.k_min,b.k_min), min(a.k_max,b.k_max)
        if hi <= lo:
            continue
        grid = np.linspace(lo,hi,2001)
        dw = [b.total_variance(float(k))[0]-a.total_variance(float(k))[0] for k in grid]
        calendar.append({"left_days":a.time_to_expiry_years*365,"right_days":b.time_to_expiry_years*365,
                         "min_calendar_dw":float(min(dw)), "negative_grid_points":sum(d < -1e-10 for d in dw)})
    tenors = []
    for days in (1,7,30,90,180):
        smile, method, cal = smile_at_tenor(smiles, target_years=days/365)
        if smile is not None:
            tenors.append({"days":days,"method":method,"calendar_ok":cal,**price_checks(smile)})
    return {"request_started_utc":started,"as_of_utc":datetime.fromtimestamp(asof/1000,UTC).isoformat(),
            "raw_response_sha256":hashlib.sha256(json.dumps(raw,sort_keys=True,separators=(",",":")).encode()).hexdigest(),
            "source":"public book summary; same mark/underlying inputs, not dashboard Greek snapshot",
            "raw_rows":len(rows), "converted_quotes":len(quotes),
            "all_rows_without_positive_two_sided_premiums":sum(not (r.get("bid_price") and r.get("ask_price") and
                float(r["bid_price"]) > 0 and float(r["ask_price"]) >= float(r["bid_price"])) for r in rows),
            "slices":diagnostics,"adjacent_calendar_checks":calendar,"tenor_price_checks":tenors,
            "payload":build_vol_surface_payload(quotes,as_of_ms=asof)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--replay", type=Path, help="Frozen summary beside its original audit_results.json")
    parser.add_argument("--output", type=Path, default=Path("runtime/desk_surface_audit/2026-10-07-v2"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    result = {"synthetic": synthetic_checks()}
    if args.live or args.replay:
        result["live"] = live_checks(args.output,args.replay)
    filename = "audit_results.json" if args.live or args.replay else "synthetic_results.json"
    path = args.output / filename
    path.write_text(json.dumps(result, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({"results":str(path),"synthetic":result["synthetic"],
                      "live_slices":len(result.get("live",{}).get("slices",[]))},indent=2))


if __name__ == "__main__":
    main()
