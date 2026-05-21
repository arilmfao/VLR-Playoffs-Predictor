(function () {
if (window.__vppInjected) return;

const firstGroup = document.querySelector('.event-group');
if (!firstGroup) return;
window.__vppInjected = true;

const insertBeforeNode =
  document.querySelector('.event-groups-container') ||
  firstGroup.closest('.event-content > div') ||
  firstGroup;

const topNOverrides = new Map();
let lastSim = null;
let lastData = null;

const $ = id => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function fmt(p) {
  const pct = p * 100;
  if (pct >= 100) return '100%';
  if (pct <= 0) return '0%';
  if (pct >= 99.95) return '>99.9%';
  if (pct < 0.05) return '<0.1%';
  return pct.toFixed(1) + '%';
}

function clamp(n, lo, hi) {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

const PAIR_RE = /^(\d+)\s*[\/\-‐-―:]\s*(\d+)$/;
const INT_RE = /^\d+$/;
const RD_PER_MAP = 7;
const MAX_ENUM_MATCHES = 10;

function seriesRD(wMaps, lMaps) {
  return lMaps === 0 ? wMaps * RD_PER_MAP : 5;
}

async function scrapeData() {
  const groups = [];
  for (const g of document.querySelectorAll('.event-group')) {
    const titleEl = g.querySelector('th.mod-title');
    const groupName = (titleEl ? titleEl.textContent : 'Group ' + (groups.length + 1)).trim();
    const teams = [];
    let advCount = 0;

    g.querySelectorAll('table.mod-group tbody tr').forEach(tr => {
      const link = tr.querySelector('a.event-group-team');
      if (!link) return;
      if (tr.classList.contains('mod-adv')) advCount++;

      let name = '';
      const nameEl = tr.querySelector('.event-group-team-name');
      if (nameEl) {
        for (const n of nameEl.childNodes) {
          if (n.nodeType === 3) name += n.textContent;
        }
        name = name.trim();
      }
      if (!name) name = link.textContent.trim().split('\n')[0].trim();

      const logoImg = tr.querySelector('img.event-group-team-logo');
      const logo = logoImg ? logoImg.getAttribute('src') : link.getAttribute('href');

      const tds = Array.from(tr.querySelectorAll('td'));
      let teamCellIdx = -1;
      for (let i = 0; i < tds.length; i++) {
        if (tds[i].querySelector('a.event-group-team')) { teamCellIdx = i; break; }
      }
      const dataCells = teamCellIdx < 0 ? tds : tds.slice(teamCellIdx + 1);
      const diffEl = tr.querySelector('.diff');

      const singles = [];
      const pairs = [];
      for (const td of dataCells) {
        if (td === diffEl || td.contains(diffEl)) continue;
        const t = td.textContent.trim();
        if (INT_RE.test(t)) { singles.push(+t); continue; }
        const m = t.match(PAIR_RE);
        if (m) pairs.push([+m[1], +m[2]]);
      }

      let w = 0, l = 0, mw = 0, ml = 0, rw = 0, rl = 0;
      if (singles.length >= 2) {
        w = singles[0]; l = singles[1];
        if (pairs[0]) { mw = pairs[0][0]; ml = pairs[0][1]; }
        if (pairs[1]) { rw = pairs[1][0]; rl = pairs[1][1]; }
      } else if (pairs.length) {
        [w, l] = pairs[0];
        if (pairs[1]) { mw = pairs[1][0]; ml = pairs[1][1]; }
        if (pairs[2]) { rw = pairs[2][0]; rl = pairs[2][1]; }
      }

      let roundDiff = rw - rl;
      if (diffEl) {
        const parsed = parseInt(diffEl.textContent.replace(/[^\d-]/g, ''), 10);
        if (Number.isFinite(parsed)) roundDiff = parsed;
      }

      teams.push({ name, logo, wins: w, losses: l, mapWins: mw, mapLosses: ml, roundDiff });
    });

    if (teams.length) groups.push({ name: groupName, teams, matches: [], advCount });
  }

  assignMatchesFrom(document, groups);

  if (groups.some(g => g.matches.length === 0)) {
    const fetched = await fetchMatchesDoc();
    if (fetched) assignMatchesFrom(fetched, groups);
  }

  return { groups };
}

function parseMatchLink(a) {
  let logoA = '', logoB = '';
  const teamEls = a.querySelectorAll('.team');
  if (teamEls.length >= 2) {
    const ia = teamEls[0].querySelector('img');
    const ib = teamEls[1].querySelector('img');
    if (ia) logoA = ia.getAttribute('src') || '';
    if (ib) logoB = ib.getAttribute('src') || '';
  }
  if (!logoA || !logoB) {
    const li = a.querySelectorAll('img.match-item-logo');
    if (li.length >= 2) {
      logoA = li[0].getAttribute('src') || '';
      logoB = li[1].getAttribute('src') || '';
    }
  }
  if (!logoA || !logoB) {
    const imgs = a.querySelectorAll('img');
    if (imgs.length >= 2) {
      logoA = imgs[0].getAttribute('src') || '';
      logoB = imgs[1].getAttribute('src') || '';
    }
  }
  if (!logoA || !logoB) return null;

  let numL = NaN, numR = NaN;
  const sL = (a.querySelector('.score-left') || {}).textContent;
  const sR = (a.querySelector('.score-right') || {}).textContent;
  if (sL != null) numL = parseInt(sL, 10);
  if (sR != null) numR = parseInt(sR, 10);
  if (!Number.isFinite(numL) || !Number.isFinite(numR)) {
    const sc = a.querySelectorAll('.match-item-vs-team-score');
    if (sc.length >= 2) {
      numL = parseInt(sc[0].textContent.trim(), 10);
      numR = parseInt(sc[1].textContent.trim(), 10);
    }
  }
  const completed = Number.isFinite(numL) && Number.isFinite(numR) && (numL + numR) > 0;

  return {
    href: a.getAttribute('href') || '',
    logoA, logoB, completed,
    scoreA: completed ? numL : null,
    scoreB: completed ? numR : null,
  };
}

function assignMatchesFrom(root, groups) {
  const linkSet = new Set();
  for (const sel of ['a.event-group-series-match', 'a.match-item', 'a.wf-module-item.match-item']) {
    root.querySelectorAll(sel).forEach(a => linkSet.add(a));
  }
  const seen = new Set();
  for (const grp of groups) for (const m of grp.matches) if (m.href) seen.add(m.href);

  for (const a of linkSet) {
    const entry = parseMatchLink(a);
    if (!entry) continue;
    if (entry.href && seen.has(entry.href)) continue;

    for (const grp of groups) {
      const has = new Set(grp.teams.map(t => t.logo));
      if (has.has(entry.logoA) && has.has(entry.logoB)) {
        grp.matches.push(entry);
        if (entry.href) seen.add(entry.href);
        break;
      }
    }
  }
}

async function fetchMatchesDoc() {
  const m = location.pathname.match(/^\/event\/(\d+)\/([^/]+)/);
  if (!m) return null;
  const eventId = m[1];
  const slug = m[2];

  let seriesId = null;
  for (const a of document.querySelectorAll('a[href*="series_id="]')) {
    const mm = (a.getAttribute('href') || '').match(/series_id=(\d+)/);
    if (mm) { seriesId = mm[1]; break; }
  }

  const url = '/event/matches/' + eventId + '/' + slug + '/' + (seriesId ? '?series_id=' + seriesId : '');
  try {
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok) return null;
    const html = await resp.text();
    return new DOMParser().parseFromString(html, 'text/html');
  } catch (e) {
    return null;
  }
}

function resolveTopN(g) {
  if (topNOverrides.has(g.name)) return topNOverrides.get(g.name);
  if (g.advCount > 0 && g.advCount < g.teams.length) return g.advCount;
  return Math.max(1, (g.teams.length / 2) | 0);
}

function winProb(ai, bi, base) {
  const a = base[ai], b = base[bi];
  const aN = a.wins + a.losses;
  const bN = b.wins + b.losses;
  const minN = aN < bN ? aN : bN;
  const w = minN / (minN + 10);
  if (w < 0.01) return 0.5;

  const aRate = aN ? a.wins / aN : 0.5;
  const bRate = bN ? b.wins / bN : 0.5;

  let raw;
  if (aRate === bRate) {
    const am = a.mapWins + a.mapLosses;
    const bm = b.mapWins + b.mapLosses;
    const ar = am ? a.mapWins / am : 0.5;
    const br = bm ? b.mapWins / bm : 0.5;
    raw = (ar + br) ? ar / (ar + br) : 0.5;
  } else {
    raw = aRate / (aRate + bRate);
  }
  return 0.5 + w * (raw - 0.5);
}

function sweepProb(p) {
  return 0.4 + 0.4 * Math.abs(p - 0.5);
}

function decodeBits(b) {
  const aWins = (b & 1) === 0;
  const sweep = (b & 2) !== 0;
  const lMaps = sweep ? 0 : 1;
  return { aWins, isSweep: sweep, wMaps: 2, lMaps, rd: seriesRD(2, lMaps) };
}

function bitWeight(b, pA, sP) {
  const aWins = (b & 1) === 0;
  const sweep = (b & 2) !== 0;
  return (aWins ? pA : 1 - pA) * (sweep ? sP : 1 - sP);
}

function buildPlayedMatches(group, idx) {
  const out = [];
  for (const m of group.matches) {
    if (!m.completed || !idx.has(m.logoA) || !idx.has(m.logoB)) continue;
    const ai = idx.get(m.logoA);
    const bi = idx.get(m.logoB);
    const aWon = m.scoreA > m.scoreB;
    const hi = Math.max(m.scoreA, m.scoreB);
    const lo = Math.min(m.scoreA, m.scoreB);
    out.push({
      winner: aWon ? ai : bi,
      loser: aWon ? bi : ai,
      wMaps: hi,
      lMaps: lo,
      rd: seriesRD(hi, lo),
    });
  }
  return out;
}

function rankTeams(n, W, MD, RD, allMatches) {
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.sort((a, b) => W[b] - W[a]);

  const tiers = [];
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && W[order[j]] === W[order[i]]) j++;
    if (j - i === 1) {
      tiers.push([order[i]]);
    } else {
      const tied = order.slice(i, j);
      for (const t of resolveTie(tied, MD, RD, allMatches, 0)) tiers.push(t);
    }
    i = j;
  }
  return tiers;
}

