(function () {
  'use strict';
  if (window.__vppInjected) return;

  const firstGroup = document.querySelector('.event-group');
  if (!firstGroup) return;
  const insertBeforeNode = document.querySelector('.event-groups-container')
    || firstGroup.closest('.event-content > div')
    || firstGroup;
  window.__vppInjected = true;

  let lastSim = null;
  let lastMeta = null;
  let lastData = null;
  const topNOverrides = new Map();

  // ===================== Scrape =====================
  function scrapeData() {
    const groups = [];
    document.querySelectorAll('.event-group').forEach(g => {
      const titleEl = g.querySelector('th.mod-title');
      const groupName = (titleEl ? titleEl.textContent : `Group ${groups.length + 1}`).trim();

      const teams = [];
      let advCount = 0;
      g.querySelectorAll('table.mod-group tbody tr').forEach(tr => {
        const link = tr.querySelector('a.event-group-team');
        if (!link) return;
        if (tr.classList.contains('mod-adv')) advCount++;
        const nameEl = tr.querySelector('.event-group-team-name');
        let name = '';
        if (nameEl) {
          for (const n of nameEl.childNodes) {
            if (n.nodeType === Node.TEXT_NODE) name += n.textContent;
          }
          name = name.trim();
        }
        if (!name) name = link.textContent.trim().split('\n')[0].trim();

        const logoImg = tr.querySelector('img.event-group-team-logo');
        const logo = logoImg ? logoImg.getAttribute('src') : link.getAttribute('href');

        const records = tr.querySelectorAll('td.mod-record');
        const stats = tr.querySelectorAll('td.mod-stat');
        const parseNum = (el) => {
          if (!el) return 0;
          const n = parseInt(el.textContent.trim(), 10);
          return Number.isFinite(n) ? n : 0;
        };
        const parseRec = (el) => {
          if (!el) return [0, 0];
          const m = el.textContent.replace(/\s+/g, ' ').match(/(-?\d+)\D+(-?\d+)/);
          return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [0, 0];
        };
        const w = parseNum(records[0]);
        const l = parseNum(records[1]);
        const [mw, ml] = parseRec(stats[0]);
        const [rw, rl] = parseRec(stats[1]);
        const diffEl = tr.querySelector('.diff');
        const roundDiff = diffEl
          ? (parseInt(diffEl.textContent.replace(/[^\d-]/g, ''), 10) || 0)
          : (rw - rl);

        teams.push({ name, logo, wins: w, losses: l, mapWins: mw, mapLosses: ml, roundDiff });
      });

      const matches = [];
      g.querySelectorAll('a.event-group-series-match').forEach(a => {
        const teamEls = a.querySelectorAll('.team');
        if (teamEls.length < 2) return;
        const logoA = teamEls[0].querySelector('img')?.getAttribute('src') || '';
        const logoB = teamEls[1].querySelector('img')?.getAttribute('src') || '';
        const sL = a.querySelector('.score-left')?.textContent.trim() ?? '';
        const sR = a.querySelector('.score-right')?.textContent.trim() ?? '';
        const numL = parseInt(sL, 10);
        const numR = parseInt(sR, 10);
        const completed = Number.isFinite(numL) && Number.isFinite(numR) && (numL + numR > 0);

        matches.push({
          href: a.getAttribute('href') || '',
          logoA, logoB, completed,
          scoreA: completed ? numL : null,
          scoreB: completed ? numR : null,
        });
      });

      if (teams.length) groups.push({ name: groupName, teams, matches, advCount });
    });
    return { groups };
  }

  function resolveTopN(g) {
    if (topNOverrides.has(g.name)) return topNOverrides.get(g.name);
    if (g.advCount > 0 && g.advCount < g.teams.length) return g.advCount;
    return Math.max(1, Math.floor(g.teams.length / 2));
  }

  // ===================== Simulate =====================
  const MAX_ENUM_MATCHES = 10;
  const RD_PER_MAP = 7;

  function winProb(aIdx, bIdx, base) {
    const a = base[aIdx], b = base[bIdx];
    const aGames = a.wins + a.losses;
    const bGames = b.wins + b.losses;
    const minGames = Math.min(aGames, bGames);
    const dataWeight = minGames / (minGames + 10);
    if (dataWeight < 0.01) return 0.5;
    const aRate = aGames > 0 ? a.wins / aGames : 0.5;
    const bRate = bGames > 0 ? b.wins / bGames : 0.5;
    const rawProb = (aRate + bRate) > 0 ? aRate / (aRate + bRate) : 0.5;
    return 0.5 + dataWeight * (rawProb - 0.5);
  }

  function sweepProb(pA) {
    return 0.4 + 0.4 * Math.abs(pA - 0.5);
  }

  function decodeBits(bits) {
    const aWins = (bits & 1) === 0;
    const isSweep = (bits & 2) !== 0;
    return { aWins, isSweep, wMaps: 2, lMaps: isSweep ? 0 : 1, rd: isSweep ? 14 : 5 };
  }

  function bitWeight(bits, pA, sP) {
    const aWins = (bits & 1) === 0;
    const isSweep = (bits & 2) !== 0;
    return (aWins ? pA : (1 - pA)) * (isSweep ? sP : (1 - sP));
  }

  function buildPlayedMatches(group, idx) {
    const out = [];
    for (const m of group.matches) {
      if (!m.completed) continue;
      if (!idx.has(m.logoA) || !idx.has(m.logoB)) continue;
      const ai = idx.get(m.logoA), bi = idx.get(m.logoB);
      const aWon = m.scoreA > m.scoreB;
      const wMaps = Math.max(m.scoreA, m.scoreB);
      const lMaps = Math.min(m.scoreA, m.scoreB);
      out.push({
        winner: aWon ? ai : bi,
        loser: aWon ? bi : ai,
        wMaps, lMaps,
        rd: (wMaps - lMaps) * RD_PER_MAP,
      });
    }
    return out;
  }

  function rankTeams(n, W, MD, RD, allMatches) {
    const all = new Array(n);
    for (let i = 0; i < n; i++) all[i] = i;
    all.sort((a, b) => W[b] - W[a]);

    const groups = [];
    let pos = 0;
    while (pos < n) {
      let end = pos + 1;
      while (end < n && W[all[end]] === W[all[pos]]) end++;
      if (end - pos === 1) {
        groups.push([all[pos]]);
      } else {
        const tier = all.slice(pos, end);
        const sub = resolveTie(tier, MD, RD, allMatches, 0);
        for (const g of sub) groups.push(g);
      }
      pos = end;
    }
    return groups;
  }

  function resolveTie(tied, MD, RD, allMatches, ruleStart) {
    if (tied.length === 1) return [tied];
    const tierSet = new Set(tied);

    const scoreFor = (t, ruleIdx) => {
      if (ruleIdx <= 2) {
        let c = 0;
        for (const m of allMatches) {
          if (m.winner === t && tierSet.has(m.loser)) {
            if (ruleIdx === 0) c++;
            else if (ruleIdx === 1) c += m.wMaps - m.lMaps;
            else c += m.rd;
          } else if (m.loser === t && tierSet.has(m.winner)) {
            if (ruleIdx === 1) c += m.lMaps - m.wMaps;
            else if (ruleIdx === 2) c -= m.rd;
          }
        }
        return c;
      }
      if (ruleIdx === 3) return MD[t];
      return RD[t];
    };

    for (let ruleIdx = ruleStart; ruleIdx < 5; ruleIdx++) {
      const indexed = tied.map(t => ({ t, s: scoreFor(t, ruleIdx) }));
      indexed.sort((a, b) => b.s - a.s);

      const subgroups = [];
      let p = 0;
      while (p < indexed.length) {
        let e = p + 1;
        while (e < indexed.length && indexed[e].s === indexed[p].s) e++;
        const g = [];
        for (let k = p; k < e; k++) g.push(indexed[k].t);
        subgroups.push(g);
        p = e;
      }

      if (subgroups.length > 1) {
        const result = [];
        for (const g of subgroups) {
          if (g.length === 1) result.push(g);
          else {
            const sub = resolveTie(g, MD, RD, allMatches, 0);
            for (const x of sub) result.push(x);
          }
        }
        return result;
      }
    }

    return [tied];
  }

  function simulate(data) {
    const out = [];

    for (const g of data.groups) {
      const topN = Math.max(1, Math.min(g.teams.length, resolveTopN(g)));
      const base = g.teams.map(t => ({ ...t }));
      const idx = new Map(base.map((t, i) => [t.logo, i]));
      const remaining = g.matches
        .filter(m => !m.completed && idx.has(m.logoA) && idx.has(m.logoB))
        .map(m => ({ a: idx.get(m.logoA), b: idx.get(m.logoB) }));
      const n = base.length;
      const R = remaining.length;

      const qual = new Float64Array(n);
      const condQual = [];
      for (let i = 0; i < n; i++) {
        const row = new Array(R);
        for (let r = 0; r < R; r++) row[r] = [0, 0];
        condQual.push(row);
      }
      const matchOutcomeCount = new Array(R);
      for (let r = 0; r < R; r++) matchOutcomeCount[r] = [0, 0];

      const ownCount = new Array(n).fill(0);
      for (const m of remaining) { ownCount[m.a]++; ownCount[m.b]++; }
      const byOwn = base.map((_, i) => new Float64Array(ownCount[i] + 1));
      const byOwnQ = base.map((_, i) => new Float64Array(ownCount[i] + 1));

      const W = new Int32Array(n);
      const L = new Int32Array(n);
      const MD = new Int32Array(n);
      const RD = new Int32Array(n);
      const ownWins = new Int32Array(n);
      const matchRes = new Int8Array(R);
      const inTop = new Float64Array(n);

      const playedMatches = buildPlayedMatches(g, idx);
      const allMatches = playedMatches.slice();
      for (let r = 0; r < R; r++) {
        allMatches.push({ winner: 0, loser: 0, wMaps: 2, lMaps: 0, rd: 14 });
      }
      const simOffset = playedMatches.length;

      const total = R > MAX_ENUM_MATCHES ? 0 : (1 << (2 * R));
      const enumMode = total > 0;
      const iterations = enumMode ? total : 100000;
      let totalWeight = 0;

      for (let s = 0; s < iterations; s++) {
        const mask = enumMode ? s : 0;
        for (let i = 0; i < n; i++) {
          W[i] = base[i].wins;
          L[i] = base[i].losses;
          MD[i] = base[i].mapWins - base[i].mapLosses;
          RD[i] = base[i].roundDiff;
          ownWins[i] = 0;
          inTop[i] = 0;
        }

        let w = 1;
        for (let r = 0; r < R; r++) {
          const m = remaining[r];
          const pA = winProb(m.a, m.b, base);
          const sP = sweepProb(pA);
          let bits;
          if (enumMode) {
            bits = (mask >>> (2 * r)) & 3;
            w *= bitWeight(bits, pA, sP);
          } else {
            const aWinsR = Math.random() < pA;
            const isSweepR = Math.random() < sP;
            bits = (aWinsR ? 0 : 1) | (isSweepR ? 2 : 0);
          }
          const o = decodeBits(bits);
          matchRes[r] = o.aWins ? 0 : 1;
          const winner = o.aWins ? m.a : m.b;
          const loser = o.aWins ? m.b : m.a;
          W[winner]++; L[loser]++; ownWins[winner]++;
          MD[winner] += o.wMaps - o.lMaps; MD[loser] -= o.wMaps - o.lMaps;
          RD[winner] += o.rd; RD[loser] -= o.rd;
          const am = allMatches[simOffset + r];
          am.winner = winner;
          am.loser = loser;
          am.wMaps = o.wMaps;
          am.lMaps = o.lMaps;
          am.rd = o.rd;
        }
        totalWeight += w;

        const groups = rankTeams(n, W, MD, RD, allMatches);
        let pos = 0;
        for (const grp of groups) {
          let slots = 0;
          if (pos + grp.length <= topN) slots = grp.length;
          else if (pos < topN) slots = topN - pos;
          const frac = slots / grp.length;
          for (const t of grp) inTop[t] = frac;
          pos += grp.length;
        }

        for (let r = 0; r < R; r++) matchOutcomeCount[r][matchRes[r]] += w;
        for (let i = 0; i < n; i++) {
          qual[i] += inTop[i] * w;
          byOwn[i][ownWins[i]] += w;
          byOwnQ[i][ownWins[i]] += inTop[i] * w;
          if (inTop[i] > 0) {
            for (let r = 0; r < R; r++) condQual[i][r][matchRes[r]] += inTop[i] * w;
          }
        }
      }

      const denom = totalWeight;
      const rows = base.map((t, i) => {
        const pct = qual[i] / denom;
        const status = pct >= 0.99995 ? 'qualified' : pct <= 0.00005 ? 'eliminated' : 'alive';

        const byOwnWins = [];
        for (let k = 0; k <= ownCount[i]; k++) {
          if (byOwn[i][k] > 0) {
            byOwnWins.push({ k, total: byOwn[i][k], pct: byOwnQ[i][k] / byOwn[i][k] });
          }
        }

        const impacts = remaining.map((m, r) => {
          const cA = matchOutcomeCount[r][0], cB = matchOutcomeCount[r][1];
          const aName = base[m.a].name, bName = base[m.b].name;
          const isOwn = m.a === i || m.b === i;
          const pA = cA > 0 ? condQual[i][r][0] / cA : null;
          const pB = cB > 0 ? condQual[i][r][1] / cB : null;
          return {
            isOwn,
            aIdx: m.a, bIdx: m.b, aName, bName,
            p_a: pA, p_b: pB,
            p_win: isOwn ? (m.a === i ? pA : pB) : null,
            p_lose: isOwn ? (m.a === i ? pB : pA) : null,
            opponent: isOwn ? (m.a === i ? bName : aName) : null,
          };
        });

        return {
          idx: i, name: t.name, logo: t.logo,
          wins: t.wins, losses: t.losses,
          mapDiff: t.mapWins - t.mapLosses, roundDiff: t.roundDiff,
          ownRemaining: ownCount[i],
          pct, status,
          byOwnWins, impacts,
        };
      });

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

  // ===================== Render helpers =====================
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (p) => {
    const pct = p * 100;
    if (pct === 100) return '100%';
    if (pct === 0) return '0%';
    if (pct >= 99.95) return '>99.9%';
    if (pct > 0 && pct < 0.05) return '<0.1%';
    return pct.toFixed(1) + '%';
  };
  const $ = (id) => document.getElementById(id);

  function renderStandings(probs) {
    const el = $('vpp-standings');
    el.innerHTML = '';
    probs.forEach(g => {
      const sub = g.remainingCount === 0
        ? 'all matches complete'
        : `${g.remainingCount} match${g.remainingCount === 1 ? '' : 'es'} remaining`;
      const sourceLabel = g.overridden
        ? 'manual'
        : (g.advCount && g.advCount > 0 && g.advCount < g.teamCount ? 'from page' : 'default');
      const sorted = [...g.teams].sort((a, b) =>
        b.pct - a.pct || b.wins - a.wins || b.mapDiff - a.mapDiff
      );

      const card = document.createElement('div');
      card.className = 'vpp-group';
      let html = `<div class="vpp-group-h">
        ${esc(g.name)}
        <span class="vpp-sub">— ${sub}</span>
        <span class="vpp-advance">
          top <input type="number" class="vpp-topn-input" data-group="${esc(g.name)}"
            value="${g.topN}" min="1" max="${g.teamCount}"> advance
          <span class="vpp-advance-src">(${sourceLabel})</span>
        </span>
      </div>`;
      html += `<table class="vpp-table">`;
      html += `<thead><tr>
        <th class="mod-rank">#</th>
        <th>Team</th>
        <th class="mod-rec">Rec</th>
        <th class="mod-pct">P(Top ${g.topN})</th>
      </tr></thead><tbody>`;
      sorted.forEach((r, i) => {
        const pct = r.pct * 100;
        const cls = [];
        if (r.status === 'qualified') cls.push('mod-qualified');
        else if (r.status === 'eliminated') cls.push('mod-eliminated');
        if (i < g.topN) cls.push('mod-in-top');
        else cls.push('mod-out-top');
        const rowCls = cls.join(' ');
        html += `
          <tr class="${rowCls}">
            <td class="mod-rank">${i + 1}</td>
            <td class="mod-team">
              <img src="${esc(r.logo)}" class="vpp-logo" alt="">
              <span>${esc(r.name)}</span>
            </td>
            <td class="mod-rec">${r.wins}&ndash;${r.losses}</td>
            <td class="mod-pct">
              <span class="vpp-meter"><span style="width:${pct.toFixed(2)}%"></span></span>
              <span class="vpp-pct-num">${fmt(r.pct)}</span>
            </td>
          </tr>`;
      });
      html += `</tbody></table>`;
      card.innerHTML = html;
      el.appendChild(card);
    });

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

  function populateTeamPicker(probs) {
    const sel = $('vpp-team-pick');
    const prev = sel.value;
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Select a team to see scenarios…';
    sel.appendChild(def);
    probs.forEach((g, gi) => {
      const og = document.createElement('optgroup');
      og.label = g.name;
      const sorted = [...g.teams].sort((a, b) => b.pct - a.pct || b.wins - a.wins);
      sorted.forEach(t => {
        const opt = document.createElement('option');
        opt.value = `${gi}:${t.idx}`;
        opt.textContent = `${t.name} (${t.wins}-${t.losses})`;
        og.appendChild(opt);
      });
      sel.appendChild(og);
    });
    sel.disabled = false;
    if (prev && [...sel.options].some(o => o.value === prev)) {
      sel.value = prev;
      renderTeam(prev);
    } else {
      $('vpp-team-view').innerHTML = '<div class="vpp-empty">Pick a team above to see how they can qualify.</div>';
    }
  }

  function summaryFor(t, topN) {
    if (t.ownRemaining === 0) {
      if (t.status === 'qualified') return `Done playing &mdash; they're through.`;
      if (t.status === 'eliminated') return `Done playing &mdash; didn't make it.`;
      return `They're done playing. Final spot is up to the rest of the group.`;
    }
    if (t.status === 'qualified') {
      return `Already through. Nothing left can drop ${esc(t.name)} out of the top ${topN}.`;
    }
    if (t.status === 'eliminated') {
      return `No remaining result puts ${esc(t.name)} into the top ${topN}.`;
    }
    const byK = new Map(t.byOwnWins.map(b => [b.k, b.pct]));
    const allWin = byK.get(t.ownRemaining);
    const allLose = byK.get(0);
    if (allWin === 1) {
      let minK = t.ownRemaining;
      for (let k = 0; k <= t.ownRemaining; k++) {
        if ((byK.get(k) || 0) === 1) { minK = k; break; }
      }
      const phrase = minK === 1
        ? 'Win their next one'
        : `Win ${minK} of ${t.ownRemaining}`;
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

  function findQualifyingPaths(group, teamIdx, topN) {
    const base = group.teams;
    const n = base.length;
    const teamLogoIdx = new Map(base.map((t, i) => [t.logo, i]));
    const remaining = group.matches
      .filter(m => !m.completed && teamLogoIdx.has(m.logoA) && teamLogoIdx.has(m.logoB))
      .map(m => ({ a: teamLogoIdx.get(m.logoA), b: teamLogoIdx.get(m.logoB) }));
    const R = remaining.length;

    const playedMatches = buildPlayedMatches(group, teamLogoIdx);

    const standingsFrom = (W, Lo, MD, RD, allMatches) => {
      const groups = rankTeams(n, W, MD, RD, allMatches);
      const flat = [];
      let pos = 0;
      for (const grp of groups) {
        for (const i of grp) {
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
        pos += grp.length;
      }
      return flat;
    };

    if (R === 0) {
      const W = new Int32Array(n), Lo = new Int32Array(n), MD = new Int32Array(n), RD = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        W[i] = base[i].wins; Lo[i] = base[i].losses;
        MD[i] = base[i].mapWins - base[i].mapLosses; RD[i] = base[i].roundDiff;
      }
      const finalStandings = standingsFrom(W, Lo, MD, RD, playedMatches);
      const rank = finalStandings.findIndex(s => s.idx === teamIdx);
      return { qualifies: rank < topN, paths: [], totalScenarios: 1, noMatches: true, finalStandings };
    }

    if (R > MAX_ENUM_MATCHES) return { tooBig: true };

    const evaluate = (mask) => {
      const W = new Int32Array(n), Lo = new Int32Array(n), MD = new Int32Array(n), RD = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        W[i] = base[i].wins; Lo[i] = base[i].losses;
        MD[i] = base[i].mapWins - base[i].mapLosses; RD[i] = base[i].roundDiff;
      }
      const allMatches = playedMatches.slice();
      const outcomes = new Array(R);
      for (let r = 0; r < R; r++) {
        const bits = (mask >>> (2 * r)) & 3;
        const o = decodeBits(bits);
        const winner = o.aWins ? remaining[r].a : remaining[r].b;
        const loser = o.aWins ? remaining[r].b : remaining[r].a;
        outcomes[r] = o;
        W[winner]++; Lo[loser]++;
        MD[winner] += o.wMaps - o.lMaps; MD[loser] -= o.wMaps - o.lMaps;
        RD[winner] += o.rd; RD[loser] -= o.rd;
        allMatches.push({ winner, loser, wMaps: o.wMaps, lMaps: o.lMaps, rd: o.rd });
      }
      const groups = rankTeams(n, W, MD, RD, allMatches);
      let pos = 0, rank = -1, cutoffIdx = -1;
      for (const grp of groups) {
        for (let k = 0; k < grp.length; k++) {
          const teamAtPos = grp[k];
          if (pos + k === topN) cutoffIdx = teamAtPos;
          if (teamAtPos === teamIdx) rank = pos + k;
        }
        pos += grp.length;
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
    };

    const total = 1 << (2 * R);
    const raw = [];
    let qualifyMass = 0;
    for (let mask = 0; mask < total; mask++) {
      const ev = evaluate(mask);
      if (!ev.qualifies) continue;
      let prob = 1;
      for (let r = 0; r < R; r++) {
        const bits = (mask >>> (2 * r)) & 3;
        const pA = winProb(remaining[r].a, remaining[r].b, base);
        prob *= bitWeight(bits, pA, sweepProb(pA));
      }
      qualifyMass += prob;
      raw.push({ mask, ...ev, probability: prob });
    }

    if (raw.length === 0) return { qualifies: false, totalScenarios: total, qualifyMass: 0 };

    raw.sort((a, b) => b.probability - a.probability || b.margin - a.margin);
    const best = raw[0];

    const matches = [];
    for (let r = 0; r < R; r++) {
      const o = best.outcomes[r];
      const winner = o.aWins ? remaining[r].a : remaining[r].b;
      const loser = o.aWins ? remaining[r].b : remaining[r].a;
      matches.push({
        winnerName: base[winner].name,
        winnerLogo: base[winner].logo,
        loserName: base[loser].name,
        loserLogo: base[loser].logo,
        wMaps: o.wMaps,
        lMaps: o.lMaps,
        rd: o.rd,
        isOwn: remaining[r].a === teamIdx || remaining[r].b === teamIdx,
      });
    }
    const finalStandings = standingsFrom(best.W, best.Lo, best.MD, best.RD, best.allMatches);
    const target = finalStandings.find(s => s.isTarget);
    const cutoff = finalStandings[topN];
    const rdMatters = !!cutoff && target.wins === cutoff.wins && target.mapDiff === cutoff.mapDiff;

    const path = {
      matches,
      finalStandings,
      rank: best.rank + 1,
      probability: best.probability,
      rdMatters,
    };

    return { qualifies: true, path, qualifyMass };
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function renderQualifyingPaths(result, topN, teamName) {
    if (!result) return '';
    if (result.tooBig) {
      return `<div class="vpp-card"><div class="vpp-card-h">Easiest path</div>
        <div class="vpp-empty">Too many remaining matches to enumerate.</div></div>`;
    }
    if (result.noMatches) {
      const head = result.qualifies
        ? '<b>No matches left — qualified.</b>'
        : '<b>No matches left — did not qualify.</b>';
      let html = `<div class="vpp-card"><div class="vpp-card-h">Final standings</div>${head}`;
      html += renderStandingsTable(result.finalStandings);
      html += `</div>`;
      return html;
    }
    if (!result.qualifies) {
      return `<div class="vpp-card"><div class="vpp-card-h">Easiest path</div>
        <div class="vpp-summary mod-eliminated">No combination of remaining results puts ${esc(teamName)} in the top ${topN}.</div></div>`;
    }

    const p = result.path;
    const target = p.finalStandings.find(s => s.isTarget);
    const sgn = (v) => (v >= 0 ? '+' : '') + v;
    const showRD = p.rdMatters;

    let html = `<div class="vpp-card">
      <div class="vpp-card-h">Easiest path</div>
      <div class="vpp-path">
        <table class="vpp-ideal"><tbody>`;
    p.matches.forEach((m, mi) => {
      const ownCls = m.isOwn ? ' mod-own' : '';
      html += `<tr class="${ownCls}">
        <td class="vpp-ideal-num">${mi + 1}</td>
        <td class="vpp-ideal-match">
          <img src="${esc(m.winnerLogo)}" class="vpp-logo" alt="">
          <b>${esc(m.winnerName)}</b> beat ${esc(m.loserName)}
          <img src="${esc(m.loserLogo)}" class="vpp-logo" alt="">
        </td>
        <td class="vpp-ideal-score">${m.wMaps}&ndash;${m.lMaps}</td>
        ${showRD ? `<td class="vpp-ideal-rd">+${m.rd} RD</td>` : ''}
      </tr>`;
    });
    html += `</tbody></table>
        <div class="vpp-path-result">
          Finishes ${ordinal(target.rank)} · ${target.wins}&ndash;${target.losses} ·
          MD ${sgn(target.mapDiff)}${showRD ? ` · RD ${sgn(target.roundDiff)}` : ''}
        </div>
      </div>
    </div>`;
    return html;
  }

  function renderStandingsTable(standings) {
    let html = `<table class="vpp-table"><thead><tr>
      <th class="mod-rank">#</th><th>Team</th>
      <th class="mod-rec">Rec</th><th class="mod-rec">MD</th><th class="mod-rec">RD</th>
    </tr></thead><tbody>`;
    standings.forEach(s => {
      const cls = (s.qualifies ? 'mod-in-top' : 'mod-out-top') + (s.isTarget ? ' mod-target-row' : '');
      const sgn = (v) => (v >= 0 ? '+' : '') + v;
      html += `<tr class="${cls}">
        <td class="mod-rank">${s.rank}</td>
        <td class="mod-team">
          <img src="${esc(s.logo)}" class="vpp-logo" alt="">
          <span>${esc(s.name)}${s.isTarget ? ' <span class="vpp-target-mark">★</span>' : ''}</span>
        </td>
        <td class="mod-rec">${s.wins}&ndash;${s.losses}</td>
        <td class="mod-rec">${sgn(s.mapDiff)}</td>
        <td class="mod-rec">${sgn(s.roundDiff)}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
    return html;
  }

  function renderTeam(key) {
    const view = $('vpp-team-view');
    if (!key || !lastSim) {
      view.innerHTML = '<div class="vpp-empty">Pick a team above to see how they can qualify.</div>';
      return;
    }
    const [gi, ti] = key.split(':').map(Number);
    const g = lastSim[gi];
    const t = g.teams.find(x => x.idx === ti);
    if (!t) { view.innerHTML = ''; return; }
    const topN = g.topN;
    const rawGroup = lastData && lastData.groups[gi];
    const paths = rawGroup ? findQualifyingPaths(rawGroup, ti, topN) : null;

    const statusLabel = t.status === 'qualified'
      ? 'QUALIFIED'
      : t.status === 'eliminated'
        ? 'ELIMINATED'
        : `${fmt(t.pct)} TO QUALIFY`;

    let html = `
      <div class="vpp-team-header mod-${t.status}">
        <div class="vpp-team-name-large">
          <img src="${esc(t.logo)}" class="vpp-logo" alt="">
          <span>${esc(t.name)}</span>
        </div>
        <div class="vpp-team-status">${statusLabel}</div>
      </div>
      <div class="vpp-team-meta">
        ${t.wins}&ndash;${t.losses} record &middot; ${(t.mapDiff >= 0 ? '+' : '') + t.mapDiff} map diff &middot;
        ${t.ownRemaining} match${t.ownRemaining === 1 ? '' : 'es'} of their own left &middot;
        ${g.remainingCount} total left in group
      </div>
      <div class="vpp-summary mod-${t.status}">${summaryFor(t, topN)}</div>
    `;

    html += renderQualifyingPaths(paths, topN, t.name);

    if (t.status === 'alive' && t.ownRemaining > 0) {
      html += `<div class="vpp-card"><div class="vpp-card-h">By their own wins</div><table class="vpp-kv">`;
      t.byOwnWins.forEach(b => {
        html += `<tr><td>Wins ${b.k} of remaining ${t.ownRemaining}</td><td>${fmt(b.pct)}</td></tr>`;
      });
      html += `</table></div>`;

      const own = t.impacts.filter(m => m.isOwn);
      if (own.length) {
        html += `<div class="vpp-card"><div class="vpp-card-h">Their remaining matches</div>
          <table class="vpp-impacts"><thead><tr>
            <th>Match</th><th>If win</th><th>If lose</th>
          </tr></thead><tbody>`;
        own.forEach(m => {
          html += `<tr>
            <td>vs ${esc(m.opponent)}</td>
            <td class="mod-favored">${m.p_win != null ? fmt(m.p_win) : '—'}</td>
            <td>${m.p_lose != null ? fmt(m.p_lose) : '—'}</td>
          </tr>`;
        });
        html += `</tbody></table></div>`;
      }

      const others = t.impacts
        .filter(m => !m.isOwn && m.p_a != null && m.p_b != null)
        .map(m => ({ ...m, swing: Math.abs((m.p_a || 0) - (m.p_b || 0)) }))
        .filter(m => m.swing >= 0.005)
        .sort((a, b) => b.swing - a.swing);
      if (others.length) {
        html += `<div class="vpp-card"><div class="vpp-card-h">Other matches that swing their chances</div>
          <table class="vpp-impacts"><thead><tr>
            <th>Match</th><th>If A wins</th><th>If B wins</th>
          </tr></thead><tbody>`;
        others.forEach(m => {
          const aFav = m.p_a > m.p_b ? 'mod-favored' : '';
          const bFav = m.p_b > m.p_a ? 'mod-favored' : '';
          html += `<tr>
            <td>${esc(m.aName)} vs ${esc(m.bName)}</td>
            <td class="${aFav}">${fmt(m.p_a)}</td>
            <td class="${bFav}">${fmt(m.p_b)}</td>
          </tr>`;
        });
        html += `</tbody></table></div>`;
      }
    }

    view.innerHTML = html;
  }

  // ===================== Panel build =====================
  function buildPanel() {
    const panel = document.createElement('div');
    panel.className = 'wf-card mod-dark vpp-root';
    panel.innerHTML = `
      <div class="vpp-head">
        <div class="vpp-title">Playoff Probability</div>
        <div class="vpp-tabs">
          <button type="button" class="vpp-tab vpp-tab-active" data-pane="standings">Standings</button>
          <button type="button" class="vpp-tab" data-pane="scenarios">Scenarios</button>
        </div>
        <button type="button" class="vpp-collapse" aria-label="Collapse">&minus;</button>
      </div>
      <div class="vpp-body">
        <div class="vpp-controls">
          <button type="button" id="vpp-run" class="vpp-run">Refresh</button>
          <div class="vpp-status" id="vpp-status"></div>
        </div>
        <div id="vpp-standings" class="vpp-pane vpp-pane-active"></div>
        <div id="vpp-scenarios" class="vpp-pane">
          <select id="vpp-team-pick" class="vpp-team-pick" disabled>
            <option>Run simulation first…</option>
          </select>
          <div id="vpp-team-view">
            <div class="vpp-empty">Pick a team above to see how they can qualify.</div>
          </div>
        </div>
      </div>
    `;
    insertBeforeNode.parentNode.insertBefore(panel, insertBeforeNode);
    return panel;
  }

  function clamp(n, lo, hi) {
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function runSim() {
    const statusEl = $('vpp-status');
    const runBtn = $('vpp-run');
    runBtn.disabled = true;
    statusEl.textContent = 'Reading page…';

    let data;
    try {
      data = scrapeData();
      if (!data.groups.length) throw new Error('No group data found.');
    } catch (e) {
      statusEl.textContent = `Error: ${e.message}`;
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
        lastMeta = { dt };
        renderStandings(probs);
        populateTeamPicker(probs);
        const anyApprox = probs.some(g => !g.exact);
        statusEl.textContent = anyApprox
          ? `${dt.toFixed(0)} ms · sampled (>${MAX_ENUM_MATCHES} matches left)`
          : `${dt.toFixed(0)} ms · exact`;
      } catch (e) {
        statusEl.textContent = `Error: ${e.message}`;
      } finally {
        runBtn.disabled = false;
      }
    });
  }

  // ===================== Bootstrap =====================
  const panel = buildPanel();
  $('vpp-run').addEventListener('click', runSim);
  panel.querySelectorAll('.vpp-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.vpp-tab').forEach(x => x.classList.toggle('vpp-tab-active', x === btn));
      panel.querySelectorAll('.vpp-pane').forEach(p => p.classList.toggle('vpp-pane-active', p.id === 'vpp-' + btn.dataset.pane));
    });
  });
  $('vpp-team-pick').addEventListener('change', () => renderTeam($('vpp-team-pick').value));
  panel.querySelector('.vpp-collapse').addEventListener('click', () => {
    panel.classList.toggle('vpp-collapsed');
    panel.querySelector('.vpp-collapse').innerHTML = panel.classList.contains('vpp-collapsed') ? '+' : '&minus;';
  });

  runSim();
})();
