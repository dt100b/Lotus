from dataclasses import replace
import json
import math
from pathlib import Path

import numpy as np
import pytest

from greeks.types import GreekSnapshot
from vol_surface.surface import (SurfaceQuote, build_slices, calendar_valid, decimal_iv,
                                 metrics_for_smile, quotes_from_greeks, smile_at_tenor)
from vol_surface.snapshot import _compact, attach_parkinson_rv, build_vol_surface_payload, history_series
from vol_surface.parkinson import rolling_parkinson_series

ASOF = 1_780_000_000_000
HOUR = 3_600_000
DAY = 24*HOUR


def quotes(days, ivs, ks=(-.3,-.15,0,.15,.3)):
    return [SurfaceQuote('BTC',ASOF+days*DAY,100_000*math.exp(k),
                         'put' if k<0 else 'call',iv,100_000) for k,iv in zip(ks,ivs)]


def good_quote():
    return GreekSnapshot('BTC-6OCT26-90000-P',0,100_000,ASOF,mark_iv=50,
                         bid_price=.01,ask_price=.011,bid_size=1,ask_size=1,
                         bid_iv=49,ask_iv=51,forward_source='ticker_underlying_price')


@pytest.mark.parametrize('changes', [
    {'snapshot_ts':ASOF-301_000}, {'snapshot_ts':ASOF+6_000},
    {'forward_source':'spot_fallback'}, {'bid_price':None}, {'ask_price':.009},
    {'bid_size':0}, {'ask_iv':48}, {'ask_price':.05},
])
def test_bad_quotes_cannot_enter_dashboard_surface(changes):
    q = replace(good_quote(),**changes)
    assert quotes_from_greeks({q.instrument_name:q},as_of_ms=ASOF)==[]


def test_explicit_venue_iv_units_and_quality():
    q = good_quote()
    assert len(quotes_from_greeks({q.instrument_name:q},as_of_ms=ASOF))==1
    assert decimal_iv(2,unit='percent')==.02
    assert decimal_iv(.5,unit='decimal')==.5


def test_butterfly_invalid_smile_has_no_headline_metrics():
    chain = quotes(30,[.55,.52,.70,.48,.5])
    fitted = build_slices(chain,as_of_ms=ASOF)[0]
    row = metrics_for_smile(fitted)
    assert row['status']=='rejected'
    assert 'butterfly_rejected' in row['validation_reasons']
    payload = build_vol_surface_payload(chain,as_of_ms=ASOF,rv_30d_percent=30)
    assert payload['atm_vs_rv']['spread_percent'] is None
    assert 'atm_iv_percent' not in payload['term_structure'][2]


def test_calendar_checks_between_knots():
    w1 = [.022392436571938838,.00822977828130779,.03793468807135412,.039215334650316784,.03161505163953199]
    w2 = [.022643771407358147,.01055157700498915,.03804219266159475,.042907030505774116,.031849123908342485]
    smiles = build_slices(quotes(20,[math.sqrt(w/(20/365)) for w in w1])+
                          quotes(40,[math.sqrt(w/(40/365)) for w in w2]),as_of_ms=ASOF)
    assert not calendar_valid(*smiles)
    assert smile_at_tenor(smiles,target_years=30/365)[0] is None


def test_maturity_variance_blend_is_exact_between_knots():
    ks=(-.3,-.15,0,.15,.3)
    smiles=build_slices(quotes(20,[.5-.1*k for k in ks])+quotes(40,[.55+.2*k for k in ks]),as_of_ms=ASOF)
    fitted,_,ok=smile_at_tenor(smiles,target_years=30/365)
    assert fitted is not None and ok
    for k in np.linspace(-.3,.3,101):
        expected = sum(s.total_variance(float(k))[0] for s in smiles)/2
        assert fitted.total_variance(float(k))[0]==pytest.approx(expected,abs=1e-14)


@pytest.mark.parametrize('problem',['missing','duplicate','malformed'])
def test_rv_requires_unique_complete_hourly_coverage(problem):
    bars=[(ASOF+i*HOUR,101.,100.) for i in range(24)]
    if problem=='missing': del bars[10]
    if problem=='duplicate': bars[10]=bars[9]
    if problem=='malformed': bars[10]={'ts_ms':bars[10][0],'high':'bad','low':100}
    assert rolling_parkinson_series(bars,lookback_bars=24)==[]


def test_rv_cannot_be_known_before_final_bar_closes():
    bars=[(ASOF+i*HOUR,101.,100.) for i in range(24)]
    assert rolling_parkinson_series(bars,lookback_bars=24,as_of_ms=ASOF+DAY-1)==[]
    result=rolling_parkinson_series(bars,lookback_bars=24,as_of_ms=ASOF+DAY)
    assert result[0]['ts_ms']==ASOF+DAY


def test_surface_rv_join_drops_mismatched_times_and_invalid_atm():
    p={'as_of_ms':ASOF,'term_structure':[{'tenor':'30d','status':'ok','atm_iv_percent':50}]}
    assert attach_parkinson_rv(p,30,rv_as_of_ms=ASOF)['atm_vs_rv']['spread_percent']==20
    assert attach_parkinson_rv(p,30,rv_as_of_ms=ASOF-3*HOUR)['atm_vs_rv']['spread_percent'] is None
    p['term_structure'][0]['status']='rejected'
    assert attach_parkinson_rv(p,30,rv_as_of_ms=ASOF)['atm_vs_rv']['spread_percent'] is None


def test_history_wings_match_header_definition():
    h=history_series([{'ts_ms':ASOF,'atm':{'30d':50},'rr_25':{'30d':5},'rr_10':{'30d':8}}])
    assert h['skew_25']['30d'][0]['value']==.1
    assert h['skew_10']['30d'][0]['value']==.16
    assert h['tail_gap']['30d'][0]['value']==3


def test_history_repeated_snapshot_time_replaces_sample():
    prior = {'ts_ms': ASOF, 'atm': {'7d': 30}, 'rr_25': {}, 'rr_10': {}}
    current = {**prior, 'atm': {'7d': 31}}
    rows = _compact([prior, current], now_ms=ASOF)
    assert rows == [current]
    assert history_series(rows)['atm']['7d'] == [{'ts_ms': ASOF, 'value': 31}]


def test_frozen_market_rejected_smiles_cannot_publish():
    raw=json.loads((Path(__file__).parent/'fixtures/deribit_book_summary_2026-10-07.json').read_text())
    rows=raw['result']
    greeks={r['instrument_name']:GreekSnapshot(r['instrument_name'],0,float(r['underlying_price']),ASOF,mark_iv=r['mark_iv']) for r in rows}
    chain=quotes_from_greeks(greeks)
    # Use the original capture time to reproduce listed maturities.
    captured=1_791_405_342_697
    payload=build_vol_surface_payload(chain,as_of_ms=captured)
    assert any(r['status']=='rejected' for r in payload['listed_expiries'])
    assert all('atm_iv_percent' not in r for r in payload['listed_expiries'] if r['status']=='rejected')
