import json

from vol_surface.atm_history import DAY, HOUR, daily_lookbacks, retain_snapshot, atm_history_series


def curve(stamp, value=40):
    return {"version": "atm_term_curve.v1", "as_of_ms": stamp,
            "valid_until_ms": stamp + 300_000, "term_structure": [
                {"tenor": tenor, "status": "ok", "calendar_ok": True,
                 "atm_iv_percent": value} for tenor in ("7d", "30d", "60d", "180d")]}


def test_every_capture_retained_and_latest_backward_day_selection(tmp_path):
    now = 100 * DAY + HOUR
    for day in (1, 3, 7, 31):
        retain_snapshot(tmp_path, curve(now - day * DAY - 1000, 40 + day))
        retain_snapshot(tmp_path, curve(now - day * DAY - 500, 99))
    rows = daily_lookbacks(tmp_path, now)
    assert [row["days"] for row in rows] == [1, 3, 7, 31]
    assert [row["term_structure"][0]["atm_iv_percent"] for row in rows] == [99]*4
    assert len(list((tmp_path / "atm_term_history").rglob("*.json"))) == 8
    retain_snapshot(tmp_path, curve(now-DAY-500,12))
    assert daily_lookbacks(tmp_path,now)[0]["term_structure"][0]["atm_iv_percent"] == 99


def test_no_future_or_remote_substitution(tmp_path):
    now = 100 * DAY
    retain_snapshot(tmp_path, curve(now - DAY + 1))
    retain_snapshot(tmp_path, curve(now - 3 * DAY - 2 * HOUR - 1))
    assert daily_lookbacks(tmp_path, now) == []


def test_invalid_observations_and_corrupt_archive(tmp_path):
    now = 100 * DAY
    invalid = curve(now - DAY)
    invalid["valid_until_ms"] = invalid["as_of_ms"]
    retain_snapshot(tmp_path, invalid)
    invalid = curve(now - DAY)
    invalid["version"] = "legacy"
    retain_snapshot(tmp_path, invalid)
    invalid = curve(now - DAY, float("nan"))
    retain_snapshot(tmp_path, invalid)
    assert daily_lookbacks(tmp_path, now) == []
    retain_snapshot(tmp_path, curve(now - DAY))
    path = next((tmp_path / "atm_term_history").rglob("*.json"))
    path.write_text("{")
    assert daily_lookbacks(tmp_path, now) == []
    path.write_text(json.dumps(curve(now - DAY)))
    assert len(daily_lookbacks(tmp_path, now)) == 1


def test_missing_tenor_preserved(tmp_path):
    now = 100 * DAY
    row = curve(now - DAY)
    row["term_structure"][1].update(status="unavailable", atm_iv_percent=None)
    retain_snapshot(tmp_path, row)
    assert daily_lookbacks(tmp_path, now)[0]["term_structure"][1]["atm_iv_percent"] is None


def test_legacy_hourly_and_new_captures_choose_actual_closest_time(tmp_path):
    now = 100*DAY+HOUR//2
    directory = tmp_path/'atm_term_history'
    directory.mkdir()
    stamp = now-DAY-1000
    (directory/f'{stamp//HOUR:012d}.json').write_text(json.dumps(curve(stamp,42)))
    retain_snapshot(tmp_path,curve(stamp-1000,40))
    assert daily_lookbacks(tmp_path,now)[0]['term_structure'][0]['atm_iv_percent'] == 42
    retain_snapshot(tmp_path,curve(stamp+500,43))
    assert daily_lookbacks(tmp_path,now)[0]['term_structure'][0]['atm_iv_percent'] == 43


def test_structurally_invalid_archive_does_not_mask_prior_capture(tmp_path):
    now = 100*DAY
    retain_snapshot(tmp_path,curve(now-DAY-1000))
    path = tmp_path/'atm_term_history'/'captures'/f'{now-DAY:013d}.json'
    path.write_text('null')
    assert len(daily_lookbacks(tmp_path,now)) == 1


def test_atm_history_uses_last_capture_per_hour_and_preserves_missing_tenors(tmp_path):
    now = 100*DAY+HOUR
    retain_snapshot(tmp_path,curve(now-HOUR,40))
    later = curve(now-HOUR+600_000,42)
    later['term_structure'][1].update(status='unavailable',atm_iv_percent=None)
    retain_snapshot(tmp_path,later)
    retain_snapshot(tmp_path,curve(now+1,99))
    series = atm_history_series(tmp_path,now)
    assert series['7d'] == [{'ts_ms':now-HOUR+600_000,'value':42}]
    assert '30d' not in series
