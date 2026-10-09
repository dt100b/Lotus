from dataclasses import replace
from datetime import UTC, datetime
import math

import pytest

from greeks.types import GreekSnapshot
from vol_surface.atm_term import build_atm_term_curve, select_atm_instruments

ASOF = int(datetime(2026,10,7,8,tzinfo=UTC).timestamp()*1000)
DAY = 86_400_000


def chain(days, iv=40, strikes=(99_000,101_000)):
    expiry = ASOF+days*DAY
    date = datetime.fromtimestamp(expiry/1000,tz=UTC).strftime('%d%b%y').upper()
    result = {}
    for strike in strikes:
        side = 'P' if strike < 100_000 else 'C'
        name = f'BTC-{date}-{strike}-{side}'
        result[name] = GreekSnapshot(name,0,100_000,ASOF,mark_iv=iv,
            bid_price=.01,ask_price=.012,bid_size=2,ask_size=3,bid_iv=iv-1,ask_iv=iv+1,
            forward_source='ticker_underlying_price',expiration_timestamp=expiry)
    return result


def tenor(payload,name):
    return next(row for row in payload['term_structure'] if row['tenor']==name)


def test_flat_volatility_fixed_tenors_and_no_extrapolation():
    p=build_atm_term_curve(chain(3)|chain(40)|chain(200),as_of_ms=ASOF)
    assert tenor(p,'30d')['atm_iv_percent']==pytest.approx(40)
    assert tenor(p,'7d')['atm_iv_percent']==pytest.approx(40)
    assert tenor(p,'1d')['validation_reasons']==['no_maturity_bracket']
    assert tenor(p,'365d')['status']=='unavailable'


def test_time_interpolation_uses_variance_not_volatility():
    p=build_atm_term_curve(chain(20,30)|chain(40,50),as_of_ms=ASOF)
    expected=math.sqrt((.3**2*20+.5**2*40)/2/30)*100
    assert tenor(p,'30d')['atm_iv_percent']==pytest.approx(expected)
    assert tenor(p,'30d')['lower_dte_days']==20
    assert tenor(p,'30d')['upper_dte_days']==40


def test_far_wing_does_not_suppress_supported_atm():
    quotes=chain(20)|chain(40)
    quotes.update(chain(20,150,(80_000,)))
    assert tenor(build_atm_term_curve(quotes,as_of_ms=ASOF),'30d')['status']=='ok'


@pytest.mark.parametrize('mutation',[
    {'snapshot_ts':ASOF-300_001}, {'bid_size':0}, {'ask_price':.005},
    {'forward_source':'spot_fallback'}, {'mark_iv':80},
])
def test_bad_quotes_cannot_publish(mutation):
    q={k:replace(v,**mutation) for k,v in (chain(20)|chain(40)).items()}
    assert tenor(build_atm_term_curve(q,as_of_ms=ASOF),'30d')['status']=='unavailable'


def test_do_not_skip_failed_immediate_source_expiry():
    q=chain(20)|chain(40)|{k:replace(v,bid_size=0) for k,v in chain(35).items()}
    assert tenor(build_atm_term_curve(q,as_of_ms=ASOF),'30d')['validation_reasons']==['source_atm_unavailable']


def test_atm_calendar_failure_withheld():
    p=build_atm_term_curve(chain(20,90)|chain(40,30),as_of_ms=ASOF)
    assert tenor(p,'30d')['validation_reasons']==['atm_calendar_rejected']
    p=build_atm_term_curve(chain(7,90)|chain(20,30),as_of_ms=ASOF)
    assert tenor(p,'7d')['validation_reasons']==['atm_calendar_rejected']


def test_strikes_must_bracket_forward_nearby():
    p=build_atm_term_curve(chain(20,strikes=(90_000,110_000))|chain(40),as_of_ms=ASOF)
    assert tenor(p,'30d')['status']=='unavailable'
    p=build_atm_term_curve(chain(20,strikes=(99_000,))|chain(40),as_of_ms=ASOF)
    assert tenor(p,'30d')['status']=='unavailable'


def test_full_chain_selection_is_otm_and_inventory_independent():
    rows=[{'instrument_name':n,'underlying_price':100_000} for n in chain(20)]
    rows += [{'instrument_name':'BTC-27OCT26-99000-C','underlying_price':100_000}]
    assert select_atm_instruments(rows)==sorted(chain(20))


