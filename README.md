# VLR Playoff Probability

Browser extension (Chrome + Firefox) that puts playoff odds on vlr.gg group stage pages.

I built this so I could stop doing "ok if X beats Y, then..." math in my head during VCT Challengers groups. Open any group stage page on vlr.gg and a panel shows up with each team's qualifying chance and the easiest path to get there.

## Examples

<img width="635" height="730" alt="image" src="https://github.com/user-attachments/assets/a3d91606-e146-4c49-bd63-1fa6c032767d" />

<img width="640" height="401" alt="image" src="https://github.com/user-attachments/assets/f6c707f4-6fb3-4907-862c-4d15f0ba08ef" />

## Install

Not on any store, so you have to side-load it. Download the repo first (Code → Download ZIP, then unzip it somewhere).

### Chrome

1. Go to `chrome://extensions`
2. Flip on Developer mode (top-right)
3. Hit "Load unpacked" and pick the folder you just unzipped
4. Open a VCT Challengers group stage page on vlr.gg

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`
2. Hit "Load Temporary Add-on…" and pick the `manifest.json` inside the unzipped folder
3. Open a VCT Challengers group stage page on vlr.gg

Temporary add-ons are removed when you close Firefox. To install it permanently you'd need to sign it through [AMO](https://addons.mozilla.org/developers/) (requires Firefox 109+, which this manifest targets).

## How the odds are calculated

For each unplayed match it estimates a win probability, enumerates every possible combination of remaining results, and tallies how often each team lands in the top N. With ≤10 matches left that's an exact answer; beyond that it falls back to ~100k Monte Carlo samples (still accurate to roughly 0.1%).

Win probability mostly uses series record. When two teams have the same series win rate, map record breaks the tie. Early in a tournament with very little data, everything gets pulled toward 50/50 — a 1-0 team after one match isn't really "ahead," they just played first.

Each remaining match gets enumerated four ways (A 2-0, A 2-1, B 2-1, B 2-0). Closer matchups lean toward 2-1, lopsided ones toward 2-0. That produces realistic map and round differentials, which the tiebreaker logic needs.

VCT tiebreaker order: H2H match score → H2H map diff → H2H round diff → overall map diff → overall round diff. If a 3-way tie partially resolves and a subset stays tied, the chain restarts from the top for that subset. This was annoying to get right but it changes results in real groups, so it matters.

## A few things worth knowing

- The panel re-runs the sim whenever you change the "top N advance" count for a group
- Over 10 remaining matches the engine switches from exact enumeration to Monte Carlo automatically
- It doesn't poll vlr.gg — hit Refresh after a match finishes if you want fresh numbers
- If the auto-detected advance count is wrong (rare), just type over it in the inline input
- "Easiest path" hides the map/round columns when they don't actually matter for that team's qualification, and surfaces them when a tiebreaker is on the line
