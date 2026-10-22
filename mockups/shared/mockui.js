/* Shared mockup wiring: menu controls, screen switching, HUD panels. Each skin supplies a theme object + CSS. */
(function (global) {
  'use strict';
  const MM = global.MockMap;
  const WORDS = ['NEON', 'CHROME', 'VOID', 'GHOST', 'RUST', 'HALO', 'ZERO', 'PRISM', 'OXIDE', 'CIPHER', 'STATIC', 'NOVA'];
  const FAKE_CARDS = [3, 2, 4, 1, 0, 2, 1, 3];

  function hex(seed, salt, n) {
    let out = ''; let i = 0;
    while (out.length < n) out += MM.hash(seed + ':' + salt + ':' + (i++)).toString(16).padStart(8, '0');
    return out.slice(0, n);
  }

  function randomSeed() {
    return WORDS[Math.floor(Math.random() * WORDS.length)] + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  }

  function init(theme) {
    const $ = id => document.getElementById(id);
    const st = { players: 4, seed: randomSeed() };
    if (window !== window.top) document.querySelector('.mock-switch').style.display = 'none';

    function show(name) {
      document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
      document.querySelectorAll('[data-screen]').forEach(b => b.classList.toggle('active', b.dataset.screen === name));
      history.replaceState(null, '', '#' + name);
      if (name === 'map') drawGame();
    }
    document.querySelectorAll('[data-screen]').forEach(b => b.addEventListener('click', () => show(b.dataset.screen)));

    const pc = $('pc-buttons');
    for (let n = 2; n <= 8; n++) {
      const b = document.createElement('button');
      b.className = 'pc-btn'; b.textContent = n; b.dataset.n = n;
      b.addEventListener('click', () => { st.players = n; st.seed = randomSeed(); $('seed').value = st.seed; refreshMenu(); });
      pc.appendChild(b);
    }
    $('seed').value = st.seed;
    $('seed').addEventListener('input', e => { st.seed = e.target.value.toUpperCase() || randomSeed(); refreshMenu(); });
    $('randomize').addEventListener('click', () => {
      st.seed = randomSeed();
      $('seed').value = st.seed; refreshMenu();
    });
    $('start').addEventListener('click', () => show('map'));

    function refreshMenu() {
      pc.querySelectorAll('.pc-btn').forEach(b => b.classList.toggle('active', +b.dataset.n === st.players));
      const map = MM.generate(st);
      MM.render($('preview'), map, theme, { labels: false, badges: false, arrows: false, preview: true });
      $('slots').innerHTML = map.players.map((p, i) => `
        <li class="slot" style="--pc:${theme.players[i]}">
          <span class="sw"></span><span class="idx">P${i + 1}</span>
          <span class="nm">${p.name === 'YOU' ? 'COMMANDER' : p.name}</span>
          <span class="tp">${i === 0 ? 'HUMAN' : 'BOT · DUMB'}</span>
        </li>`).join('');
      $('map-stats').innerHTML = [[map.T, 'TERRITORIES'], [map.C, 'CONTINENTS'], [map.hexCount, 'HEXES'], [map.lanes.length, 'SEA LANES']]
        .map(([v, l]) => `<div class="stat"><b>${v}</b><small>${l}</small></div>`).join('');
    }

    function drawGame() {
      const map = MM.generate(st);
      MM.render($('map'), map, theme, {});
      const P = map.players; const plan = map.plan;
      const tn = id => map.territories[id].name;
      const rng = MM.mulberry32(MM.hash(st.seed + 'log'));

      $('turn-num').textContent = '07';
      $('active-player').innerHTML = `<span class="sw" style="--pc:${theme.players[0]}"></span><span class="nm">${P[0].name}</span><small>PLANNING</small>`;
      $('state-hash').innerHTML = `<span><small>STATE</small><code>${hex(st.seed, 's', 6)}…${hex(st.seed, 's2', 4)}</code></span>` +
        `<span><small>CHAIN</small><code>${hex(st.seed, 'c', 6)}…${hex(st.seed, 'c2', 4)}</code></span>`;

      $('roster').innerHTML = P.map((p, i) => `
        <li class="roster-row ${i === 0 ? 'is-active' : ''}" style="--pc:${theme.players[i]}">
          <span class="sw"></span><span class="nm">${p.name}</span>
          <span class="st"><i>${p.territories}<em>TER</em></i><i>${p.troops}<em>TRP</em></i><i>${FAKE_CARDS[i]}<em>CRD</em></i></span>
        </li>`).join('');

      $('continents').innerHTML = map.continents.map(c => {
        const counts = new Array(P.length).fill(0);
        c.territoryIds.forEach(id => counts[map.territories[id].owner]++);
        const lead = counts.indexOf(Math.max(...counts));
        const pct = Math.round(counts[lead] / c.territoryIds.length * 100);
        return `<li class="cont-row" style="--cc:${theme.continentColors[c.id]};--pc:${theme.players[lead]}">
          <span class="sw"></span><span class="nm">${c.name}</span><span class="bn">+${c.bonus}</span>
          <span class="bar"><span style="width:${pct}%"></span></span>
          <span class="own">${counts[lead]}/${c.territoryIds.length} ${P[lead].name}</span></li>`;
      }).join('');

      const base = Math.max(3, Math.floor(P[0].territories / 3));
      const contBonus = map.continents.filter(c => c.territoryIds.every(id => map.territories[id].owner === 0)).reduce((a, c) => a + c.bonus, 0);
      const cardBonus = 10; const total = base + contBonus + cardBonus;
      $('reinforce').innerHTML = `
        <div class="rf-row"><span>BASE</span><b>+${base}</b></div>
        <div class="rf-row"><span>CONTINENTS</span><b>+${contBonus}</b></div>
        <div class="rf-row"><span>CARD SET</span><b>+${cardBonus}</b></div>
        <div class="cards"><span class="card inf">INF</span><span class="card cav">CAV</span><span class="card art">ART</span><span class="card-arrow">→ +10</span></div>
        <div class="rf-total"><span>TOTAL</span><b>${total}</b><small>0 UNASSIGNED</small></div>`;

      const drafts = [];
      const srcA = plan.attacks[0]; const srcB = plan.attacks.find(a => !a.chain && a !== srcA);
      if (srcA) drafts.push([srcA.from, srcB ? total - 4 : total]);
      if (srcB) drafts.push([srcB.from, 4]);
      $('draft-list').innerHTML = drafts.map(([id, n]) => `<li class="draft-row"><span class="nm">${tn(id)}</span><b>+${n}</b></li>`).join('');

      $('attack-queue').innerHTML = plan.attacks.map((a, i) => `
        <li class="atk-row ${a.chain ? 'chain' : ''}">
          <span class="no">${i + 1}</span>
          <span class="path"><span class="from">${a.chain ? '↳ ' : ''}${tn(a.from)}</span><span class="arr">→</span><span class="to">${tn(a.to)}</span></span>
          <span class="opts"><span class="opt">STOP ≤ 2</span><span class="opt">OCCUPY ALL−1</span>${a.chain ? '<span class="opt tag">IF CAPTURED</span>' : ''}</span>
          <button class="x" title="Remove">×</button>
        </li>`).join('');

      $('fortify').innerHTML = plan.fortify
        ? `<div class="fort-row"><span class="from">${tn(plan.fortify.from)}</span><span class="arr">⇢</span><span class="to">${tn(plan.fortify.to)}</span><b>${plan.fortify.troops}</b></div>`
        : '<div class="fort-row empty">NO FORTIFY QUEUED</div>';

      const roll = n => Array.from({ length: n }, () => 1 + Math.floor(rng() * 6)).sort((a, b) => b - a);
      const dice = (arr, cls) => `<span class="dice ${cls}">${arr.map(d => `<span class="die">${d}</span>`).join('')}</span>`;
      const lines = [];
      for (let i = 0; i < 5; i++) {
        const who = 1 + (i % (P.length - 1));
        const t1 = map.territories[Math.floor(rng() * map.T)]; const t2 = map.territories[[...t1.adj][0]];
        const capt = rng() < 0.4;
        lines.push(`<li><span class="turn">T06</span><span class="who" style="--pc:${theme.players[who]}">${P[who].name}</span>
          <span class="where">${t1.name} → ${t2.name}</span>${dice(roll(3), 'atk')}<span class="vs">vs</span>${dice(roll(2), 'def')}
          <span class="res ${capt ? 'cap' : ''}">${capt ? 'CAPTURED' : '−1 / −1'}</span></li>`);
      }
      $('battle-log').innerHTML = lines.join('');
    }

    refreshMenu();
    show(location.hash === '#map' ? 'map' : 'menu');
  }

  global.MockUI = { init, randomSeed };
})(window);