def test_forward_disagreement_rejected():
    q=chain(20)|chain(40)
    name=next(iter(q))
    q[name]=replace(q[name],spot_price=101_500)
    assert tenor(build_atm_term_curve(q,as_of_ms=ASOF),'30d')['status']=='unavailable'


def test_cached_quotes_do_not_gain_a_new_freshness_lifetime():
    q={k:replace(v,snapshot_ts=ASOF-200_000) for k,v in (chain(20)|chain(40)).items()}
    p=build_atm_term_curve(q,as_of_ms=ASOF)
    assert p['valid_until_ms']==ASOF+100_000
    assert p['oldest_quote_ts_ms']==ASOF-200_000


def test_far_wing_forward_and_age_do_not_contaminate_local_atm():
    q = chain(20)|chain(40)
    q.update({k:replace(v,spot_price=120_000,snapshot_ts=ASOF-290_000)
              for k,v in chain(20,150,(80_000,)).items()})
    p = build_atm_term_curve(q,as_of_ms=ASOF)
    assert tenor(p,'30d')['atm_iv_percent'] == pytest.approx(40)
    assert p['valid_until_ms'] == ASOF+300_000


def test_exact_atm_put_is_supported_without_a_call():
    q = chain(30,strikes=(100_000,))
    s = next(iter(q.values()))
    name = s.instrument_name[:-1]+'P'
    p = build_atm_term_curve({name:replace(s,instrument_name=name)},as_of_ms=ASOF)
    assert tenor(p,'30d')['atm_iv_percent'] == pytest.approx(40)


def test_temporally_incoherent_bracket_withheld():
    q = chain(20)|{k:replace(v,snapshot_ts=ASOF-60_001) for k,v in chain(40).items()}
    assert tenor(build_atm_term_curve(q,as_of_ms=ASOF),'30d')['validation_reasons'] == ['asynchronous_atm_quotes']


def test_bid_ask_and_midpoint_use_same_variance_brackets():
    from scipy.special import ndtr, ndtri
    # ATM inverse price has the analytic form 2*N(sigma*sqrt(T)/2)-1.
    q = chain(20,35,(100_000,))|chain(40,45,(100_000,))
    expected_mid_w = []
    for name,s in list(q.items()):
        years = (s.expiration_timestamp-ASOF)/DAY/365
        bid = 2*ndtr(s.bid_iv/100*math.sqrt(years)/2)-1
        ask = 2*ndtr(s.ask_iv/100*math.sqrt(years)/2)-1
        q[name] = replace(s,bid_price=bid,ask_price=ask)
        mid = 2*ndtri(((bid+ask)/2+1)/2)/math.sqrt(years)
        expected_mid_w.append(mid**2*years)
    p = build_atm_term_curve(q,as_of_ms=ASOF)
    row = tenor(p,'30d')
    assert row['atm_bid_iv_percent'] == pytest.approx(math.sqrt((.34**2*20+.44**2*40)/60)*100)
    assert row['atm_ask_iv_percent'] == pytest.approx(math.sqrt((.36**2*20+.46**2*40)/60)*100)
    assert row['atm_mid_iv_percent'] == pytest.approx(math.sqrt(sum(expected_mid_w)/2/(30/365))*100)
    assert row['atm_bid_iv_percent'] < row['atm_mid_iv_percent'] < row['atm_ask_iv_percent']
    assert all(r['source_quotes'] for r in p['listed_expiries'])


def test_repricing_mismatch_is_not_reported_as_a_mark_mid_discrepancy():
    row = tenor(build_atm_term_curve(chain(20)|chain(40),as_of_ms=ASOF),'30d')
    assert row['status'] == 'ok'
    assert 'atm_mid_iv_percent' not in row
    assert row['midpoint_validation_reasons'] == ['ticker_iv_repricing_mismatch']


def test_calendar_reversal_between_requested_tenors_cannot_leak_through():
    # Each target's own bracket is increasing, but 8D -> 20D reverses variance.
    q = chain(3,90)|chain(8,90)|chain(20,30)|chain(40,30)
    p = build_atm_term_curve(q,as_of_ms=ASOF)
    assert tenor(p,'7d')['validation_reasons'] == ['atm_calendar_rejected']
    assert tenor(p,'30d')['validation_reasons'] == ['atm_calendar_rejected']