function resolveTie(tied, MD, RD, allMatches, ruleStart) {
  if (tied.length === 1) return [tied];
  const tierSet = new Set(tied);

  function scoreFor(t, rule) {
    if (rule >= 3) return rule === 3 ? MD[t] : RD[t];
    let c = 0;
    for (const m of allMatches) {
      const tIsWin = m.winner === t && tierSet.has(m.loser);
      const tIsLose = m.loser === t && tierSet.has(m.winner);
      if (!tIsWin && !tIsLose) continue;
      if (rule === 0) {
        if (tIsWin) c++;
      } else if (rule === 1) {
        c += tIsWin ? (m.wMaps - m.lMaps) : (m.lMaps - m.wMaps);
      } else {
        c += tIsWin ? m.rd : -m.rd;
      }
    }
    return c;
  }

  for (let rule = ruleStart; rule < 5; rule++) {
    const scored = tied.map(t => ({ t, s: scoreFor(t, rule) }));
    scored.sort((a, b) => b.s - a.s);

    const buckets = [];
    let p = 0;
    while (p < scored.length) {
      let q = p + 1;
      while (q < scored.length && scored[q].s === scored[p].s) q++;
      const bucket = [];
      for (let k = p; k < q; k++) bucket.push(scored[k].t);
      buckets.push(bucket);
      p = q;
    }

    if (buckets.length > 1) {
      const out = [];
      for (const b of buckets) {
        if (b.length === 1) { out.push(b); continue; }
        for (const sub of resolveTie(b, MD, RD, allMatches, 0)) out.push(sub);
      }
      return out;
    }
  }

  return [tied];
}

