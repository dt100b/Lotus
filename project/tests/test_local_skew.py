from dataclasses import replace
from datetime import UTC, datetime
import json
import math
from types import SimpleNamespace

import pytest
from scipy.stats import norm

from greeks.types import GreekSnapshot
from vol_surface.skew import build_skew_snapshot, select_skew_instruments
from vol_surface import skew_refresh
from vol_surface.snapshot import attach_atm_rv
from vol_surface.atm_refresh import CollectorLease, read_json, write_atomic

NOW = int(datetime(2026, 10, 9, 8, tzinfo=UTC).timestamp()*1000)
DAY = 86_400_000


def chain(days, iv=40):
    expiry = NOW+days*DAY
    date = datetime.fromtimestamp(expiry/1000, UTC).strftime('%d%b%y').upper()
    w = (iv/100)**2*days/365
    result = {}
    for side in ('put', 'call'):
        strikes = [99_500 if side == 'put' else 100_500]
        for delta in (.05, .08, .12, .18, .22, .28, .32, .38):
            strikes.append(round(100_000*math.exp(w/2-math.sqrt(w)*norm.ppf(delta if side == 'call' else 1-delta))))
        for strike in strikes:
            name = f'BTC-{date}-{strike}-{side[0].upper()}'
            result[name] = GreekSnapshot(name, 0, 100_000, NOW, mark_iv=iv,
                bid_price=.01, ask_price=.012, bid_size=2, ask_size=3, bid_iv=iv-1, ask_iv=iv+1,
                forward_source='ticker_underlying_price', expiration_timestamp=expiry)
    return result


def tenor(p, name='30d'):
    return next(r for r in p['term_structure'] if r['tenor']==name)


def test_flat_vol_all_tenors_and_no_maturity_extrapolation():
    q = chain(3)|chain(40)|chain(100)|chain(200)
    p = build_skew_snapshot(q, as_of_ms=NOW)
    for r in p['term_structure']:
        assert r['status']=='ok', r
        assert r['skew_25_normalized']==pytest.approx(0, abs=1e-12)
        assert r['put_25_iv_percent']==pytest.approx(40)
        assert r['tail_gap_vol_points']==pytest.approx(0, abs=1e-12)
    assert tenor(build_skew_snapshot(chain(20)|chain(40),as_of_ms=NOW),'180d')['validation_reasons']==['no_maturity_bracket']


def test_delta_root_reprices_and_time_interpolation_is_variance():
    p = build_skew_snapshot(chain(20,30)|chain(40,50), as_of_ms=NOW)
    r = tenor(p)
    assert r['put_25_iv_percent']==pytest.approx(math.sqrt((.3**2*20+.5**2*40)/2/30)*100)
    for expiry in p['listed_expiries']:
        for name, wing in expiry['wings'].items():
            if wing['status']!='ok':
                continue
            w = wing['total_variance']
            d1 = (math.log(wing['forward_usd']/wing['strike'])+w/2)/math.sqrt(w)
            assert norm.cdf(d1 if name.startswith('call') else -d1)==pytest.approx(int(name.split('_')[1])/100, abs=1e-9)


@pytest.mark.parametrize('change',[{'snapshot_ts':NOW-300_001},{'bid_size':0},{'forward_source':'index_price'}, {'ask_price':.001}, {'mark_iv':80}])
def test_bad_books_do_not_publish(change):
    q={k:replace(v,**change) for k,v in (chain(20)|chain(40)).items()}
    assert tenor(build_skew_snapshot(q,as_of_ms=NOW))['status']=='unavailable'


def test_failed_immediate_expiry_not_skipped():
    q=chain(20)|chain(40)|{k:replace(v,bid_size=0) for k,v in chain(35).items()}
    r=tenor(build_skew_snapshot(q,as_of_ms=NOW))
    assert r['status']=='unavailable'
    assert r['upper_dte_days']==35


def test_missing_tail_does_not_remove_body_and_one_tenor_does_not_remove_others():
    q=chain(3)|chain(40)|chain(100)|chain(200)
    # Remove only the distant 200-day quotes (leaving ATM, but no wing brackets).
    q={k:v for k,v in q.items() if v.expiration_timestamp!=NOW+200*DAY or '-99500-' in k or '-100500-' in k}
    p=build_skew_snapshot(q,as_of_ms=NOW)
    assert tenor(p,'180d')['status']=='unavailable'
    assert tenor(p)['status']=='ok'
    # Discovery-style filtering removes 10d quotes but retains 25d and ATM.
    from vol_surface.skew import abs_delta
    q=chain(20)|chain(40)
    def central(s):
        strike=float(s.instrument_name.split('-')[2]); side='put' if s.instrument_name.endswith('P') else 'call'
        w=.4**2*((s.expiration_timestamp-NOW)/DAY)/365
        return abs_delta(math.log(strike/100_000),w,side)>.16
    p=build_skew_snapshot({k:v for k,v in q.items() if central(v)},as_of_ms=NOW)
    r=tenor(p)
    assert r['status']=='ok'
    assert r['metric_reasons']['skew_10']
    assert 'skew_10_normalized' not in r and 'tail_gap_vol_points' not in r


