# VLR Playoff Probability

A Chrome extension that injects live playoff-qualification odds into [vlr.gg](https://www.vlr.gg) group stage pages.

Open any VCT Challengers group stage and the extension drops a panel above the brackets showing each team's chance of making the cut, plus the single easiest path for them to get there.

---

## What it does

- **Auto-detects** how many teams advance per group by reading the page's own advancement indicators
- **Computes exact qualification odds** by enumerating every possible combination of remaining match outcomes (up to 10 remaining matches — beyond that it falls back to Monte Carlo sampling)
- **Surfaces the easiest path** for any team you select: the sequence of results most likely to play out and put them through
- **Implements VCT tiebreaker rules** correctly:
  1. Head-to-head match score
  2. Head-to-head map differential
  3. Head-to-head round differential
  4. Overall map differential
  5. Overall round differential
- **Per-group advancement override** if the page detection is wrong, just type the right number into the inline input

---

## Install

1. Download or clone this repository
2. Visit `chrome://extensions` in Chrome
3. Toggle **Developer mode** on (top-right)
4. Click **Load unpacked** and pick this folder
5. Open any [VCT group stage page](https://www.vlr.gg/event/2925/challengers-2026-emea-stage-2/group-stage) & the panel appears automatically

---

## How the model works

For each unplayed match, win probability is estimated from team records:

- **Series record is primary.** If two teams have different series win rates, that's what drives the forecast.
- **Map record is the tiebreaker.** When two teams have identical series rates, map record decides who's slightly favored.
- **Sample-size shrinkage.** Early in a tournament with little data, all matches converge toward a 50/50 coinflip. As teams play more series, the model gets more confident.

Each remaining match is enumerated four ways: team A wins 2-0, A wins 2-1, B wins 2-1, B wins 2-0 — weighted by win probability and a closeness factor (lopsided matchups lean toward sweeps, even matchups lean toward 2-1). This produces realistic map and round differentials, which feed into the tiebreaker logic.



## Notes

- The panel re-runs the simulation when you change the advancement count for any group
- If a group has more than 10 remaining matches, the engine switches from exact enumeration to ~100k Monte Carlo samples — accurate to within a fraction of a percent
- Probabilities update only when you click **Refresh** or change an input (it doesn't poll vlr.gg)
