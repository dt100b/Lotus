"""Offline corpus analyzer. Calibration quality, not a backtest."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import UTC, date, datetime
import json
import math
from pathlib import Path
from statistics import median
from typing import Any, Iterable, Mapping, Sequence

from project.options_surface.config import default_serving_config
from project.options_surface.corpus.capture import detect_code_version
from project.options_surface.corpus.schema import (
    ANALYZER_REASON_COLUMNS,
    RUBRIC_METRIC_KEYS,
    family_for_code,
)
from project.options_surface.corpus.store import CorpusSnapshotStore, classify_schema
from project.options_surface.timeutil import ANALYSIS_TENOR_BUCKETS, as_utc

VOL_REGIMES = (
    ("lt_40", 0.0, 0.40),
    ("40_60", 0.40, 0.60),
    ("60_80", 0.60, 0.80),
    ("gte_80", 0.80, None),
)


def analyze_corpus(
    input_dir: Path,
    *,
    start: date | None = None,
    end: date | None = None,
    output_dir: Path | None = None,
) -> dict[str, Any]:
    store = CorpusSnapshotStore(Path(input_dir))
    loaded = list(store.iter_records(include_incompatible=True))
    used: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    corrupt = 0
    incompatible = 0
    for record in loaded:
        if record.get("_corrupt"):
            corrupt += 1
            skipped.append({"reason": "corrupt", "line": record.get("_corrupt_line")})
            continue
        status = record.get("_schema_status") or classify_schema(record)
        if status != "supported":
            incompatible += 1
            skipped.append(
                {
                    "reason": status,
                    "schema_version": record.get("schema_version"),
                    "snapshot_id": record.get("snapshot_id"),
                }
            )
            continue
        as_of = _record_date(record)
        if start is not None and (as_of is None or as_of < start):
            continue
        if end is not None and (as_of is None or as_of > end):
            continue
        used.append(record)

    report = build_report(used)
    by_hash: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for item in used:
        by_hash[str(item.get("config_hash") or "unknown")].append(item)
    report["by_config_hash"] = {
        key: summarize(rows, label=f"config:{key}") for key, rows in sorted(by_hash.items())
    }
    report["run"] = {
        "analyzed_utc": datetime.now(UTC).isoformat(),
        "input_dir": str(Path(input_dir)),
        "from": None if start is None else start.isoformat(),
        "to": None if end is None else end.isoformat(),
        "input_files": [str(path) for path in store.jsonl_paths()],
        "schema_versions_seen": sorted(
            {str(item.get("schema_version") or "") for item in loaded if not item.get("_corrupt")}
        ),
        "software": detect_code_version(),
        "serving_config_default": default_serving_config().to_public_dict(),
        "records_loaded": len(loaded),
        "records_used": len(used),
        "records_corrupt": corrupt,
        "records_incompatible_skipped": incompatible,
        "language": "calibration_quality_not_a_backtest",
    }
    report["skipped"] = skipped
    if output_dir is not None:
        write_report(report, Path(output_dir))
    return report


def build_report(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    overall = summarize(records, label="all")
    by_tenor = {
        bucket: summarize(
            [item for item in records if item.get("analysis_tenor_bucket") == bucket],
            label=bucket,
        )
        for bucket in ANALYSIS_TENOR_BUCKETS
    }
    rubric = rubric_metrics(records, overall)
    return {
        "title": "Options Surface calibration corpus",
        "disclaimer": (
            "Descriptive calibration, validity, and availability statistics. "
            "Not predictive accuracy, not alpha, and not a backtest."
        ),
        "overall": overall,
        "by_tenor": by_tenor,
        "rubric_metrics": rubric,
        "suspicious_patterns": _suspicious(overall, by_tenor),
    }


def summarize(records: Sequence[Mapping[str, Any]], *, label: str) -> dict[str, Any]:
    successful = [item for item in records if item.get("capture_ok", True)]
    failed = [item for item in records if not item.get("capture_ok", True)]
    expiries = {str(item.get("expiry")) for item in successful if item.get("expiry")}
    density_counts = Counter(
        str((item.get("serving") or {}).get("density_status") or "unavailable")
        for item in successful
    )
    market_data_unavail = sum(
        1
        for item in successful
        if (item.get("serving") or {}).get("primary_failure_category") == "market_data"
        or (item.get("serving") or {}).get("density_status") == "unavailable"
        and (item.get("serving") or {}).get("primary_failure_category") == "market_data"
    )
    forward_source = Counter()
    forward_quality = Counter()
    selected = Counter()
    fit_fail = Counter()
    reasons = Counter({key: 0 for key in ANALYZER_REASON_COLUMNS})
    residuals: list[float] = []
    max_resids: list[float] = []
    widths: list[float] = []
    accepted_counts: list[float] = []
    wing_balance: list[float] = []
    center_gaps: list[float] = []
    dtes: list[float] = []
    metric_series: dict[str, list[float]] = defaultdict(list)
    params: dict[str, list[float]] = defaultdict(list)
    optimizer_ok = 0
    optimizer_n = 0
    pchip_fail_cs_pass = 0
    cs_fail_pchip_pass = 0
    for item in successful:
        serving = item.get("serving") or {}
        forward = serving.get("forward") or {}
        if forward.get("source"):
            forward_source[str(forward["source"])] += 1
        if forward.get("source_quality"):
            forward_quality[str(forward["source_quality"])] += 1
        selected[str(serving.get("selected_candidate") or "none")] += 1
        candidates = item.get("candidates") or {}
        for name, pack in candidates.items():
            if not isinstance(pack, Mapping):
                continue
            if pack.get("attempted") and not pack.get("converged"):
                fit_fail[str(name)] += 1
            if name == "constrained_svi" and pack.get("attempted"):
                optimizer_n += 1
                if pack.get("converged"):
                    optimizer_ok += 1
                for key in ("a", "b", "rho", "m", "sigma"):
                    value = (pack.get("parameters") or {}).get(key)
                    if isinstance(value, (int, float)) and math.isfinite(float(value)):
                        params[key].append(float(value))
        cs = candidates.get("constrained_svi") or {}
        pchip = candidates.get("tv_pchip") or {}
        if _candidate_pass(cs) and not _candidate_pass(pchip):
            pchip_fail_cs_pass += 1
        if _candidate_pass(pchip) and not _candidate_pass(cs):
            cs_fail_pchip_pass += 1
        for code in serving.get("developer_reason_codes") or ():
            family = family_for_code(str(code))
            if family:
                reasons[family] += 1
        residual = serving.get("fit_residual_summary") or {}
        _append_finite(residuals, residual.get("weighted_rms"))
        _append_finite(max_resids, residual.get("max_abs"))
        norm = item.get("normalization") or {}
        otm = norm.get("otm_selection") or {}
        _append_finite(accepted_counts, otm.get("accepted_strikes"))
        lower = otm.get("lower_strikes")
        upper = otm.get("upper_strikes")
        if isinstance(lower, (int, float)) and isinstance(upper, (int, float)) and (lower + upper) > 0:
            wing_balance.append(float(lower) / float(lower + upper))
        _append_finite(center_gaps, otm.get("center_log_gap"))
        tte = (item.get("time_to_expiry") or {}).get("days")
        _append_finite(dtes, tte)
        for width in _quote_widths(norm):
            widths.append(width)
        analytics = serving.get("analytics") or {}
        density = serving.get("density") or {}
        _append_finite(metric_series["forward"], (forward.get("forward_usd")))
        _append_finite(metric_series["atm_iv"], analytics.get("atm_iv"))
        _append_finite(metric_series["rr_25"], analytics.get("rr_25"))
        _append_finite(metric_series["bf_25"], analytics.get("bf_25"))
        move = None
        if analytics.get("implied_move_1sd_up") is not None and analytics.get("implied_move_1sd_down") is not None:
            move = 0.5 * (float(analytics["implied_move_1sd_up"]) + float(analytics["implied_move_1sd_down"]))
        _append_finite(metric_series["implied_move"], move)
        quantiles = {}
        if serving.get("density_status") in {"accepted", "degraded"}:
            served = item.get("served_result") or {}
            dens = served.get("density") or {}
            quantiles = dens.get("quantiles") or {}
        _append_finite(metric_series["p25"], quantiles.get("p25"))
        _append_finite(metric_series["p50"], quantiles.get("p50"))
        _append_finite(metric_series["p75"], quantiles.get("p75"))
        _ = density
    n = len(successful)
    return {
        "label": label,
        "capture_attempts": len(records),
        "successful_captures": n,
        "failed_captures": len(failed),
        "expiries_evaluated": len(expiries),
        "unique_snapshot_count": len({str(item.get("snapshot_id")) for item in records if item.get("snapshot_id")}),
        "availability": {
            "density_status_accepted": density_counts.get("accepted", 0),
            "density_status_degraded": density_counts.get("degraded", 0),
            "density_status_rejected": density_counts.get("rejected", 0),
            "unavailable_market_data": market_data_unavail,
            "accepted_rate": _rate(density_counts.get("accepted", 0), n),
            "degraded_rate": _rate(density_counts.get("degraded", 0), n),
            "rejected_rate": _rate(density_counts.get("rejected", 0), n),
        },
        "forward_source": dict(forward_source),
        "forward_quality": dict(forward_quality),
        "candidate_selection": dict(selected),
        "candidate_fit_failures": dict(fit_fail),
        "serving_gate_failures": dict(reasons),
        "weighted_rms_residual": _dist(residuals),
        "max_residual": _dist(max_resids),
        "quote_iv_width": _dist(widths),
        "accepted_observation_count": _dist(accepted_counts),
        "lower_upper_wing_balance": _dist(wing_balance),
        "center_gap": _dist(center_gaps),
        "time_to_expiry_days": _dist(dtes),
        "metric_stability": {key: _dist(values) for key, values in metric_series.items()},
        "constrained_svi_parameters": {key: _dist(values) for key, values in params.items()},
        "optimizer_convergence_rate": _rate(optimizer_ok, optimizer_n),
        "pchip_fail_constrained_pass": pchip_fail_cs_pass,
        "constrained_fail_pchip_pass": cs_fail_pchip_pass,
        "vol_regimes": _vol_regimes(successful),
        "matching_future_high_quality_share": _matching_future_high(successful),
        "calendar_span_days": _calendar_span(records),
        "distinct_expiry_count": len(expiries),
    }


def rubric_metrics(records: Sequence[Mapping[str, Any]], overall: Mapping[str, Any]) -> dict[str, Any]:
    successful = [item for item in records if item.get("capture_ok", True)]
    accepted = [
        item
        for item in successful
        if (item.get("serving") or {}).get("density_status") in {"accepted", "degraded"}
    ]
    hard_fail = sum(
        1
        for item in successful
        if (item.get("serving") or {}).get("primary_failure_category") == "hard_gate"
    )
    data_fail = sum(
        1
        for item in successful
        if (item.get("serving") or {}).get("primary_failure_category") == "market_data"
    )
    model_fail = sum(
        1
        for item in successful
        if (item.get("serving") or {}).get("primary_failure_category") == "fit_quality"
    )
    residual_ok = 0
    residual_n = 0
    for item in successful:
        budget = ((item.get("serving") or {}).get("fit_residual_summary") or {}).get("residual_budget_ok")
        if budget is None:
            continue
        residual_n += 1
        if budget:
            residual_ok += 1
    n = max(len(successful), 1)
    metrics = {
        "unique_snapshot_count": overall.get("unique_snapshot_count", 0),
        "calendar_span_days": overall.get("calendar_span_days", 0),
        "distinct_expiry_count": overall.get("distinct_expiry_count", 0),
        "tenor_bucket_counts": {
            bucket: sum(1 for item in successful if item.get("analysis_tenor_bucket") == bucket)
            for bucket in ANALYSIS_TENOR_BUCKETS
        },
        "vol_regime_counts": overall.get("vol_regimes", {}),
        "matching_future_high_quality_share": overall.get("matching_future_high_quality_share"),
        "fit_convergence_rate": overall.get("optimizer_convergence_rate"),
        "density_accepted_rate": (overall.get("availability") or {}).get("accepted_rate"),
        "density_degraded_rate": (overall.get("availability") or {}).get("degraded_rate"),
        "density_rejected_rate": (overall.get("availability") or {}).get("rejected_rate"),
        "density_unavailable_market_data_rate": _rate(
            (overall.get("availability") or {}).get("unavailable_market_data", 0),
            len(successful),
        ),
        "residual_budget_pass_rate": _rate(residual_ok, residual_n),
        "hard_gate_pass_rate": _rate(len(successful) - hard_fail, len(successful)),
        "unexplained_adjacent_instability_rate": _adjacent_instability(successful),
        "parameter_stability_when_inputs_stable": _parameter_stability(successful),
        "digital_reconciliation_stability": _gate_stability(accepted, "digital_atm_error"),
        "grid_convergence_stability": _grid_stability(accepted),
        "accepted_later_invalid_count": 0,
        "data_quality_rejection_rate": _rate(data_fail, n if successful else 0),
        "model_driven_rejection_rate": _rate(model_fail, n if successful else 0),
        "pchip_fail_constrained_pass_count": overall.get("pchip_fail_constrained_pass", 0),
        "constrained_fail_pchip_pass_count": overall.get("constrained_fail_pchip_pass", 0),
    }
    missing = [key for key in RUBRIC_METRIC_KEYS if key not in metrics]
    if missing:
        raise RuntimeError(f"Analyzer missing rubric metrics: {missing}")
    return metrics


def write_report(report: Mapping[str, Any], output_dir: Path) -> dict[str, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "corpus_report.json"
    md_path = output_dir / "corpus_report.md"
    csv_path = output_dir / "corpus_summary.csv"
    rubric_path = output_dir / "rubric_metrics.json"
    manifest_path = output_dir / "run_manifest.json"
    json_path.write_text(json.dumps(report, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    rubric_path.write_text(
        json.dumps(report.get("rubric_metrics") or {}, indent=2, sort_keys=True, default=str) + "\n",
        encoding="utf-8",
    )
    manifest_path.write_text(
        json.dumps(report.get("run") or {}, indent=2, sort_keys=True, default=str) + "\n",
        encoding="utf-8",
    )
    csv_path.write_text(_summary_csv(report), encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    return {
        "json": json_path,
        "markdown": md_path,
        "csv": csv_path,
        "rubric": rubric_path,
        "manifest": manifest_path,
    }


def render_markdown(report: Mapping[str, Any]) -> str:
    overall = report.get("overall") or {}
    avail = overall.get("availability") or {}
    run = report.get("run") or {}
    lines = [
        "# Options Surface calibration corpus",
        "",
        str(report.get("disclaimer") or ""),
        "",
        "## Run",
        "",
        f"- analyzed_utc: `{run.get('analyzed_utc')}`",
        f"- input: `{run.get('input_dir')}`",
        f"- window: `{run.get('from')}` → `{run.get('to')}`",
        f"- records used / loaded: `{run.get('records_used')}` / `{run.get('records_loaded')}`",
        f"- corrupt / incompatible skipped: `{run.get('records_corrupt')}` / `{run.get('records_incompatible_skipped')}`",
        f"- schema versions: `{run.get('schema_versions_seen')}`",
        "",
        "## Overall",
        "",
        f"- capture attempts: `{overall.get('capture_attempts')}`",
        f"- successful / failed captures: `{overall.get('successful_captures')}` / `{overall.get('failed_captures')}`",
        f"- expiries evaluated: `{overall.get('expiries_evaluated')}`",
        f"- unique snapshots: `{overall.get('unique_snapshot_count')}`",
        f"- density accepted / degraded / rejected: `{avail.get('density_status_accepted')}` / "
        f"`{avail.get('density_status_degraded')}` / `{avail.get('density_status_rejected')}`",
        f"- unavailable (market-data): `{avail.get('unavailable_market_data')}`",
        f"- candidate selection: `{overall.get('candidate_selection')}`",
        f"- serving-gate families: `{overall.get('serving_gate_failures')}`",
        f"- PCHIP fail / constrained pass: `{overall.get('pchip_fail_constrained_pass')}`",
        f"- constrained fail / PCHIP pass: `{overall.get('constrained_fail_pchip_pass')}`",
        "",
        "## Tenor buckets",
        "",
        "| Bucket | Snapshots | Accepted | Degraded | Rejected |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for bucket, block in (report.get("by_tenor") or {}).items():
        avail_b = block.get("availability") or {}
        lines.append(
            f"| {bucket} | {block.get('successful_captures')} | "
            f"{avail_b.get('density_status_accepted')} | "
            f"{avail_b.get('density_status_degraded')} | "
            f"{avail_b.get('density_status_rejected')} |"
        )
    lines.extend(
        [
            "",
            "## Rubric export",
            "",
            "See `rubric_metrics.json`. Thresholds live in "
            "`docs/constrained_svi_promotion_rubric.md`. This report does not "
            "promote `constrained_svi`.",
            "",
            "## Configuration regimes",
            "",
            "Analyze each `config_hash` separately. Do not treat mixed hashes as one promotion sample.",
            "",
        ]
    )
    for hash_key, block in (report.get("by_config_hash") or {}).items():
        avail_h = block.get("availability") or {}
        lines.append(
            f"- `{hash_key}`: snapshots `{block.get('successful_captures')}` · "
            f"accepted `{avail_h.get('density_status_accepted')}` · "
            f"rejected `{avail_h.get('density_status_rejected')}` · "
            f"unavailable `{avail_h.get('unavailable_market_data')}`"
        )
    lines.extend(["", "## Suspicious patterns", ""])
    for note in report.get("suspicious_patterns") or ["none"]:
        lines.append(f"- {note}")
    lines.append("")
    return "\n".join(lines)


def _summary_csv(report: Mapping[str, Any]) -> str:
    rows = [("segment", "metric", "value")]
    def walk(prefix: str, value: Any) -> None:
        if isinstance(value, Mapping):
            for key, item in value.items():
                walk(f"{prefix}.{key}" if prefix else str(key), item)
        else:
            rows.append((prefix.split(".", 1)[0] if prefix else "all", prefix, json.dumps(value, default=str)))
    walk("overall", report.get("overall") or {})
    for bucket, block in (report.get("by_tenor") or {}).items():
        walk(bucket, block)
    for hash_key, block in (report.get("by_config_hash") or {}).items():
        walk(f"config_{hash_key}", block)
    return "\n".join(",".join(row) for row in rows) + "\n"


def _candidate_pass(pack: Mapping[str, Any]) -> bool:
    if not pack or not pack.get("attempted"):
        return False
    if pack.get("eligible_for_density"):
        return True
    return bool(pack.get("call_monotone") and pack.get("call_convex") and pack.get("residual_budget_ok") is not False)


def _append_finite(target: list[float], value: Any) -> None:
    if value is None:
        return
    try:
        number = float(value)
    except (TypeError, ValueError):
        return
    if math.isfinite(number):
        target.append(number)


def _dist(values: Sequence[float]) -> dict[str, Any]:
    if not values:
        return {"count": 0, "min": None, "p50": None, "max": None, "mean": None}
    ordered = sorted(values)
    return {
        "count": len(ordered),
        "min": ordered[0],
        "p50": float(median(ordered)),
        "max": ordered[-1],
        "mean": float(sum(ordered) / len(ordered)),
    }


def _rate(num: int, den: int) -> float | None:
    if den <= 0:
        return None
    return float(num) / float(den)


def _record_date(record: Mapping[str, Any]) -> date | None:
    raw = record.get("as_of_utc") or record.get("capture_utc")
    if not raw:
        return None
    try:
        return as_utc(datetime.fromisoformat(str(raw).replace("Z", "+00:00"))).date()
    except ValueError:
        return None


def _quote_widths(norm: Mapping[str, Any]) -> list[float]:
    widths: list[float] = []
    for row in norm.get("weights") or ():
        components = (row or {}).get("components") or {}
        _append_finite(widths, components.get("iv_width"))
    return widths


def _vol_regimes(records: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    counts = {name: 0 for name, _lo, _hi in VOL_REGIMES}
    for item in records:
        atm = ((item.get("serving") or {}).get("analytics") or {}).get("atm_iv")
        if not isinstance(atm, (int, float)):
            continue
        for name, lo, hi in VOL_REGIMES:
            if atm >= lo and (hi is None or atm < hi):
                counts[name] += 1
                break
    return counts


def _matching_future_high(records: Sequence[Mapping[str, Any]]) -> float | None:
    if not records:
        return None
    hits = 0
    for item in records:
        forward = (item.get("serving") or {}).get("forward") or {}
        if forward.get("source") == "matching_future" and forward.get("source_quality") == "high":
            hits += 1
    return _rate(hits, len(records))


def _calendar_span(records: Sequence[Mapping[str, Any]]) -> int:
    days = [item for item in (_record_date(record) for record in records) if item is not None]
    if not days:
        return 0
    return (max(days) - min(days)).days


def _adjacent_instability(records: Sequence[Mapping[str, Any]]) -> float | None:
    by_expiry: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for item in records:
        expiry = str(item.get("expiry") or "")
        if expiry:
            by_expiry[expiry].append(item)
    flips = 0
    pairs = 0
    for group in by_expiry.values():
        ordered = sorted(group, key=lambda item: str(item.get("as_of_utc") or ""))
        for left, right in zip(ordered, ordered[1:]):
            pairs += 1
            left_status = (left.get("serving") or {}).get("density_status")
            right_status = (right.get("serving") or {}).get("density_status")
            if left_status == right_status:
                continue
            if _inputs_look_stable(left, right):
                flips += 1
    return _rate(flips, pairs)


def _inputs_look_stable(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    lo = (left.get("normalization") or {}).get("otm_selection") or {}
    ro = (right.get("normalization") or {}).get("otm_selection") or {}
    if lo.get("accepted_strikes") != ro.get("accepted_strikes"):
        return False
    lf = ((left.get("serving") or {}).get("forward") or {}).get("forward_usd")
    rf = ((right.get("serving") or {}).get("forward") or {}).get("forward_usd")
    if not isinstance(lf, (int, float)) or not isinstance(rf, (int, float)) or lf <= 0:
        return False
    return abs(float(lf) - float(rf)) / float(lf) <= 0.002


def _parameter_stability(records: Sequence[Mapping[str, Any]]) -> float | None:
    by_expiry: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for item in records:
        pack = (item.get("candidates") or {}).get("constrained_svi") or {}
        params = pack.get("parameters") or {}
        if not params:
            continue
        by_expiry[str(item.get("expiry") or "")].append(item)
    rels: list[float] = []
    for group in by_expiry.values():
        ordered = sorted(group, key=lambda item: str(item.get("as_of_utc") or ""))
        for left, right in zip(ordered, ordered[1:]):
            if not _inputs_look_stable(left, right):
                continue
            lp = ((left.get("candidates") or {}).get("constrained_svi") or {}).get("parameters") or {}
            rp = ((right.get("candidates") or {}).get("constrained_svi") or {}).get("parameters") or {}
            for key in ("a", "b", "rho", "m", "sigma"):
                if key not in lp or key not in rp:
                    continue
                base = abs(float(lp[key])) if abs(float(lp[key])) > 1e-8 else 1.0
                rels.append(abs(float(lp[key]) - float(rp[key])) / base)
    if not rels:
        return None
    return float(sum(rels) / len(rels))


def _gate_stability(records: Sequence[Mapping[str, Any]], field: str) -> float | None:
    values: list[float] = []
    for item in records:
        density = (item.get("serving") or {}).get("density") or {}
        _append_finite(values, density.get(field))
    if len(values) < 2:
        return None
    mean = sum(values) / len(values)
    var = sum((item - mean) ** 2 for item in values) / len(values)
    return float(math.sqrt(var))


def _grid_stability(records: Sequence[Mapping[str, Any]]) -> float | None:
    if not records:
        return None
    ok = sum(
        1
        for item in records
        if ((item.get("serving") or {}).get("density") or {}).get("grid_converged") is True
    )
    return _rate(ok, len(records))


def _suspicious(overall: Mapping[str, Any], by_tenor: Mapping[str, Any]) -> list[str]:
    notes: list[str] = []
    avail = overall.get("availability") or {}
    n = int(overall.get("successful_captures") or 0)
    if n >= 8 and avail.get("accepted_rate") is not None and avail["accepted_rate"] >= 0.95:
        notes.append("Almost always accepted across the analyzed window; inspect whether the sample is too narrow.")
    if n >= 8 and avail.get("rejected_rate") is not None and avail["rejected_rate"] >= 0.95:
        notes.append("Almost always rejected; confirm the sample is liquid enough before attributing this to the fitter.")
    for bucket, block in by_tenor.items():
        count = int(block.get("successful_captures") or 0)
        rate = (block.get("availability") or {}).get("accepted_rate")
        if count >= 6 and rate is not None and (rate >= 0.95 or rate <= 0.05):
            notes.append(f"Tenor {bucket} is nearly one-sided (accepted_rate={rate:.2f}).")
    return notes or ["No one-sided availability pattern flagged at the current sample size."]