def test_asynchronous_expiries_and_original_quote_expiry():
    q=chain(20)|{k:replace(v,snapshot_ts=NOW-60_001) for k,v in chain(40).items()}
    assert 'asynchronous_quotes' in tenor(build_skew_snapshot(q,as_of_ms=NOW))['validation_reasons']
    q={k:replace(v,snapshot_ts=NOW-200_000) for k,v in (chain(20)|chain(40)).items()}
    assert build_skew_snapshot(q,as_of_ms=NOW)['valid_until_ms']==NOW+100_000


def test_selector_uses_all_expiries_and_actual_tickers_required():
    q=chain(3)|chain(40)|chain(200)
    rows=[{'instrument_name':k,'underlying_price':v.spot_price,'mark_iv':v.mark_iv} for k,v in q.items()]
    selected=select_skew_instruments(rows,as_of_ms=NOW)
    assert {q[k].expiration_timestamp for k in selected}=={NOW+d*DAY for d in (3,40,200)}
    assert tenor(build_skew_snapshot({k:q[k] for k in selected},as_of_ms=NOW))['status']=='ok'


def test_archive_failures_and_legacy_isolation(tmp_path,monkeypatch):
    monkeypatch.setattr(skew_refresh.time,'time',lambda:NOW/1000)
    provider=SimpleNamespace(fetch_skew_greeks=lambda:chain(20)|chain(40))
    worker=skew_refresh.SkewRefresher(tmp_path)
    worker.refresh_once(provider)
    original=read_json(tmp_path/skew_refresh.LIVE_FILENAME)
    assert original['capture_validated'] is True
    loaded=skew_refresh.load_skew(tmp_path,now_ms=NOW)
    assert loaded['history']['skew_25']['30d']==[{'ts_ms':NOW,'value':pytest.approx(0,abs=1e-12)}]
    write_atomic(tmp_path/'vol_surface_history_v2.json', {'samples':[{'ts_ms':NOW-DAY,'rr_25':{'30d':999}}]})
    provider.fetch_skew_greeks=lambda:(_ for _ in ()).throw(RuntimeError('network outage'))
    worker.refresh_once(provider)
    assert read_json(tmp_path/skew_refresh.LIVE_FILENAME)==original
    loaded=skew_refresh.load_skew(tmp_path,now_ms=NOW+1)
    assert loaded['refresh_status']['state']=='failed'
    assert len(loaded['history']['skew_25']['30d'])==1
    monkeypatch.setattr(skew_refresh.time,'time',lambda:(NOW+3_600_000)/1000)
    provider.fetch_skew_greeks=lambda:{}
    worker.refresh_once(provider)
    loaded=skew_refresh.load_skew(tmp_path,now_ms=NOW+3_600_000)
    assert len(loaded['history']['skew_25']['30d'])==1
    assert not loaded['capture_validated']
    assert all(r['status']=='unavailable' for r in loaded['term_structure'])


def test_separate_lease_and_duplicate_collector(tmp_path):
    atm=CollectorLease(tmp_path); first=skew_refresh.SkewRefresher(tmp_path); second=skew_refresh.SkewRefresher(tmp_path)
    try:
        assert atm.acquire() and first.lease.acquire()
        assert not second.lease.acquire()
    finally:
        atm.close();first.lease.close();second.lease.close()


def test_atm_rv_join_does_not_use_future_or_old_rv():
    p={'as_of_ms':NOW,'term_structure':[{'tenor':'30d','status':'ok','atm_iv_percent':40}]}
    rv=[{'ts_ms':NOW-1000,'value':30},{'ts_ms':NOW+1000,'value':99}]
    result=attach_atm_rv(p,rv)
    assert result['atm_vs_rv']['spread_percent']==10
    assert result['atm_vs_rv']['rv_as_of_ms']==NOW-1000
    assert attach_atm_rv(p,[{'ts_ms':NOW-3_600_001,'value':30}])['atm_vs_rv']['spread_percent'] is None
    assert 'atm_vs_rv' not in p


def test_local_price_violation_is_withheld():
    from vol_surface.skew import _local_wing
    from vol_surface.surface import SurfaceQuote
    a=SurfaceQuote('BTC',NOW+30*DAY,100_000*math.exp(-.1),'put',.4,100_000)
    b=SurfaceQuote('BTC',NOW+30*DAY,100_000*math.exp(-.05),'put',.3,100_000)
    snapshots={(q.expiry_ts_ms,q.strike,q.option_type):GreekSnapshot('test',0,100_000,NOW) for q in (a,b)}
    r=_local_wing([a,b],snapshots,t=30/365,forward=100_000,side='put',target=.25)
    assert r['reason']=='local_wing_price_checks_failed'


def test_history_does_not_bridge_missing_hour_or_import_future_capture(tmp_path):
    p=build_skew_snapshot(chain(20)|chain(40),as_of_ms=NOW)
    for offset in (0,2*3_600_000,4*3_600_000):
        stamp=NOW+offset
        write_atomic(tmp_path/skew_refresh.HISTORY_DIR/f'{stamp:013d}.json',
                     {**p,'as_of_ms':stamp,'valid_until_ms':stamp+300_000,'capture_validated':True})
    loaded=skew_refresh.load_skew(tmp_path,now_ms=NOW+3*3_600_000)
    points=loaded['history']['skew_25']['30d']
    assert len(points)==2 and points[1]['gap_before'] is True
