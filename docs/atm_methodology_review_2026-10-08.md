# ATM IV implementation review — October 8, 2026

The forward-ATM, ACT/365, exact-tenor definition remains appropriate for this
descriptive chart. The important defects were around quote selection, temporal
coherence, uncertainty, and capture lifecycle. Replacing this estimator with SVI
is not necessary to fix those defects.

## Findings and implemented remedies

| Finding | Consequence | Remedy |
|---|---|---|
| Discovery dropped summary rows without a valid forward before recording their expiry. | An unavailable intermediate expiry could disappear, allowing a wider maturity bracket. | Preserve a non-publishable placeholder for every BTC expiry observed in discovery, including expiries with no selected candidates. |
| All accepted quotes influenced the expiry forward and global quote lifetime, including distant wings. | An unrelated wing forward or old timestamp could suppress otherwise supported ATM values. | Filter to the local 0.025 log-moneyness neighborhood before forward estimation; lifetime now uses actual selected source quotes. |
| Exact-forward selection accepted calls only. | A valid put at K=F could be rejected for lack of a bracket. | Accept either side at K=F; when both are available, use their median variance. |
| Individual freshness did not imply a coherent capture. | Two quotes up to five minutes apart could be treated as contemporaneous. | Reject strike or maturity brackets whose selected timestamps differ by more than 60 seconds. The five-minute input age limit remains. |
| Calendar checks could miss a reversal between two requested tenor brackets. | Two individually accepted interpolations could conceal a decreasing listed variance interval between them. | Reject targets whose source expiries touch a failing adjacent listed ATM calendar interval. Unavailable intermediate expiries still cannot be skipped. |
| Only the mark estimate was published. | Users could not distinguish mark positioning from spread uncertainty. | Interpolate bid and ask total variance through the same strike and maturity brackets; expose both alongside the mark. These are estimated quote ranges, not executable prices or statistical confidence intervals. |
| There was no independent inversion of quoted prices. | A mark/mid disagreement could not be measured. | Invert the actual BTC bid/ask price midpoint with the inverse-option convention below. Compare independently solved bid/ask IVs with the ticker first; withhold midpoint diagnostics if either differs by more than 0.5 vol points. |
| Quote expiry and captured-observation validity were the same concept. | A ten-minute collection interval would blank the curve after five minutes. | Keep original input expiry, add explicit validated-capture and scheduling metadata, and hold the captured chart with its actual timestamp. A browser clock displays “Update overdue” after the next scheduled boundary plus one minute, even without new API data. Legacy artifacts retain their old freshness checks. |
| Collection was start-relative every 60 seconds. | Capture times drifted and did not match the requested analytical cadence. | Default to 600 seconds, perform one startup capture, then collect on UTC boundaries. Skip elapsed boundaries after slow requests; do not issue catch-up bursts. |
| Rewind retained only the first observation per hour. | Successful captures were permanently discarded. | Archive every successful capture, before publishing it, in `atm_term_history/captures/<capture_ms>.json`. Preserve legacy hourly files and read both formats. Failures never renew the previous artifact's timestamps or deadline. |
| ATM History read the broader smile-fitter history. | Live and historical charts could use different ATM estimators. | Populate ATM History from this collector's archive. Display the last capture per UTC hour over the trailing year; retain all original captures for Rewind and audit. No legacy smile history is relabeled. |
| Source contracts were not embedded in the continuous artifact. | A retained curve could not be fully reconstructed from its own inputs. | Save selected source snapshots, forward, strikes, quote timestamps, variance, maturity weights, and diagnostic rejection reasons. |

Implementation: `project/vol_surface/atm_term.py`, `atm_diagnostics.py`,
`atm_refresh.py`, `atm_history.py`, the discovery provider, API adapter, and
frontend capture/diagnostic presentation. The headline estimator remains
`atm_term_curve.v1`; additive diagnostics identify themselves as
`atm_diagnostics.v1`. Historical files retain their original values and metadata.

## Independent midpoint convention

For inverse BTC options, Deribit's documented pricing convention uses
`R = log(F / index) / T`. Converting its discounted USD option value to BTC by
dividing by the index cancels the discount/forward factor:

`call_BTC = N(d1) - (K/F) N(d2)`

`put_BTC = (K/F) N(-d2) - N(-d1)`

`d1 = [log(F/K) + sigma² T / 2] / (sigma sqrt(T))`.

The solver uses each ticker's own forward and observation time. It inverts the
price midpoint, not the average of bid and ask IV. It rejects impossible prices,
solutions outside (0%, 500%], missing inputs, and the final 30-minute settlement
window. A mismatch with quoted bid/ask IV suppresses the diagnostic, not the
already validated mark estimate. Midpoint calendar failures also suppress that
diagnostic. Bid/ask estimates remain descriptive and are not independently
certified arbitrage-free curves.

