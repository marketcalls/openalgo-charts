# Numerical audit

The audit inventories all 105 shipped indicator descriptors and compares
equivalent calculations with both companion language engines. Inventory and
successful execution are not numerical conformance. The complete audit remains
open, including documented differences in seeds and missing-value behavior.

The expanded ADX audit found a Python-only defect after 0.7.0 publication:
selected movement can overflow from finite prices and enter recursive state
without normalization. A five-bar fixture has four differing cells; native and
npm recover while Python remains unavailable. A corrective patch is being
prepared in an isolated checkout. The earlier recorded corpus remains useful
evidence for its tested inputs, but it does not establish agreement on this new
boundary.

## Directional movement seed

Positive and negative movement now seed from the same first real change window
as true range. A synthetic rising series with a unit movement and a two-unit
range therefore reports positive direction 50 as soon as it is available.
Including a fabricated zero movement at the first bar previously biased this
reading downward.

For high/low/close rows `(10,8,9)`, `(12,9,11)`, `(11,7,8)`, `(13,9,12)` and
`(12,10,11)`, with both lengths set to 2, independently derived strength is
`[null,null,null,25,37.5]`. The final positive and negative readings are 24 and 8.
Both companion engines already produce these ordinary-case results.

That seed correction preserved first-available indices and the then-existing
chart behavior on zero range and absent observations. The later seeded recurrence
audit exposed a separate gap: unavailable high/low changes were counted as zero,
while an unavailable true-range seed or update could leave ratios frozen forever.
Correcting the recurrence alone let true range resume and exposed those decayed
movement numerators. The observation-policy correction treats unavailable
movements as absent, retains each smoother's state and requires current
directional readings before advancing strength.

Zero smoothed true range also leaves both directional ratios and strength absent,
matching the companion contract. The previous native display carry could repeat
a stale ratio and feed its DX into the strength smoother despite an undefined
current division. A flat bar's zero movement remains a real finite observation;
an unavailable high/low change does not become a zero movement.

The observation correction passes 267 focused tests. Fifteen freshly compiled
cases compare 396 cells exactly between native and npm. Fourteen cases and
381 cells also agree with Python; the remaining finite-difference overflow
fixture exposes the four-cell Python defect described above. A separate
independent seven-case corpus matches 114 cells across all three implementations,
covering flat ranges and resumed strength. All 45 affected numerical browser
cases pass across three engines, including gaps, zero ranges and forming-bar
rewrites; actual screenshots were inspected.

Verification includes 129 focused unit tests, same-time chart updates and prefix
execution. A built-package browser regression first reproduced the old wrong
values, then passed exact readings and rendered-line pixels in all three browser
engines. Screenshots were inspected. Typechecking, scoped lint, build and bundle
budgets passed. That development build measured 36.00 kB Brotli for the indicator
tier and 289.25 kB for all tiers together.

## Hull window lengths

The standalone HMA now shares the integer-window kernel used by Hull Suite's Hma
mode and both companion engines. The fast window is `max(1,floor(length/2))` and
the smoothing window is `max(1,round(sqrt(length)))`. Length 1 returns its source.
The former fractional half window changed the slope response at odd lengths;
flooring the outer square root could also emit a value before the agreed warmup.

Independent straight-line lag fixtures cover lengths 1, 2, 9, 13, 16 and 25.
At length 9 a ramp is followed without lag once warm; at length 13 the lag is
one third of a bar and the first reading is at zero-based index 15. Flat values,
source holes, recovery and prefix execution are checked separately. These are
formula comparisons; unchanged summation orders can still differ in last bits
from the companion engines and remain part of the wider audit.

The Hull batch passes 173 focused unit tests, typechecking and scoped lint.
Built-package Hull and directional-value regressions pass in all three browser
engines, with screenshots inspected. Fifteen matching compiled programs produce
identical bits between the companion engines. The six Hull fixtures now match
the chart formulas and availability within the stated `1e-12` comparison;
directional zero-range and absent-data differences remain open. The current
build measures 35.90 kB Brotli for indicators and 289.15 kB for all tiers, within
their budgets.