function simulate(data) {
  const out = [];

  for (const g of data.groups) {
    const topN = clamp(resolveTopN(g), 1, g.teams.length);
    const base = g.teams.map(t => Object.assign({}, t));
    const n = base.length;
    const idx = new Map();
    for (let i = 0; i < n; i++) idx.set(base[i].logo, i);

    const remaining = [];
    for (const m of g.matches) {
      if (m.completed) continue;
      if (!idx.has(m.logoA) || !idx.has(m.logoB)) continue;
      remaining.push({ a: idx.get(m.logoA), b: idx.get(m.logoB) });
    }
    const R = remaining.length;

    const qual = new Float64Array(n);
    const matchOutcomeCount = [];
    const condQual = [];
    for (let i = 0; i < n; i++) {
      const row = new Array(R);
      for (let r = 0; r < R; r++) row[r] = [0, 0];
      condQual.push(row);
    }
    for (let r = 0; r < R; r++) matchOutcomeCount.push([0, 0]);

    const ownCount = new Array(n).fill(0);
    for (const m of remaining) { ownCount[m.a]++; ownCount[m.b]++; }
    const byOwn = [];
    const byOwnQ = [];
    for (let i = 0; i < n; i++) {
      byOwn.push(new Float64Array(ownCount[i] + 1));
      byOwnQ.push(new Float64Array(ownCount[i] + 1));
    }

    const W = new Int32Array(n);
    const MD = new Int32Array(n);
    const RD = new Int32Array(n);
    const ownWins = new Int32Array(n);
    const matchRes = new Int8Array(R);
    const inTop = new Float64Array(n);

    const playedMatches = buildPlayedMatches(g, idx);
    const simOffset = playedMatches.length;
    const allMatches = playedMatches.slice();
    for (let r = 0; r < R; r++) {
      allMatches.push({ winner: 0, loser: 0, wMaps: 2, lMaps: 0, rd: 14 });
    }

    const enumTotal = R > MAX_ENUM_MATCHES ? 0 : (1 << (2 * R));
    const enumMode = enumTotal > 0;
    const iterations = enumMode ? enumTotal : 100000;
    let totalWeight = 0;

    for (let s = 0; s < iterations; s++) {
      const mask = enumMode ? s : 0;
      for (let i = 0; i < n; i++) {
        W[i] = base[i].wins;
        MD[i] = base[i].mapWins - base[i].mapLosses;
        RD[i] = base[i].roundDiff;
        ownWins[i] = 0;
        inTop[i] = 0;
      }
      let weight = 1;

      for (let r = 0; r < R; r++) {
        const m = remaining[r];
        const pA = winProb(m.a, m.b, base);
        const sP = sweepProb(pA);
        let bits;
        if (enumMode) {
          bits = (mask >>> (2 * r)) & 3;
          weight *= bitWeight(bits, pA, sP);
        } else {
          const aWins = Math.random() < pA;
          const sweep = Math.random() < sP;
          bits = (aWins ? 0 : 1) | (sweep ? 2 : 0);
        }
        const o = decodeBits(bits);
        matchRes[r] = o.aWins ? 0 : 1;
        const winner = o.aWins ? m.a : m.b;
        const loser = o.aWins ? m.b : m.a;
        W[winner]++;
        ownWins[winner]++;
        const md = o.wMaps - o.lMaps;
        MD[winner] += md; MD[loser] -= md;
        RD[winner] += o.rd; RD[loser] -= o.rd;
        const am = allMatches[simOffset + r];
        am.winner = winner; am.loser = loser;
        am.wMaps = o.wMaps; am.lMaps = o.lMaps; am.rd = o.rd;
      }
      totalWeight += weight;

      const ranked = rankTeams(n, W, MD, RD, allMatches);
      let pos = 0;
      for (const grp of ranked) {
        let slots;
        if (pos + grp.length <= topN) slots = grp.length;
        else if (pos < topN) slots = topN - pos;
        else slots = 0;
        const frac = slots / grp.length;
        for (const t of grp) inTop[t] = frac;
        pos += grp.length;
      }

      for (let r = 0; r < R; r++) matchOutcomeCount[r][matchRes[r]] += weight;
      for (let i = 0; i < n; i++) {
        const it = inTop[i];
        qual[i] += it * weight;
        byOwn[i][ownWins[i]] += weight;
        byOwnQ[i][ownWins[i]] += it * weight;
        if (it > 0) {
          for (let r = 0; r < R; r++) condQual[i][r][matchRes[r]] += it * weight;
        }
      }
    }

    const rows = [];
    for (let i = 0; i < n; i++) {
      const t = base[i];
      const pct = qual[i] / totalWeight;
      let status = 'alive';
      if (pct >= 0.99995) status = 'qualified';
      else if (pct <= 0.00005) status = 'eliminated';

      const byOwnWins = [];
      for (let k = 0; k <= ownCount[i]; k++) {
        if (byOwn[i][k] > 0) {
          byOwnWins.push({ k, total: byOwn[i][k], pct: byOwnQ[i][k] / byOwn[i][k] });
        }
      }

      const impacts = [];
      for (let r = 0; r < R; r++) {
        const m = remaining[r];
        const cA = matchOutcomeCount[r][0];
        const cB = matchOutcomeCount[r][1];
        const isOwn = m.a === i || m.b === i;
        const pA = cA > 0 ? condQual[i][r][0] / cA : null;
        const pB = cB > 0 ? condQual[i][r][1] / cB : null;
        impacts.push({
          isOwn,
          aIdx: m.a, bIdx: m.b,
          aName: base[m.a].name, bName: base[m.b].name,
          p_a: pA, p_b: pB,
          p_win: isOwn ? (m.a === i ? pA : pB) : null,
          p_lose: isOwn ? (m.a === i ? pB : pA) : null,
          opponent: isOwn ? (m.a === i ? base[m.b].name : base[m.a].name) : null,
        });
      }

      rows.push({
        idx: i, name: t.name, logo: t.logo,
        wins: t.wins, losses: t.losses,
        mapWins: t.mapWins, mapLosses: t.mapLosses,
        mapDiff: t.mapWins - t.mapLosses, roundDiff: t.roundDiff,
        ownRemaining: ownCount[i],
        pct, status, byOwnWins, impacts,
      });
    }

    out.push({
      name: g.name,
      remainingCount: R,
      teams: rows,
      topN,
      advCount: g.advCount,
      teamCount: g.teams.length,
      overridden: topNOverrides.has(g.name),
      exact: enumMode,
    });
  }
  return out;
}

