"""Pure numerical reference copied from the supplied open-source prototype.

This module intentionally preserves the live scanner math in ``D:/app.py``
without importing that module, because importing it also initializes the
Tk/Matplotlib GUI.  The source file used for this copy had SHA-256:

``5F528547A2828B00D5FF44457CF013CEBDAB2178CF257486D6DCE129CFE5D024``

Signal labels are preserved exactly (``NO TRADE`` with a space) so parity
tests can distinguish reference output from the dashboard API contract.
"""

from __future__ import annotations

import numpy as np
from scipy.integrate import simpson
from scipy.interpolate import UnivariateSpline
from scipy.ndimage import gaussian_filter1d
from scipy.stats import norm


DENSE_POINTS = 100
SMOOTHING_IV = 1.0
TAIL_THRESHOLD = 0.02
BAND_WIDTH = 0.03
SIGNAL_DELTA = 0.03
BAND_DELTA_MULT = 8
RISK_FREE_R = 0.0


def bs_call_price(S: float, K: float, T: float, r: float, sigma: float) -> float:
    if sigma <= 0 or T <= 0:
        return max(S - K, 0.0)
    d1 = (np.log(S / K) + (r + 0.5 * sigma**2) * T) / (
        sigma * np.sqrt(T)
    )
    d2 = d1 - sigma * np.sqrt(T)
    return float(S * norm.cdf(d1) - K * np.exp(-r * T) * norm.cdf(d2))


def build_pdf(
    spot: float,
    strike_arr: np.ndarray,
    iv_arr: np.ndarray,
    T: float,
    r: float = RISK_FREE_R,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    sort_idx = np.argsort(strike_arr)
    strike_arr, iv_arr = strike_arr[sort_idx], iv_arr[sort_idx]

    iv_spline = UnivariateSpline(strike_arr, iv_arr, s=SMOOTHING_IV)
    K_dense = np.linspace(strike_arr.min(), strike_arr.max(), DENSE_POINTS)
    iv_dense = np.clip(iv_spline(K_dense), 1e-4, None)

    prices = np.array(
        [bs_call_price(spot, K, T, r, iv) for K, iv in zip(K_dense, iv_dense)]
    )
    price_spline = UnivariateSpline(K_dense, prices, s=0)
    pdf_raw = price_spline.derivative(2)(K_dense) * np.exp(r * T)

    area = simpson(pdf_raw, x=K_dense)
    pdf_norm = pdf_raw / (area if area > 0 else 1.0)
    pdf_smooth = gaussian_filter1d(pdf_norm, sigma=2)
    return K_dense, pdf_norm, pdf_smooth


def compute_signals(
    spot: float,
    K_dense: np.ndarray,
    pdf_norm: np.ndarray,
    pdf_smooth: np.ndarray,
    tail_threshold: float = TAIL_THRESHOLD,
    band_width: float = BAND_WIDTH,
    signal_delta: float = SIGNAL_DELTA,
) -> dict:
    band_signal_delta = min(0.49, signal_delta * BAND_DELTA_MULT)
    pos = np.clip(pdf_norm, 0, None)

    up, dn = K_dense > spot, K_dense < spot
    p_up = simpson(pos[up], x=K_dense[up]) if up.any() else 0.0
    p_dn = simpson(pos[dn], x=K_dense[dn]) if dn.any() else 0.0
    skew_diff = abs(p_up - p_dn)
    skew_sig = (
        ("LONG" if p_up > p_dn else "SHORT")
        if skew_diff >= signal_delta
        else "NO TRADE"
    )

    cut_up, cut_dn = spot * (1 + tail_threshold), spot * (1 - tail_threshold)
    m_tu, m_td = K_dense > cut_up, K_dense < cut_dn
    p_tail_up = simpson(pos[m_tu], x=K_dense[m_tu]) if m_tu.any() else 0.0
    p_tail_dn = simpson(pos[m_td], x=K_dense[m_td]) if m_td.any() else 0.0
    tail_diff = abs(p_tail_up - p_tail_dn)
    tails_sig = (
        ("LONG" if p_tail_up > p_tail_dn else "SHORT")
        if tail_diff >= signal_delta
        else "NO TRADE"
    )

    peak_strike = K_dense[np.argmax(pdf_smooth)]
    if peak_strike > spot * 1.005:
        peak_sig = "LONG"
    elif peak_strike < spot * 0.995:
        peak_sig = "SHORT"
    else:
        peak_sig = "NO TRADE"

    band_lo, band_hi = spot * (1 - band_width), spot * (1 + band_width)
    m_band = (K_dense >= band_lo) & (K_dense <= band_hi)
    p_band = simpson(pos[m_band], x=K_dense[m_band]) if m_band.any() else 0.0
    p_outside = 1.0 - p_band
    if (p_outside > 0.5) and (
        abs(p_outside - p_band) >= band_signal_delta
    ):
        band_sig = skew_sig
    else:
        band_sig = "NO TRADE"

    active = [
        signal
        for signal in (skew_sig, tails_sig, peak_sig, band_sig)
        if signal != "NO TRADE"
    ]
    if not active:
        final = "NO TRADE"
    elif all(signal == active[0] for signal in active):
        final = active[0]
    else:
        final = "NO TRADE"

    return {
        "skew": {
            "signal": skew_sig,
            "p_up": p_up,
            "p_dn": p_dn,
            "diff": skew_diff,
        },
        "tails": {
            "signal": tails_sig,
            "p_up": p_tail_up,
            "p_dn": p_tail_dn,
            "diff": tail_diff,
        },
        "peak": {"signal": peak_sig, "peak_strike": peak_strike},
        "band": {
            "signal": band_sig,
            "p_band": p_band,
            "p_outside": p_outside,
        },
        "final": final,
    }