The companion audit additionally reproduced and corrected changing-length,
volume-anchor, overflow and partial-output disagreements. Both packages are
published at 0.7.0 from source `f9ab00e4`. The chart release remains 2.5.4 and is
pending the remaining native capability work.

## Wider compiled comparisons

The complete descriptor inventory now exercises all 105 descriptors and 266
declared outputs. The 1,148 compiled cases compare 1,287,674 output cells between
the companion engines without differing bits or absence. This includes secondary
lines, bands, displaced outputs, event columns and explicitly identified table
carriers. Calendar fixtures separately check 86,866 table cells. Event tests
distinguish confirmation indices from plotted origin indices, so a backdated
marker cannot conceal premature availability.

The companion release gates also pass all 116 scalar and stateful numerical
signatures: 6,836 cases and 1,504,908 accepted calls. Independent field shocks,
declared defaults, changing lengths, checkpoint restoration and replay are
included. Power, trigonometry, exponential, logarithmic and hypotenuse kernels
have independent rounding evidence. Fresh installed distributions run 363
compiled programs, with 124,977 exact cross-engine cells and 6,756 independently
expected cells. These finite corpora are not a proof of every possible history.

The same installed-program and independent-oracle checks pass using downloaded
public 0.7.0 distributions. All 1,617 package files, 108 wheel modules and 181
source-distribution files match the immutable source or the verified generated
build. Registry integrity and attestation subject, source and workflow claims
match; cryptographic signatures and transparency inclusion were not verified.

After the RSI correction, 197 outputs differ in at least one exercised case,
38 agree on the sampled finite inputs and 27 are
constant outputs. Two outputs carry tables, and two event columns that are
absent in broad fixtures have separate finite, independently derived fixtures.
Differences include arithmetic order, gaps and documented algorithm choices;
the count does not mean every difference is a calculation defect. Neither a
relative tolerance nor two identically absent outputs establishes agreement.

A later source refresh after the chronological-window and CPR corrections runs
all 1,148 existing cases against their recorded compiled outputs. It compares
1,286,742 aligned cells: the recorded companion outputs still agree exactly,
while 135 native output columns differ in at least one case. Another 99 columns
agree across varied finite values, 28 have only one distinct finite value and
four have no finite observations in this corpus. These last two categories are
not evidence of numerical equivalence. This refresh does not rerun compilation,
calendar-table oracles or causal marker timing. Remaining differences include
ordinary last-bit arithmetic, missing observations and distinct algorithms.

After seeded recurrence recovery, the same recorded corpus has 109 differing
columns and 125 with exact varied finite observations. Single-value and absent
categories are unchanged. Total differing cells decrease from 126,450 to 105,031;
38 columns improve and none increase in total differences. Availability
differences fall from 75,899 to 51,271, while finite-bit differences rise from
50,551 to 53,760 as recovered output exposes remaining arithmetic differences.
This is another source refresh against recorded engine results, not new
compilation or a universal equivalence claim.

The directional observation correction makes its three columns exact on this
same corpus, leaving 106 differing columns and 128 with exact varied finite
observations. It removes another 5,001 differences, leaving 100,030 differing
cells. Constant/absent classifications are unchanged. The new Python overflow
counterexample is outside these recorded inputs, so agreement of the recorded
engine arrays cannot support a global claim about the published engines.

## Confirmed boundary corrections

Default positive safe-integer scalar `smaSeededEma` and `rma` now seed from the
first complete finite chronological window. Missing or overflowing seed windows
can expire and recover. After seeding, an absent input emits a gap while keeping
the running state. A nonfinite update from a finite input stays committed rather
than freezing or reseeding. Public first-value EMA, explicit compensated options,
resolved study-source propagation and unsupported scalar paths retain their
existing behavior.

The correction passes 420 focused tests, including 27 new cases. Seventeen fresh
compiled fixtures compare 340 cells exactly across native, npm and Python
calculations, covering twelve helper cases, four composed studies and signed
zero. Independent review checks 20,000 generated cases and 161,328 cells against
a separate seed-search oracle, plus 90,000 exact comparisons of preserved routes
against the previous commit. This is finite-corpus evidence, not a universal
equivalence claim for every composed study.