function summaryFor(t, topN) {
  if (t.ownRemaining === 0) {
    if (t.status === 'qualified') return `Done playing &mdash; they're through.`;
    if (t.status === 'eliminated') return `Done playing &mdash; didn't make it.`;
    return `They're done playing. Final spot is up to the rest of the group.`;
  }
  if (t.status === 'qualified') return `Already through. Nothing left can drop ${esc(t.name)} out of the top ${topN}.`;
  if (t.status === 'eliminated') return `No remaining result puts ${esc(t.name)} into the top ${topN}.`;

  const byK = new Map();
  for (const b of t.byOwnWins) byK.set(b.k, b.pct);
  const allWin = byK.get(t.ownRemaining);
  const allLose = byK.get(0);

  if (allWin === 1) {
    let minK = t.ownRemaining;
    for (let k = 0; k <= t.ownRemaining; k++) {
      if ((byK.get(k) || 0) === 1) { minK = k; break; }
    }
    const phrase = minK === 1 ? 'Win their next one' : `Win ${minK} of ${t.ownRemaining}`;
    return `${phrase} and they're locked into the top ${topN}. Less than that and it's on other results.`;
  }
  if (allWin != null && allWin >= 0.95) {
    return `Win out and they're basically in (${fmt(allWin)}). Anything less and it's tight.`;
  }
  if (allLose === 0 && allWin != null && allWin < 0.5) {
    return `Winning out only gets them to ${fmt(allWin)}. They need help from other games.`;
  }
  return `Win out: ${fmt(allWin || 0)} &middot; lose out: ${fmt(allLose || 0)}.`;
}

function runGreedyOnce(base, n, teamIdx, remaining, playedMatches, strategy) {
  const R = remaining.length;
  const W = new Int32Array(n);
  const Lo = new Int32Array(n);
  const MD = new Int32Array(n);
  const RD = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    W[i] = base[i].wins;
    Lo[i] = base[i].losses;
    MD[i] = base[i].mapWins - base[i].mapLosses;
    RD[i] = base[i].roundDiff;
  }
  const allMatches = playedMatches.slice();
  const outcomes = [];

  for (let r = 0; r < R; r++) {
    const m = remaining[r];
    const targetIsA = m.a === teamIdx;
    const targetIsB = m.b === teamIdx;
    const pA = winProb(m.a, m.b, base);
    const sP = sweepProb(pA);

    let aWins, isSweep;
    if (targetIsA || targetIsB) {
      aWins = targetIsA;
      isSweep = true;
    } else if (strategy === 'drag') {
      const aScore = base[m.a].wins * 1000 + (base[m.a].mapWins - base[m.a].mapLosses);
      const bScore = base[m.b].wins * 1000 + (base[m.b].mapWins - base[m.b].mapLosses);
      aWins = aScore < bScore;
      isSweep = true;
    } else {
      aWins = pA >= 0.5;
      isSweep = sP >= 0.5;
    }

    const wMaps = 2;
    const lMaps = isSweep ? 0 : 1;
    const rd = seriesRD(wMaps, lMaps);
    const winner = aWins ? m.a : m.b;
    const loser = aWins ? m.b : m.a;
    W[winner]++; Lo[loser]++;
    MD[winner] += wMaps - lMaps; MD[loser] -= wMaps - lMaps;
    RD[winner] += rd; RD[loser] -= rd;
    allMatches.push({ winner, loser, wMaps, lMaps, rd });
    outcomes.push({ aWins, isSweep, wMaps, lMaps, rd, pA });
  }

  return { W, Lo, MD, RD, allMatches, outcomes };
}

