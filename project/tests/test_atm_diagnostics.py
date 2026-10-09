import math

import pytest
from scipy.special import ndtr

from vol_surface.atm_diagnostics import price_iv


@pytest.mark.parametrize('side',['put','call'])
@pytest.mark.parametrize('index,forward',[(95_000,100_000),(105_000,100_000)])
def test_inverse_inversion_matches_discounted_usd_black(side,index,forward):
    years, strike, sigma = 30/365, 101_000, .55
    rate = math.log(forward/index)/years
    d1 = (math.log(index/strike)+(rate+sigma**2/2)*years)/(sigma*math.sqrt(years))
    d2 = d1-sigma*math.sqrt(years)
    usd = (index*ndtr(d1)-strike*math.exp(-rate*years)*ndtr(d2) if side=='call'
           else strike*math.exp(-rate*years)*ndtr(-d2)-index*ndtr(-d1))
    assert price_iv(usd/index,strike=strike,forward=forward,years=years,side=side) == pytest.approx(sigma)


@pytest.mark.parametrize('price',[0,-1,1,2,float('nan'),float('inf')])
def test_impossible_prices_cannot_return_iv(price):
    assert price_iv(price,strike=100_000,forward=100_000,years=30/365,side='call') is None
