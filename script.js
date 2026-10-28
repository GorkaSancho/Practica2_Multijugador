(() => {
  'use strict';

  const CONFIG = { target: 5, minLen: 4, maxLen: 12, countdownMs: 700 };

  // ───────────────────────────────────────────────────────────
  // LÓGICA DE PARTIDA (sin DOM, sin tiempos, sin red)
  // ───────────────────────────────────────────────────────────
  const DIRS = ['up', 'down', 'left', 'right'];

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createMatch({ seed, target, minLen, maxLen }) {
    const rng = mulberry32(seed);
    let pos = 0, score = 0, fails = 0, lastKey = '';

    // Dentro de createMatch para que no se pueda llamar desde fuera y hacer trampas
    function roll() {
      let next, key;
      do {
        const len = minLen + Math.floor(rng() * (maxLen - minLen + 1));
        next = Array.from({ length: len }, () => DIRS[Math.floor(rng() * DIRS.length)]);
        key = next.join(',');
      } while (key === lastKey);
      lastKey = key;
      return next;
    }

    let combo = roll();

    return {
      press(dir) {
        if (dir !== combo[pos]) { fails++; pos = 0; return { type: 'fail' }; }
        if (++pos < combo.length) return { type: 'progress', pos };
        pos = 0;
        if (++score >= target) return { type: 'win', score };
        combo = roll();
        return { type: 'complete', score };
      },
      state: () => ({ combo: combo.slice(), pos, score, fails }),
    };
  }

  // ───────────────────────────────────────────────────────────
  // INTERFAZ
  // ───────────────────────────────────────────────────────────
  const KEY_TO_DIR = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  const NAME = { up: 'arriba', down: 'abajo', left: 'izquierda', right: 'derecha' };
  const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V5M5.5 11.5 12 5l6.5 6.5"/></svg>';
  const SAMPLE = ['up', 'up', 'left', 'right', 'down', 'left'];
  const BEST_KEY = 'duelo-flechas:mejor-tiempo';

  const $ = (id) => document.getElementById(id);
  const stageEl = $('stage'), pipsEl = $('pips'), countEl = $('count');
  const clockEl = $('clock'), statusEl = $('status'), overlayEl = $('overlay'), padEl = $('pad');

  let match, tiles = [];
  let phase = 'idle'; // idle | countdown | playing | locked | result
  let t0 = 0, comboT0 = 0, comboTimes = [];
  let clockOn = false, timer = 0;
  const keys = {}, keyTimers = {};

  const fmt = (ms) => (ms / 1000).toFixed(1) + ' s';

  function readBest() {
    try { return Number(localStorage.getItem(BEST_KEY)) || null; } catch (_) { return null; }
  }
  function writeBest(ms) {
    try { localStorage.setItem(BEST_KEY, String(Math.round(ms))); } catch (_) {}
  }

  function setStatus(text = '', kind = '') {
    statusEl.textContent = text;
    statusEl.className = 'status ' + kind;
  }

  function renderPips(score) {
    pipsEl.innerHTML = '<span class="pip on"></span>'.repeat(score) +
                       '<span class="pip"></span>'.repeat(CONFIG.target - score);
    countEl.textContent = score + ' / ' + CONFIG.target;
  }

  function renderCombo(combo, pos, asSample) {
    const half = combo.length > 6 ? Math.ceil(combo.length / 2) : combo.length;
    const rows = [];
    for (let i = 0; i < combo.length; i += half) rows.push(combo.slice(i, i + half));
    stageEl.innerHTML = rows.map((row) =>
      '<div class="row">' +
      row.map((d) => `<div class="tile" data-dir="${d}">${ARROW}</div>`).join('') +
      '</div>').join('');
    tiles = [...stageEl.querySelectorAll('.tile')];
    stageEl.setAttribute('aria-label', asSample
      ? 'Ejemplo de combinación'
      : `Combinación de ${combo.length} flechas: ` + combo.map((d) => NAME[d]).join(', '));
    if (!asSample) updateTiles(pos);
  }

  function updateTiles(pos) {
    tiles.forEach((t, i) => {
      t.classList.remove('done', 'current', 'fail');
      if (i < pos) t.classList.add('done');
      else if (i === pos) t.classList.add('current');
    });
  }

  function buildPad() {
    ['up', 'left', 'down', 'right'].forEach((dir) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'key';
      b.dataset.dir = dir;
      b.tabIndex = -1;
      b.setAttribute('aria-label', 'Flecha ' + NAME[dir]);
      b.innerHTML = ARROW;
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); handleDir(dir); });
      padEl.appendChild(b);
      keys[dir] = b;
    });
  }

  function flashKey(dir) {
    keys[dir].classList.add('hit');
    clearTimeout(keyTimers[dir]);
    keyTimers[dir] = setTimeout(() => keys[dir].classList.remove('hit'), 110);
  }

  function tick() {
    if (!clockOn) return;
    clockEl.textContent = fmt(performance.now() - t0);
    requestAnimationFrame(tick);
  }

  // ── Pantallas superpuestas ────────────────────────────────
  function showOverlay(html) {
    overlayEl.innerHTML = html;
    overlayEl.hidden = false;
    overlayEl.querySelector('.btn')?.focus();
  }
  function hideOverlay() {
    overlayEl.hidden = true;
    document.activeElement?.blur();
  }
  // Un único listener para los botones "Empezar" y "Jugar otra vez"
  overlayEl.addEventListener('click', (e) => { if (e.target.closest('.btn')) startCountdown(); });

  function showIdle() {
    phase = 'idle';
    const best = readBest();
    showOverlay(
      '<h2>Repite la combinación</h2>' +
      `<p>Aparecen entre ${CONFIG.minLen} y ${CONFIG.maxLen} flechas. Púlsalas en el mismo orden con el teclado. ` +
      `Si fallas, esa combinación vuelve a empezar. Consigue ${CONFIG.target} puntos lo más rápido que puedas.</p>` +
      (best ? `<p class="record">Tu mejor tiempo: ${fmt(best)}</p>` : '') +
      '<button class="btn" type="button">Empezar</button>'
    );
  }

  function showResult(total) {
    phase = 'result';
    const avg = comboTimes.reduce((a, b) => a + b, 0) / comboTimes.length;
    const best = readBest();
    const isRecord = !best || total < best;
    if (isRecord) writeBest(total);
    showOverlay(
      '<h2>Partida completada</h2>' +
      '<dl class="stats">' +
        `<div><dt>Tiempo total</dt><dd>${fmt(total)}</dd></div>` +
        `<div><dt>Fallos</dt><dd>${match.state().fails}</dd></div>` +
        `<div><dt>Media por combo</dt><dd>${fmt(avg)}</dd></div>` +
        `<div><dt>Combo más rápido</dt><dd>${fmt(Math.min(...comboTimes))}</dd></div>` +
      '</dl>' +
      '<p class="record">' + (isRecord ? '<strong>Nuevo récord</strong>' : 'Tu mejor tiempo: ' + fmt(best)) + '</p>' +
      '<button class="btn" type="button">Jugar otra vez</button>'
    );
  }

  // ── Flujo de partida ──────────────────────────────────────
  function startCountdown() {
    clearTimeout(timer);
    clockOn = false;
    phase = 'countdown';
    match = createMatch({ seed: (Math.random() * 4294967296) >>> 0, ...CONFIG });
    comboTimes = [];
    clockEl.textContent = '0.0 s';
    renderPips(0);
    renderCombo(SAMPLE, 0, true);
    setStatus();

    let n = 3;
    const step = () => {
      if (n === 0) return begin();
      showOverlay(`<div class="big" aria-live="assertive">${n--}</div><p>Prepara las flechas</p>`);
      timer = setTimeout(step, CONFIG.countdownMs);
    };
    step();
  }

  function begin() {
    hideOverlay();
    renderCombo(match.state().combo, 0);
    setStatus('Repite la combinación');
    phase = 'playing';
    t0 = comboT0 = performance.now();
    clockOn = true;
    tick();
  }

  // Bloquea las pulsaciones unos ms (para que se vea la animación) y luego ejecuta fn
  function lockThen(ms, fn) {
    phase = 'locked';
    timer = setTimeout(fn, ms);
  }

  function handleDir(dir) {
    flashKey(dir);
    if (phase !== 'playing') return;
    const ev = match.press(dir);
    const now = performance.now();

    if (ev.type === 'progress') {
      updateTiles(ev.pos);
      return;
    }

    if (ev.type === 'fail') {
      tiles.forEach((t) => { t.classList.remove('done', 'current'); t.classList.add('fail'); });
      setStatus('Fallo. Esa combinación empieza de nuevo', 'bad');
      lockThen(260, () => { updateTiles(0); setStatus('Repite la combinación'); phase = 'playing'; });
      return;
    }

    // complete | win: se ha terminado una combinación
    comboTimes.push(now - comboT0);
    updateTiles(tiles.length);
    renderPips(ev.score);

    if (ev.type === 'complete') {
      setStatus('¡Punto!', 'good');
      lockThen(420, () => {
        renderCombo(match.state().combo, 0);
        setStatus('Repite la combinación');
        comboT0 = performance.now();
        phase = 'playing';
      });
    } else {
      clockOn = false;
      const total = now - t0;
      clockEl.textContent = fmt(total);
      setStatus('¡Cinco de cinco!', 'good');
      lockThen(650, () => showResult(total));
    }
  }

  window.addEventListener('keydown', (e) => {
    const dir = KEY_TO_DIR[e.key];
    if (!dir || phase === 'idle' || phase === 'result') return;
    e.preventDefault();
    if (!e.repeat) handleDir(dir);
  });

  // ── Arranque ──────────────────────────────────────────────
  buildPad();
  renderPips(0);
  renderCombo(SAMPLE, 0, true);
  showIdle();
})();