function buildGreedyPath(base, n, teamIdx, topN, remaining, playedMatches, standingsFrom) {
  const R = remaining.length;

  let sim = runGreedyOnce(base, n, teamIdx, remaining, playedMatches, 'likely');
  let standings = standingsFrom(sim.W, sim.Lo, sim.MD, sim.RD, sim.allMatches);
  let target = standings.find(s => s.isTarget);

  if (!target || !target.qualifies) {
    const drag = runGreedyOnce(base, n, teamIdx, remaining, playedMatches, 'drag');
    const dragStandings = standingsFrom(drag.W, drag.Lo, drag.MD, drag.RD, drag.allMatches);
    const dragTarget = dragStandings.find(s => s.isTarget);
    if (dragTarget && (!target || dragTarget.rank < target.rank)) {
      sim = drag;
      standings = dragStandings;
      target = dragTarget;
    }
  }

  let prob = 1;
  const matches = [];
  for (let r = 0; r < R; r++) {
    const o = sim.outcomes[r];
    const m = remaining[r];
    const winner = o.aWins ? m.a : m.b;
    const loser = o.aWins ? m.b : m.a;
    const sP = sweepProb(o.pA);
    prob *= (o.aWins ? o.pA : 1 - o.pA) * (o.isSweep ? sP : 1 - sP);
    matches.push({
      winnerName: base[winner].name,
      winnerLogo: base[winner].logo,
      loserName: base[loser].name,
      loserLogo: base[loser].logo,
      wMaps: o.wMaps, lMaps: o.lMaps, rd: o.rd,
      prob: o.aWins ? o.pA : 1 - o.pA,
      isOwn: m.a === teamIdx || m.b === teamIdx,
    });
  }

  const cutoff = standings[topN];
  const mapsMatter = !!cutoff && target.wins === cutoff.wins;
  const rdMatters = mapsMatter && target.mapDiff === cutoff.mapDiff;

  return {
    qualifies: target.qualifies,
    qualifyMass: null,
    path: {
      matches,
      finalStandings: standings,
      rank: target.rank,
      probability: prob,
      mapsMatter,
      rdMatters,
    },
  };
}

