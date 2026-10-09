"""Immutable successful ATM captures, with backward-compatible hourly lookbacks."""
from bisect import bisect_right
from functools import lru_cache
import math
from pathlib import Path

VERSION = "atm_term_curve.v1"
HOUR = 3_600_000
DAY = 24 * HOUR


@lru_cache(maxsize=20_000)
def _history_observation(path: Path, modified: int) -> tuple[int,tuple[tuple[str,float],...]] | None:
    from vol_surface.atm_refresh import read_json
    row = read_json(path)
    if not valid_snapshot(row):
        return None
    return int(row["as_of_ms"]), tuple((r["tenor"],r["atm_iv_percent"]) for r in row["term_structure"]
        if r.get("status") == "ok" and r.get("calendar_ok") is not False
        and isinstance(r.get("atm_iv_percent"),(int,float)) and math.isfinite(r["atm_iv_percent"])
        and r["atm_iv_percent"] > 0)


def atm_history_series(root: Path, as_of_ms: int) -> dict[str,list[dict]]:
    """Last capture in each UTC hour, one year; same estimator as the live curve.

    Original ten-minute captures remain in the archive. Read only selected
    hourly files and cache the small extracted observations, not raw tickers.
    """
    directory = root / "atm_term_history"
    def mtime(path):
        return path.stat().st_mtime_ns if path.exists() else 0
    candidates, _ = _capture_index(directory,mtime(directory),mtime(directory / "captures"))
    hours = {}
    for bound,path,legacy in candidates:
        if as_of_ms-365*DAY <= bound <= as_of_ms+(HOUR if legacy else 0):
            hour = bound//HOUR
            # Every exact capture supersedes that hour's legacy first capture.
            current = hours.get(hour)
            if current is None or (not legacy and (current[2] or bound > current[0])):
                hours[hour] = (bound,path,legacy)
    series: dict[str,list[dict]] = {}
    for _,path,_ in sorted(hours.values()):
        try:
            observation = _history_observation(path,path.stat().st_mtime_ns)
            if observation is None:
                continue
            stamp,values = observation
            if stamp > as_of_ms or stamp < as_of_ms-365*DAY:
                continue
            for tenor,value in values:
                points = series.setdefault(tenor,[])
                gap = bool(points and stamp//HOUR-points[-1]["ts_ms"]//HOUR > 1)
                points.append({"ts_ms":stamp,"value":value, **({"gap_before":True} if gap else {})})
        except (OSError,ValueError,TypeError,AttributeError,KeyError):
            continue
    return series


def valid_snapshot(payload: dict) -> bool:
    if not isinstance(payload,dict):
        return False
    stamp = payload.get("as_of_ms", 0)
    valid_until = payload.get("valid_until_ms",0)
    if (payload.get("version") != VERSION
            or not all(isinstance(v,(int,float)) and math.isfinite(v) and v > 0 for v in (stamp,valid_until))
            or valid_until <= stamp):
        return False
    rows = [row for row in payload.get("term_structure", [])
            if row.get("status") == "ok" and row.get("calendar_ok") is not False
            and isinstance(row.get("atm_iv_percent"), (int, float))
            and math.isfinite(row["atm_iv_percent"]) and row["atm_iv_percent"] > 0]
    return len(rows) >= 2


def retain_snapshot(root: Path, payload: dict) -> None:
    from vol_surface.atm_refresh import write_atomic
    if not valid_snapshot(payload):
        return
    stamp = int(payload["as_of_ms"])
    path = root / "atm_term_history" / "captures" / f"{stamp:013d}.json"
    # Do not overwrite a captured observation, even after a collector restart.
    if not path.exists():
        write_atomic(path, payload)


@lru_cache(maxsize=8)
def _capture_index(directory: Path, legacy_mtime: int, captures_mtime: int):
    # Legacy names encode an hour, so use its upper bound when ordering. New
    # names encode actual capture time. Directory mtimes invalidate on append.
    candidates = [((int(p.stem)+1)*HOUR-1,p,True) for p in directory.glob("*.json") if p.stem.isdigit()]
    candidates += [(int(p.stem),p,False) for p in (directory / "captures").glob("*.json") if p.stem.isdigit()]
    candidates.sort(key=lambda item:item[0])
    return candidates, [stamp for stamp,_,_ in candidates]


def daily_lookbacks(root: Path, as_of_ms: int, max_days: int = 365) -> list[dict]:
    from vol_surface.atm_refresh import read_json
    directory = root / "atm_term_history"
    def mtime(path):
        return path.stat().st_mtime_ns if path.exists() else 0
    candidates, stamps = _capture_index(directory,mtime(directory),mtime(directory / "captures"))
    result = []
    for days in range(1, max_days + 1):
        target = as_of_ms - days * DAY
        index = bisect_right(stamps, target+HOUR)
        start = bisect_right(stamps, target-2*HOUR-1)
        best = None
        for upper_stamp,path,legacy in reversed(candidates[start:index]):
            if best is not None and upper_stamp <= best["as_of_ms"]:
                break
            if not legacy and upper_stamp > target:
                continue
            try:
                row = read_json(path)
                stamp = row.get("as_of_ms", 0)
                if 0 <= target-stamp <= 2*HOUR and valid_snapshot(row):
                    if best is None or stamp > best["as_of_ms"]:
                        best = row
            except (OSError, ValueError, TypeError, AttributeError):
                continue
        if best is not None:
            row = best
            result.append({"days":days,"as_of_ms":row["as_of_ms"],
                           "target_offset_ms":target-row["as_of_ms"],
                           "term_structure":row["term_structure"]})
    return result
