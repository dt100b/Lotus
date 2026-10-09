"""Release-gate tests for the frozen IV scanner parity corpus."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import json
from pathlib import Path

import pytest

from project.pipeline import iv_signal_scanner as production
from project.scripts import compare_iv_signal_parity as parity


@pytest.fixture(scope="module")
def frozen_fixture() -> dict:
    return parity.load_fixture()


@pytest.fixture(scope="module")
def parity_report(frozen_fixture: dict) -> dict:
    return parity.build_parity_report(frozen_fixture)


def test_fixture_is_one_eight_expiry_book_summary_capture(
    frozen_fixture: dict,
) -> None:
    source = frozen_fixture["source"]
    assert source["kind"] == "deribit_book_summary_response"
    assert source["endpoint"].endswith(
        "get_book_summary_by_currency?currency=BTC&kind=option"
    )
    assert len(source["response_sha256"]) == 64
    assert source["selected_instrument_count"] == 604
    assert len(frozen_fixture["expiries"]) == 8
    assert sum(len(chain) for chain in frozen_fixture["chains"].values()) == 302

    rows = parity.adapt_book_summary_rows(frozen_fixture)
    assert len(rows) == 604
    assert {row["option_type"] for row in rows} == {"call", "put"}
    assert {row["quote_as_of"] for row in rows} == {
        source["captured_as_of"]
    }


def test_all_four_votes_and_verdicts_are_recorded_for_every_stage(
    parity_report: dict,
) -> None:
    expected_votes = {"skew", "tails", "peak", "band"}
    expected_stages = {
        "legacy_calendar_t",
        "canonical_calendar_t",
        "canonical_exact_t_reference",
        "production",
    }
    assert len(parity_report["cases"]) == 8
    for case in parity_report["cases"]:
        assert set(case["stages"]) == expected_stages
        for stage in case["stages"].values():
            assert set(stage["signals"]["votes"]) == expected_votes
            assert stage["signals"]["verdict"] in {
                "LONG",
                "SHORT",
                "NO_TRADE",
            }


def test_canonical_exact_t_reference_matches_production_math(
    parity_report: dict,
) -> None:
    summary = parity_report["summary"]
    assert summary["engine_parity_passed"] is True
    assert summary["failure_count"] == 0
    assert summary["low_quality_trade_leaks"] == 0
    for case in parity_report["cases"]:
        engine = case["engine_parity"]
        assert engine["passed"] is True
        assert engine["numeric_arrays_match"] is True
        assert all(engine["vote_matches"].values())
        assert engine["model_verdict_matches"] is True
        assert case["transitions"]["production_engine"]["changed"] is False


def test_exact_tte_and_documented_reason_tags_are_present(
    parity_report: dict,
) -> None:
    for case in parity_report["cases"]:
        timing = case["time_to_expiry"]
        settlement = datetime.fromisoformat(
            timing["settlement_at"].isoformat()
            if isinstance(timing["settlement_at"], datetime)
            else timing["settlement_at"].replace("Z", "+00:00")
        )
        assert settlement.hour == 8
        assert settlement.minute == 0
        assert timing["exact_hours"] > 0
        assert timing["difference_hours"] != pytest.approx(0.0)
        assert "exact_time_to_expiry" in case["reason_tags"]
        assert "duplicate_strike_cleanup" in case["reason_tags"]
        assert case["input"]["selection"]["policy"] == "otm_mark_iv_v1"
        assert case["input"]["selection"]["verified_live_quotes"] is True


def test_curve_and_density_comparison_metrics_are_finite(
    parity_report: dict,
) -> None:
    for case in parity_report["cases"]:
        iv = case["metrics"]["iv_curve"]
        density = case["metrics"]["legacy_to_production_density"]
        assert iv["common_grid_points"] == parity.COMMON_IV_GRID_POINTS
        assert 0 <= iv["rmse_vol_points"] < 100
        assert 0 <= iv["max_abs_vol_points"] < 100
        assert density["common_grid_points"] == parity.COMMON_DENSITY_GRID_POINTS
        assert 0 <= density["positive_pdf_tv_distance"] <= 1.01
        assert 0 <= density["cdf_ks_distance"] <= 1.01
        assert density["mode_shift_percent_of_spot"] >= 0


def test_canonical_changes_are_review_items_not_hard_failures(
    parity_report: dict,
) -> None:
    assert any(case["status"] == "REVIEW" for case in parity_report["cases"])
    assert all(case["status"] != "FAIL" for case in parity_report["cases"])
    assert parity_report["summary"]["overall_status"] == "REVIEW"


def test_injected_engine_drift_is_a_hard_failure(
    frozen_fixture: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_scan = production.scan_expiry_rows

    def drifting_scan(*args, **kwargs):
        result = deepcopy(original_scan(*args, **kwargs))
        result["density"][0]["raw"] += 1e-4
        return result

    monkeypatch.setattr(production, "scan_expiry_rows", drifting_scan)
    case = _one_case(frozen_fixture)
    assert case["engine_parity"]["passed"] is False
    assert case["status"] == "FAIL"


def test_injected_low_quality_trade_leak_is_a_hard_failure(
    frozen_fixture: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_scan = production.scan_expiry_rows

    def leaking_scan(*args, **kwargs):
        result = deepcopy(original_scan(*args, **kwargs))
        result["curve_quality"]["level"] = "LOW"
        result["curve_quality"]["signal_eligible"] = False
        result["verdict"] = "LONG"
        result["suppression_reasons"] = []
        return result

    monkeypatch.setattr(production, "scan_expiry_rows", leaking_scan)
    case = _one_case(frozen_fixture)
    assert case["engine_parity"]["passed"] is True
    assert case["low_quality_trade_leak"] is True
    assert case["status"] == "FAIL"


def test_json_markdown_and_inline_svg_reports_serialize(
    tmp_path: Path,
    parity_report: dict,
) -> None:
    json_path = tmp_path / "parity.json"
    markdown_path = tmp_path / "parity.md"
    html_path = tmp_path / "parity.html"
    parity.write_reports(
        parity_report,
        json_path=json_path,
        markdown_path=markdown_path,
        html_path=html_path,
    )

    payload = json.loads(json_path.read_text(encoding="utf-8"))
    assert payload["summary"]["case_count"] == 8
    markdown = markdown_path.read_text(encoding="utf-8")
    assert "| 2026-08-15 |" in markdown
    assert "Canonical exact-T reference matches production math: **True**" in markdown
    rendered_html = html_path.read_text(encoding="utf-8")
    assert rendered_html.count("<section class='case'>") == 8
    assert "<svg" in rendered_html
    assert "Normalized IV curve" in rendered_html


def _one_case(frozen_fixture: dict) -> dict:
    rows = parity.adapt_book_summary_rows(frozen_fixture)
    expiry = frozen_fixture["expiries"][0]
    as_of = parity._parse_utc(frozen_fixture["source"]["captured_as_of"])
    return parity._compare_expiry(
        rows,
        expiry=expiry,
        spot=float(frozen_fixture["spot_price"]),
        as_of=as_of,
    )