function findQualifyingPaths(group, teamIdx, topN) {
  const base = group.teams;
  const n = base.length;
  const idx = new Map();
  for (let i = 0; i < n; i++) idx.set(base[i].logo, i);

  const remaining = [];
  for (const m of group.matches) {
    if (m.completed) continue;
    if (!idx.has(m.logoA) || !idx.has(m.logoB)) continue;
    remaining.push({ a: idx.get(m.logoA), b: idx.get(m.logoB) });
  }
  const R = remaining.length;
  const playedMatches = buildPlayedMatches(group, idx);

  function standingsFrom(W, Lo, MD, RD, allMatches) {
    const tiers = rankTeams(n, W, MD, RD, allMatches);
    const flat = [];
    let pos = 0;
    for (const tier of tiers) {
      for (const i of tier) {
        flat.push({
          rank: pos + 1,
          idx: i,
          name: base[i].name,
          logo: base[i].logo,
          wins: W[i],
          losses: Lo[i],
          mapDiff: MD[i],
          roundDiff: RD[i],
          isTarget: i === teamIdx,
          qualifies: pos < topN,
        });
      }
      pos += tier.length;
    }
    return flat;
  }

  if (R === 0) {
    const W = new Int32Array(n);
    const Lo = new Int32Array(n);
    const MD = new Int32Array(n);
    const RD = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      W[i] = base[i].wins;
      Lo[i] = base[i].losses;
      MD[i] = base[i].mapWins - base[i].mapLosses;
      RD[i] = base[i].roundDiff;
    }
    const fs = standingsFrom(W, Lo, MD, RD, playedMatches);
    const rank = fs.findIndex(s => s.idx === teamIdx);
    return { qualifies: rank < topN, paths: [], totalScenarios: 1, noMatches: true, finalStandings: fs };
  }

  if (R > MAX_ENUM_MATCHES) {
    return buildGreedyPath(base, n, teamIdx, topN, remaining, playedMatches, standingsFrom);
  }

  function evaluate(mask) {
    const W = new Int32Array(n);
    const Lo = new Int32Array(n);
    const MD = new Int32Array(n);
    const RD = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      W[i] = base[i].wins;
      Lo[i] = base[i].losses;
      MD[i] = base[i].mapWins - base[i].mapLosses;
      RD[i] = base[i].roundDiff;
    }
    const allMatches = playedMatches.slice();
    const outcomes = new Array(R);

    for (let r = 0; r < R; r++) {
      const o = decodeBits((mask >>> (2 * r)) & 3);
      const winner = o.aWins ? remaining[r].a : remaining[r].b;
      const loser = o.aWins ? remaining[r].b : remaining[r].a;
      outcomes[r] = o;
      W[winner]++;
      Lo[loser]++;
      MD[winner] += o.wMaps - o.lMaps;
      MD[loser] -= o.wMaps - o.lMaps;
      RD[winner] += o.rd;
      RD[loser] -= o.rd;
      allMatches.push({ winner, loser, wMaps: o.wMaps, lMaps: o.lMaps, rd: o.rd });
    }

    const tiers = rankTeams(n, W, MD, RD, allMatches);
    let pos = 0, rank = -1, cutoffIdx = -1;
    for (const tier of tiers) {
      for (let k = 0; k < tier.length; k++) {
        if (pos + k === topN) cutoffIdx = tier[k];
        if (tier[k] === teamIdx) rank = pos + k;
      }
      pos += tier.length;
    }

    const qualifies = rank >= 0 && rank < topN;
    let margin = 0;
    if (qualifies) {
      if (cutoffIdx < 0) {
        margin = Infinity;
      } else {
        margin = (W[teamIdx] - W[cutoffIdx]) * 1e9
               + (MD[teamIdx] - MD[cutoffIdx]) * 1e6
               + (RD[teamIdx] - RD[cutoffIdx]);
      }
    }
    return { qualifies, margin, rank, W, Lo, MD, RD, allMatches, outcomes };
  }

  const total = 1 << (2 * R);
  const raw = [];
  let qualifyMass = 0;

  for (let mask = 0; mask < total; mask++) {
    const ev = evaluate(mask);
    if (!ev.qualifies) continue;
    let prob = 1;
    for (let r = 0; r < R; r++) {
      const pA = winProb(remaining[r].a, remaining[r].b, base);
      prob *= bitWeight((mask >>> (2 * r)) & 3, pA, sweepProb(pA));
    }
    qualifyMass += prob;
    raw.push(Object.assign({ mask, probability: prob }, ev));
  }

  if (!raw.length) return { qualifies: false, totalScenarios: total, qualifyMass: 0 };

  raw.sort((a, b) => (b.probability - a.probability) || (b.margin - a.margin));
  const best = raw[0];

  const matches = [];
  for (let r = 0; r < R; r++) {
    const o = best.outcomes[r];
    const winner = o.aWins ? remaining[r].a : remaining[r].b;
    const loser = o.aWins ? remaining[r].b : remaining[r].a;
    const pA = winProb(remaining[r].a, remaining[r].b, base);
    matches.push({
      winnerName: base[winner].name,
      winnerLogo: base[winner].logo,
      loserName: base[loser].name,
      loserLogo: base[loser].logo,
      wMaps: o.wMaps, lMaps: o.lMaps, rd: o.rd,
      prob: o.aWins ? pA : 1 - pA,
      isOwn: remaining[r].a === teamIdx || remaining[r].b === teamIdx,
    });
  }

  const finalStandings = standingsFrom(best.W, best.Lo, best.MD, best.RD, best.allMatches);
  const target = finalStandings.find(s => s.isTarget);
  const cutoff = finalStandings[topN];
  const mapsMatter = !!cutoff && target.wins === cutoff.wins;
  const rdMatters = mapsMatter && target.mapDiff === cutoff.mapDiff;

  return {
    qualifies: true,
    qualifyMass,
    path: {
      matches,
      finalStandings,
      rank: best.rank + 1,
      probability: best.probability,
      mapsMatter,
      rdMatters,
    },
  };
}

function renderStandings(probs) {
  const el = $('vpp-standings');
  el.innerHTML = '';

  for (const g of probs) {
    const sub = g.remainingCount === 0
      ? 'all matches complete'
      : g.remainingCount + ' match' + (g.remainingCount === 1 ? '' : 'es') + ' remaining';
    const src = g.overridden
      ? 'manual'
      : (g.advCount > 0 && g.advCount < g.teamCount ? 'from page' : 'default');

    const sorted = g.teams.slice().sort((a, b) =>
      b.pct - a.pct || b.wins - a.wins || b.mapDiff - a.mapDiff
    );

    let html = '';
    html += '<div class="vpp-group-h">';
    html +=   esc(g.name);
    html +=   '<span class="vpp-sub">— ' + sub + '</span>';
    html +=   '<span class="vpp-advance">top ';
    html +=     '<input type="number" class="vpp-topn-input" data-group="' + esc(g.name) + '" value="' + g.topN + '" min="1" max="' + g.teamCount + '">';
    html +=     ' advance <span class="vpp-advance-src">(' + src + ')</span>';
    html +=   '</span>';
    html += '</div>';
    html += '<table class="vpp-table"><thead><tr>';
    html += '<th class="mod-rank">#</th><th>Team</th>';
    html += '<th class="mod-rec">Rec</th><th class="mod-rec">Maps</th>';
    html += '<th class="mod-pct">P(Top ' + g.topN + ')</th>';
    html += '</tr></thead><tbody>';

    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const pct = r.pct * 100;
      const cls = [];
      if (r.status === 'qualified') cls.push('mod-qualified');
      else if (r.status === 'eliminated') cls.push('mod-eliminated');
      cls.push(i < g.topN ? 'mod-in-top' : 'mod-out-top');
      html += '<tr class="' + cls.join(' ') + '">';
      html +=   '<td class="mod-rank">' + (i + 1) + '</td>';
      html +=   '<td class="mod-team"><img src="' + esc(r.logo) + '" class="vpp-logo" alt=""><span>' + esc(r.name) + '</span></td>';
      html +=   '<td class="mod-rec">' + r.wins + '&ndash;' + r.losses + '</td>';
      html +=   '<td class="mod-rec">' + r.mapWins + '&ndash;' + r.mapLosses + '</td>';
      html +=   '<td class="mod-pct">';
      html +=     '<span class="vpp-meter"><span style="width:' + pct.toFixed(2) + '%"></span></span>';
      html +=     '<span class="vpp-pct-num">' + fmt(r.pct) + '</span>';
      html +=   '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';

    const card = document.createElement('div');
    card.className = 'vpp-group';
    card.innerHTML = html;
    el.appendChild(card);
  }

  el.querySelectorAll('.vpp-topn-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const name = inp.getAttribute('data-group');
      const max = parseInt(inp.getAttribute('max'), 10) || 16;
      const n = clamp(parseInt(inp.value, 10) || 1, 1, max);
      inp.value = n;
      topNOverrides.set(name, n);
      runSim();
    });
  });
}