Both new browser regressions failed against the previous bundle. All 45 affected
numerical browser cases then passed across three engines. New checks cover actual
line and marker pixels, gap recovery and forming-bar replacement/removal. Six
representative recurrence screenshots and six directional screenshots were inspected.

Ordinary recurrence costs O(bars + period), with constant working space excluding
output. Repeated overflowing seed windows can cost O(bars * period). At 20,000
bars and period 1,000, measured median times are 0.16 ms for seeded EMA and
0.11 ms for RMA on ordinary finite data, and 10.58 ms and 10.47 ms respectively
with repeated overflowing seed windows. These are observations on the validation
machine, not timing guarantees.

Default positive safe-integer scalar SMA and rolling sums now add each current
window oldest first. Only missing-observation counts are carried between windows.
Nonfinite sums remain unavailable; SMA divides the finite sum once. A singleton
window retains its finite input and normalizes signed zero. This fixes both
expired-overflow poisoning and an ordinary finite cancellation example that
previously created a false MA Cross signal. Explicit SMA options, including an
empty options object, and varying-length windows retain their separate compensated
arithmetic. Unsupported scalar-period behavior is unchanged.

The correction passes 535 focused tests. Nine compiled cases compare 64 cells
exactly against both companion engines. Work is proportional to bars times period,
with constant extra working storage excluding the returned array. At 20,000 bars,
recorded medians are 0.33 ms for SMA length 9 and 17.71 ms for length 1,000; MA Cross
takes 1.68 ms at defaults and 38.49 ms with both lengths at 1,000. These measured
costs do not change performance budgets or constitute timing guarantees.

Default scalar weighted averages, population deviations and absolute deviations
also accumulate terms oldest first and normalize nonfinite final readings. Their
separate compensated option and varying-length paths remain unchanged. The
correction passes 231 focused tests and 147 exact native/npm/Python cells through
nine newly executed compiled programs, including ordinary last-bit differences,
weighted cancellation, overflow, missing observations and recovery.

CPR seeds high and low only at the existing session or calendar boundaries. A
nonfinite extreme invalidates the whole period; later finite observations cannot
erase it. The next complete period recovers normally. The final close remains
the period's close, and existing display flags and formulas are unchanged. The
correction passes 165 focused tests and matches 270 recorded compiled cells in
the independently specified incomplete-period fixture. The compiled composition
uses explicitly matched boundaries, not a general exchange-calendar guarantee.

Balance of Power now omits nonfinite numerators, ranges and ratios while
preserving finite ordinary results and recovery on the following bar.

Money Flow Index rejects nonfinite selected price flows and window totals before
its zero-negative-flow shortcut. Each window is summed oldest first, correcting
ordinary last-bit differences as well as recovery after expired overflow. Missing
volume still defaults to zero; tied finite prices still contribute zero even
when their unused price-volume product overflows. Twenty-two actual compiled
cases and 991 independent expected cells match the native calculation and both
released companion engines exactly. Sixteen dedicated regressions pass.

This retains work proportional to bars times period. On the recorded machine,
50,000 bars take a median 2.99 ms at period 14 and 17.72 ms at period 500, compared
with 2.07 ms and 22.60 ms before the correction. These are observations, not
timing guarantees or relaxed performance budgets.

WaveTrend computes its signal mean from the chronological window. An incremental
sum previously drifted enough to create a false crossing on a simple rising
series. AlphaTrend's private mean and flow sums use the same fresh-window
principle so an expired infinite contribution cannot poison all later values.
This costs work proportional to bars times period. On the recorded machine,
20,000 bars at AlphaTrend period 500 take a median 32.42 ms rather than 3.62 ms;
WaveTrend with signal length 100 takes 8.58 ms rather than 4.81 ms. These are
observations, not new timing guarantees or raised engine performance budgets.

Seasonality excludes nonfinite month returns from the table and its counts.
Aggregate means or deviations that overflow remain blank. Finite return order,
ignored-month behavior and the still-forming month are unchanged. Table tests
scan headers, body and summary for nonfinite display text.