Sources: [Deribit inverse-option specification](https://support.deribit.com/hc/en-us/articles/31424939096093-Inverse-Options),
[ticker field definitions](https://docs.deribit.com/api-reference/market-data/public-ticker),
and [settlement-period underlying adjustments](https://support.deribit.com/hc/en-us/articles/25944751433757-Delta-decay-during-settlement).

## Live cross-check

A read-only fetch at **2026-10-08 23:41:45 UTC** examined 144 ticker candidates;
24 source quotes supported the listed ATM estimates. It wrote a separate audit
artifact and did not replace the running collector's latest artifact.

| Tenor | Mark IV | Estimated bid–ask IV | Independent midpoint IV | Mark minus midpoint |
|---|---:|---:|---:|---:|
| 7D | 33.586% | 32.694–33.682% | 33.190% | +0.397 vol points |
| 30D | 35.574% | 35.074–35.922% | 35.497% | +0.078 vol points |
| 60D | 37.159% | 36.794–37.546% | 37.169% | −0.010 vol points |
| 180D | 37.986% | 37.811–38.238% | 38.025% | −0.039 vol points |

365D correctly remained unavailable because no maturity bracket existed. This
single observation validates the integration and pricing convention on that
capture; it does not establish long-run calibration performance.

Evidence: `runtime/desk_surface_audit/atm_methodology_review_live.json`.

## Remaining limits and operational solutions

1. **Collector uptime:** the changes take effect when the collector and API are
   restarted with this code. No running service was restarted during this review.
   The existing live refresh process starts the collector automatically; the
   standalone command is `.venv/Scripts/python.exe project/scripts/collect_atm_term_curve.py`.
   Its default interval is now 600 seconds. For collection while this computer is
   off, run the collector on an always-on host with a persistent artifacts volume
   and process restart supervision. A browser or an on-demand API cannot backfill
   missed market snapshots.
2. **Discovery completeness:** placeholders protect expiries actually returned
   by the summary endpoint. They cannot recover an expiry omitted entirely by
   that endpoint. An authoritative instrument-catalog reconciliation is a useful
   next gate if this occurs in recorded failures.
3. **Limited arbitrage scope:** local price checks and ATM calendar checks still
   do not certify a complete arbitrage-free surface. Constrained SVI/SSVI should
   be a separate validated research comparison, not an automatic replacement.
   See [Gatheral and Jacquier](https://arxiv.org/abs/1204.0646).
4. **Heuristic thresholds:** 2.5% log-moneyness, 0.5% forward dispersion, 50%
   relative price spread, 60-second capture skew, and 0.5-vol-point repricing
   tolerance are explicit quality policies, not mathematical guarantees. Tune
   them from archived rejection rates and pricing residuals across calm, stressed,
   and settlement periods. Do not silently widen them to fill gaps.
5. **Historical coverage:** Rewind chooses a capture at or before the requested
   elapsed-day target, at most two hours earlier, and returns the actual offset.
   It never fabricates a missing day. New ten-minute collection improves coverage
   prospectively; historical missing intervals remain missing. The time-series
   chart samples hourly and may visually connect available observations across
   missing periods; the archive is the authoritative record of coverage.
6. **Storage:** preserving every capture with source quotes costs more than the
   previous hourly estimate. The audit payload is about 29 KB: approximately
   1.5 GB/year at ten-minute cadence before filesystem overhead. Plan disk capacity
   and backups; no retention/deletion policy was introduced.
7. **Frontend retention exception:** the existing listed-chart behavior that
   holds the front expiry through later quote failures remains. That per-expiry
   cache can be older than the overall capture timestamp. If freshness attribution
   is required there, carry a per-point capture time and label retained points;
   it does not affect the constant-maturity estimator.

## Verification

Full backend suite: **400 passed, 1 skipped**. After the final startup-boundary
scheduling correction, all **12 collector tests** also passed, including the
new case where a fetch starts before a UTC boundary and completes after it.

Regression coverage includes mathematical inversion, independent discounted USD
pricing fixtures, variance interpolation, rejected prices, exact-ATM puts,
far-wing isolation, quote-time coherence, missing discovery forwards, calendar
reversals between targets, UTC scheduling, failure retention, immutable capture
files, legacy archives, and estimator-consistent hourly history.

The frontend production build, targeted lint, term-curve geometry checks, and
capture lifecycle checks passed. Headless Chromium checks passed at 424, 320,
and 250 pixels: the curve survives input expiry, becomes visibly overdue from
clock time, exposes bid/ask and midpoint diagnostics on focus, and uses local
ATM history. No page errors were observed. Screenshots are under
`runtime/desk_surface_audit/atm_methodology_*.png`.