function renderStandingsTable(standings) {
  const sign = v => (v >= 0 ? '+' : '') + v;
  let html = '<table class="vpp-table"><thead><tr><th class="mod-rank">#</th><th>Team</th><th class="mod-rec">Rec</th><th class="mod-rec">MD</th><th class="mod-rec">RD</th></tr></thead><tbody>';
  for (const s of standings) {
    const cls = (s.qualifies ? 'mod-in-top' : 'mod-out-top') + (s.isTarget ? ' mod-target-row' : '');
    html += '<tr class="' + cls + '">';
    html +=   '<td class="mod-rank">' + s.rank + '</td>';
    html +=   '<td class="mod-team"><img src="' + esc(s.logo) + '" class="vpp-logo" alt=""><span>' + esc(s.name) + (s.isTarget ? ' <span class="vpp-target-mark">★</span>' : '') + '</span></td>';
    html +=   '<td class="mod-rec">' + s.wins + '&ndash;' + s.losses + '</td>';
    html +=   '<td class="mod-rec">' + sign(s.mapDiff) + '</td>';
    html +=   '<td class="mod-rec">' + sign(s.roundDiff) + '</td>';
    html += '</tr>';
  }
  return html + '</tbody></table>';
}

function renderQualifyingPaths(result, topN, teamName) {
  if (!result) return '';
  if (result.noMatches) {
    const head = result.qualifies
      ? '<b>No matches left — qualified.</b>'
      : '<b>No matches left — did not qualify.</b>';
    return '<div class="vpp-card"><div class="vpp-card-h">Final standings</div>' + head + renderStandingsTable(result.finalStandings) + '</div>';
  }
  if (!result.qualifies) {
    return '<div class="vpp-card"><div class="vpp-card-h">Easiest path</div><div class="vpp-summary mod-eliminated">No combination of remaining results puts ' + esc(teamName) + ' in the top ' + topN + '.</div></div>';
  }

  const p = result.path;
  const target = p.finalStandings.find(s => s.isTarget);
  const sign = v => (v >= 0 ? '+' : '') + v;
  const showMaps = p.mapsMatter;
  const showRD = p.rdMatters;

  let note = '';
  if (showRD) note = '<div class="vpp-path-note">Comes down to round differential &mdash; map scores matter too.</div>';
  else if (showMaps) note = '<div class="vpp-path-note">Comes down to map differential &mdash; the scoreline matters.</div>';

  let rows = '';
  for (let i = 0; i < p.matches.length; i++) {
    const m = p.matches[i];
    rows += '<tr class="' + (m.isOwn ? 'mod-own' : '') + '">';
    rows +=   '<td class="vpp-ideal-num">' + (i + 1) + '</td>';
    rows +=   '<td class="vpp-ideal-match"><img src="' + esc(m.winnerLogo) + '" class="vpp-logo" alt=""><b>' + esc(m.winnerName) + '</b> beat ' + esc(m.loserName) + ' <img src="' + esc(m.loserLogo) + '" class="vpp-logo" alt=""></td>';
    rows +=   '<td class="vpp-ideal-prob">' + fmt(m.prob) + '</td>';
    if (showMaps) rows += '<td class="vpp-ideal-score">' + m.wMaps + '&ndash;' + m.lMaps + '</td>';
    if (showRD) rows += '<td class="vpp-ideal-rd">+' + m.rd + ' RD</td>';
    rows += '</tr>';
  }

  const bits = [target.wins + '&ndash;' + target.losses];
  if (showMaps) bits.push('MD ' + sign(target.mapDiff));
  if (showRD) bits.push('RD ' + sign(target.roundDiff));

  return '<div class="vpp-card"><div class="vpp-card-h">Easiest path</div>' + note +
    '<div class="vpp-path"><table class="vpp-ideal"><tbody>' + rows + '</tbody></table>' +
    '<div class="vpp-path-result">Finishes ' + ordinal(target.rank) + ' · ' + bits.join(' · ') + '</div>' +
    '</div></div>';
}

