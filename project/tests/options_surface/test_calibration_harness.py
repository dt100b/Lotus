"""Research harness emits deterministic comparison artifacts."""

from __future__ import annotations

from project.options_surface.surface.harness import run_harness


def test_harness_synthetic_cases_record_all_three_candidates(tmp_path) -> None:
    report = run_harness(output_dir=tmp_path, include_live=False)
    names = {case["name"] for case in report["cases"]}
    assert {"flat_vol", "known_svi", "noisy_known_svi", "sparse_chain", "non_arb_kink"} <= names
    for case in report["cases"]:
        assert set(case["candidates"]) == {"tv_pchip", "svi_raw", "constrained_svi"}
        constrained = case["candidates"]["constrained_svi"]
        if case["name"] == "sparse_chain":
            assert constrained["acceptance"] == "rejected"
        if case["name"] in {"flat_vol", "known_svi"}:
            assert constrained["acceptance"] == "accepted"
            assert constrained["call_convex"] is True
        if constrained["call_convex"] is False:
            assert constrained["acceptance"] == "rejected"
    assert (tmp_path / "harness_report.md").exists()
    assert (tmp_path / "harness_report.json").exists()