The composition audit also found overflow boundaries in companion TSI, RSI,
Ultimate Oscillator, MFI, CCI and correlation. Their corrections are verified in
both language runtimes, including compiled historical and forming updates.

Native RSI now treats a missing or overflowing change as unavailable, retaining
any already-seeded gain and loss averages. Unseeded legs independently seek a
complete finite suffix and finite mean. Running arithmetic overflow retains its
state and stays unavailable, instead of silently restarting or emitting zero or
100. Ordinary finite arithmetic and the function signature are unchanged.
All five built-in consumer paths and `rsiSeries` inherit the corrected behavior.
Six actual compiled fixtures agree bit-for-bit with both companion engines.
On the recorded machine, an ordinary 20,000-bar run changes from 0.12 to 0.23 ms.
Repeated failed seeds can require fresh period-length sums before recovery.

The built package passes 21 numerical browser cases across three engines,
including ordinary directional and Hull values, RSI recovery, absent Balance
of Power points, WaveTrend crossing markers, AlphaTrend recovery and finite
Seasonality table pixels. Screenshots were inspected.

## Gap recovery in running studies

The classification of the refreshed comparison attributed six further causes to
the chart: a missing observation that removed a running study for the rest of
the history, or a regrouped formula. Each is now corrected at its source, and a
missing input costs only the bars it covers.

- The base `atr` seeds from the first complete window of finite true ranges,
  keeps its average across a missing or overflowing true range and resumes from
  it. A running overflow stays unavailable instead of reseeding. Keltner,
  Chandelier Exit, Chande Kroll Stop, Median, HalfTrend, Volatility Stop and
  `supertrend` read it and inherit the correction, and Volatility Stop no longer
  falls back to the unmultiplied true range after a gap.
- VWAP leaves a bar with a missing price or a nonfinite volume absent and its
  totals untouched; an undefined volume still counts as nothing traded.
- TWAP skips a missing price and divides by the bars it counted.
- OBV and Accumulation/Distribution read a nonfinite volume as nothing traded,
  as the money-flow studies already did.
- Parabolic SAR steps over a bar missing its high, low or close, seeds from the
  first two complete bars and clamps against the two complete bars before each
  step.
- TEMA adds its three terms left to right, as the specification fixes them.

The minimal ATR, Keltner, VWAP, TWAP and TEMA cases the classification recorded
for these causes now read exactly as their expected values. The Supertrend line,
OBV, A/D and Parabolic SAR cases differ only in cells of a documented contract
difference: the Supertrend seed bar, the carried OBV and A/D total on the bar
whose volume is missing, and the Parabolic SAR clamp. Finite results on complete
data are unchanged: digests of 27 affected configurations over five generated
sessions, recorded from 2.5.4 before the change, match bit for bit, and the
public `atr` equals the 2.5.4 recurrence at periods 1, 2, 3, 14, 50 and 500.
TEMA is the exception by design and moves only in its last digits. Reverting each correction fails its own regression tests,
and three browser regressions paint the resumed ATR, Supertrend, VWAP, band,
Parabolic SAR and OBV readings, and no bridge across a gap, in all three browser
engines. Screenshots were inspected.

## Remaining contract distinctions

Known distinctions include:

- Bandwidth and historical volatility use percentage display units in the chart;
  the corresponding language readings are ratios and require multiplication by
  100 in the compared expression.
- The native parabolic stop clamps against previous price ranges. The existing
  language call explicitly specifies an unclamped recurrence. Matching its name
  and parameters alone does not make those algorithms equivalent.
- Several native recursive studies remain unavailable after an interior source
  hole, while the language recurrences preserve their prior state and resume.
  ATR and the studies built on it, VWAP, TWAP, OBV, Accumulation/Distribution
  and Parabolic SAR now resume; the rest remain open.
- Native extrema, zero-denominator handling and missing-volume defaults can
  change availability even when complete, ordinary inputs agree.

These remain open audit items. The wider comparison does not replace the
independently derived Hull and directional fixtures above or establish complete
numerical coverage.