function populateTeamPicker(probs) {
  const sel = $('vpp-team-pick');
  const prev = sel.value;
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'Select a team…';
  sel.appendChild(def);

  for (let gi = 0; gi < probs.length; gi++) {
    const g = probs[gi];
    const og = document.createElement('optgroup');
    og.label = g.name;
    const sorted = g.teams.slice().sort((a, b) => b.pct - a.pct || b.wins - a.wins);
    for (const t of sorted) {
      const opt = document.createElement('option');
      opt.value = gi + ':' + t.idx;
      opt.textContent = t.name + ' (' + t.wins + '-' + t.losses + ') — ' + fmt(t.pct);
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  sel.disabled = false;

  let restored = false;
  if (prev) {
    for (const o of sel.options) {
      if (o.value === prev) { sel.value = prev; restored = true; break; }
    }
  }
  if (restored) renderTeam(prev);
  else $('vpp-team-view').innerHTML = '<div class="vpp-empty">Pick a team above to see how they can qualify.</div>';
}

function renderTeam(key) {
  const view = $('vpp-team-view');
  if (!key || !lastSim) {
    view.innerHTML = '<div class="vpp-empty">Pick a team above to see how they can qualify.</div>';
    return;
  }
  const parts = key.split(':');
  const gi = +parts[0];
  const ti = +parts[1];
  const g = lastSim[gi];
  const t = g && g.teams.find(x => x.idx === ti);
  if (!t) { view.innerHTML = ''; return; }

  const rawGroup = lastData && lastData.groups[gi];
  const paths = rawGroup ? findQualifyingPaths(rawGroup, ti, g.topN) : null;

  let statusLabel;
  if (t.status === 'qualified') statusLabel = 'QUALIFIED';
  else if (t.status === 'eliminated') statusLabel = 'ELIMINATED';
  else statusLabel = fmt(t.pct) + ' TO QUALIFY';

  const mdLabel = (t.mapDiff >= 0 ? '+' : '') + t.mapDiff;

  let html = '';
  html += '<div class="vpp-team-compact mod-' + t.status + '">';
  html +=   '<img src="' + esc(t.logo) + '" class="vpp-logo" alt="">';
  html +=   '<div class="vpp-team-compact-name">' + esc(t.name) + '</div>';
  html +=   '<div class="vpp-team-compact-meta">' + t.wins + '&ndash;' + t.losses + ' · ' + mdLabel + ' MD · ' + t.ownRemaining + ' own left</div>';
  html +=   '<div class="vpp-team-compact-status">' + statusLabel + '</div>';
  html += '</div>';
  html += '<div class="vpp-summary mod-' + t.status + '">' + summaryFor(t, g.topN) + '</div>';
  html += renderQualifyingPaths(paths, g.topN, t.name);
  view.innerHTML = html;
}

function buildPanel() {
  const panel = document.createElement('div');
  panel.className = 'wf-card mod-dark vpp-root';
  panel.innerHTML = [
    '<div class="vpp-head">',
      '<div class="vpp-title">Playoff Probability</div>',
      '<div class="vpp-tabs">',
        '<button type="button" class="vpp-tab" data-pane="standings">Standings</button>',
        '<button type="button" class="vpp-tab vpp-tab-active" data-pane="scenarios">Scenarios</button>',
      '</div>',
      '<button type="button" class="vpp-collapse" aria-label="Collapse">&minus;</button>',
    '</div>',
    '<div class="vpp-body">',
      '<div class="vpp-controls">',
        '<button type="button" id="vpp-run" class="vpp-run">Refresh</button>',
        '<div class="vpp-status" id="vpp-status"></div>',
      '</div>',
      '<div id="vpp-standings" class="vpp-pane"></div>',
      '<div id="vpp-scenarios" class="vpp-pane vpp-pane-active">',
        '<select id="vpp-team-pick" class="vpp-team-pick" disabled>',
          '<option>Run simulation first…</option>',
        '</select>',
        '<div id="vpp-team-view">',
          '<div class="vpp-empty">Pick a team above to see how they can qualify.</div>',
        '</div>',
      '</div>',
    '</div>',
  ].join('');
  insertBeforeNode.parentNode.insertBefore(panel, insertBeforeNode);
  return panel;
}

async function runSim() {
  const statusEl = $('vpp-status');
  const runBtn = $('vpp-run');
  runBtn.disabled = true;
  statusEl.textContent = 'Reading page…';

  let data;
  try {
    data = await scrapeData();
    if (!data.groups.length) throw new Error('No group data found.');
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
    runBtn.disabled = false;
    return;
  }

  statusEl.textContent = 'Computing…';
  requestAnimationFrame(() => {
    try {
      const t0 = performance.now();
      const probs = simulate(data);
      const dt = performance.now() - t0;
      lastSim = probs;
      lastData = data;
      renderStandings(probs);
      populateTeamPicker(probs);
      const approx = probs.some(g => !g.exact);
      statusEl.textContent = dt.toFixed(0) + ' ms · ' + (approx ? 'sampled (>' + MAX_ENUM_MATCHES + ' matches left)' : 'exact');
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    } finally {
      runBtn.disabled = false;
    }
  });
}

const panel = buildPanel();
$('vpp-run').addEventListener('click', runSim);
$('vpp-team-pick').addEventListener('change', () => renderTeam($('vpp-team-pick').value));

panel.querySelectorAll('.vpp-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    panel.querySelectorAll('.vpp-tab').forEach(x => {
      x.classList.toggle('vpp-tab-active', x === btn);
    });
    panel.querySelectorAll('.vpp-pane').forEach(p => {
      p.classList.toggle('vpp-pane-active', p.id === 'vpp-' + btn.dataset.pane);
    });
  });
});

panel.querySelector('.vpp-collapse').addEventListener('click', () => {
  panel.classList.toggle('vpp-collapsed');
  const c = panel.querySelector('.vpp-collapse');
  c.innerHTML = panel.classList.contains('vpp-collapsed') ? '+' : '&minus;';
});

runSim();
})();
