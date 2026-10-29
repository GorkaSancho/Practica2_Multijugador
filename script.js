/**
 * Duel de Fletxes: client del joc.
 * Dos modes:
 *   - Entrenament: un jugador, tota la lògica al navegador (createMatch).
 *   - En línia: el servidor (server.js) decideix; aquí només es dibuixa i es valida en local.
 *
 * Tot va dins d'una IIFE perquè les variables no siguin globals.
 */
(() => {
  'use strict'; // els errors d'escriptura (variables sense declarar...) llancen excepció

  /** Configuració del mode Entrenament (el mode en línia la porta el servidor). */
  const CONFIG = { target: 5, minLen: 4, maxLen: 12, countdownMs: 700 };

  // ───────────────────────────────────────────────────────────
  // LÒGICA DE PARTIDA (sense DOM, sense temps, sense xarxa)
  // ───────────────────────────────────────────────────────────
  const DIRS = ['up', 'down', 'left', 'right'];

  /**
   * Generador de nombres pseudoaleatoris repetible (mulberry32).
   * Amb la mateixa llavor dóna sempre la mateixa seqüència de valors a [0, 1).
   * @param {number} seed Llavor de 32 bits.
   * @returns {() => number} Funció que retorna el següent nombre.
   */
  function mulberry32(seed) {
    let a = seed >>> 0; // enter de 32 bits sense signe
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a); // imul: producte enter de 32 bits
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // 2^32 → resultat a [0, 1)
    };
  }

  /**
   * Crea una partida d'un sol jugador. Retorna un objecte amb dues funcions;
   * les variables internes (pos, score...) són privades gràcies a la clausura.
   * @param {{seed:number, target:number, minLen:number, maxLen:number}} opts
   * @returns {{press:(dir:string)=>object, state:()=>object}}
   */
  function createMatch({ seed, target, minLen, maxLen }) {
    const rng = mulberry32(seed);
    let pos = 0, score = 0, fails = 0, lastKey = '';

    // Dins de createMatch perquè no es pugui cridar des de fora i fer trampes
    function roll() {
      let next, key;
      do {
        const len = minLen + Math.floor(rng() * (maxLen - minLen + 1));
        next = Array.from({ length: len }, () => DIRS[Math.floor(rng() * DIRS.length)]);
        key = next.join(','); // comparem text, perquè dos arrays mai són ===
      } while (key === lastKey);
      lastKey = key;
      return next;
    }

    let combo = roll();

    return {
      /**
       * Processa una pulsació i retorna l'esdeveniment resultant:
       * fail | progress | complete | win.
       */
      press(dir) {
        if (dir !== combo[pos]) { fails++; pos = 0; return { type: 'fail' }; }
        if (++pos < combo.length) return { type: 'progress', pos };
        pos = 0;
        if (++score >= target) return { type: 'win', score };
        combo = roll();
        return { type: 'complete', score };
      },
      /** Còpia de l'estat actual (combo.slice() evita que des de fora es pugui modificar). */
      state: () => ({ combo: combo.slice(), pos, score, fails }),
    };
  }

  // ───────────────────────────────────────────────────────────
  // INTERFÍCIE
  // ───────────────────────────────────────────────────────────
  const KEY_TO_DIR = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  const NAME = { up: 'amunt', down: 'avall', left: 'esquerra', right: 'dreta' };
  const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V5M5.5 11.5 12 5l6.5 6.5"/></svg>';
  const SAMPLE = ['up', 'up', 'left', 'right', 'down', 'left']; // combinació d'exemple del compte enrere
  const BEST_KEY = 'duelo-flechas:mejor-tiempo'; // clau de localStorage (es manté per no perdre rècords)
  // Si s'obre l'arxiu directament (file://), el servidor és a localhost; si no, és el mateix origen
  const SERVER = location.protocol === 'file:' ? 'http://localhost:3000' : '';

  /** Atall per cercar un element per id. */
  const $ = (id) => document.getElementById(id);
  const stageEl = $('stage'), pipsEl = $('pips'), countEl = $('count');
  const modeEl = $('mode'), sideEl = $('side');
  const clockEl = $('clock'), statusEl = $('status'), overlayEl = $('overlay'), padEl = $('pad');

  /** Dades de la partida en línia, o null si no s'hi està. */
  let online = null; // { code, id, es, round, combo, pos, presses, scores }
  let match, tiles = [];
  /** Fase del joc: idle | lobby | countdown | playing | waiting | locked | result */
  let phase = 'idle';
  let t0 = 0, comboT0 = 0, comboTimes = [];
  let clockOn = false, timer = 0;
  const keys = {}, keyTimers = {}; // botons del comandament i temporitzadors de la lluentor

  /** Escapa text per inserir-lo amb innerHTML (evita injecció d'HTML amb noms d'altres jugadors). */
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  /** Mil·lisegons → "1.2 s". */
  const fmt = (ms) => (ms / 1000).toFixed(1) + ' s';

  /** Llegeix el millor temps (ms) de localStorage, o null si no n'hi ha o no s'hi pot accedir. */
  function readBest() {
    try { return Number(localStorage.getItem(BEST_KEY)) || null; } catch (_) { return null; }
  }
  /** Desa el millor temps. Pot fallar (mode privat): s'ignora. */
  function writeBest(ms) {
    try { localStorage.setItem(BEST_KEY, String(Math.round(ms))); } catch (_) {}
  }

  /**
   * Missatge d'estat sota les fitxes.
   * @param {string} text Missatge (buit per esborrar).
   * @param {'good'|'bad'|''} kind Color: verd, vermell o neutre.
   */
  function setStatus(text = '', kind = '') {
    statusEl.textContent = text;
    statusEl.className = 'status ' + kind;
  }

  /** Dibuixa la barra de punts i el comptador "n / objectiu". */
  function renderPips(score) {
    pipsEl.innerHTML = '<span class="pip on"></span>'.repeat(score) +
                       '<span class="pip"></span>'.repeat(CONFIG.target - score);
    countEl.textContent = score + ' / ' + CONFIG.target;
  }

  /**
   * Dibuixa la combinació com a fitxes (en dues files si té més de 6 fletxes).
   * @param {string[]} combo Direccions.
   * @param {number} pos Fletxa actual (per marcar-la).
   * @param {boolean} [asSample] Si és l'exemple del compte enrere (no jugable).
   */
  function renderCombo(combo, pos, asSample) {
    const half = combo.length > 6 ? Math.ceil(combo.length / 2) : combo.length;
    const rows = [];
    for (let i = 0; i < combo.length; i += half) rows.push(combo.slice(i, i + half));
    stageEl.innerHTML = rows.map((row) =>
      '<div class="row">' +
      row.map((d) => `<div class="tile" data-dir="${d}">${ARROW}</div>`).join('') +
      '</div>').join('');
    tiles = [...stageEl.querySelectorAll('.tile')]; // cal reassignar: innerHTML ha destruït les antigues
    stageEl.setAttribute('aria-label', asSample
      ? 'Exemple de combinació'
      : `Combinació de ${combo.length} fletxes: ` + combo.map((d) => NAME[d]).join(', '));
    if (!asSample) updateTiles(pos);
  }

  /** Marca les fitxes: les anteriors a pos com a fetes (verd) i la de pos com a actual. */
  function updateTiles(pos) {
    tiles.forEach((t, i) => {
      t.classList.remove('done', 'current', 'fail');
      if (i < pos) t.classList.add('done');
      else if (i === pos) t.classList.add('current');
    });
  }

  /** Crea els quatre botons del comandament en pantalla. */
  function buildPad() {
    ['up', 'left', 'down', 'right'].forEach((dir) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'key';
      b.dataset.dir = dir;  // el CSS el fa servir per col·locar i girar la fletxa
      b.tabIndex = -1;      // no entra a l'ordre de tabulació
      b.setAttribute('aria-label', 'Fletxa ' + NAME[dir]);
      b.innerHTML = ARROW;
      // pointerdown és immediat (ratolí, dit i llapis); preventDefault evita events de compatibilitat
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); handleDir(dir); });
      padEl.appendChild(b);
      keys[dir] = b;
    });
  }

  /** Il·lumina un instant el botó del comandament de la direcció premuda. */
  function flashKey(dir) {
    keys[dir].classList.add('hit');
    clearTimeout(keyTimers[dir]); // si es prem de pressa, cancel·la l'apagada anterior
    keyTimers[dir] = setTimeout(() => keys[dir].classList.remove('hit'), 110);
  }

  /** Bucle del rellotge: s'executa a cada fotograma mentre clockOn sigui true. */
  function tick() {
    if (!clockOn) return;
    clockEl.textContent = fmt(performance.now() - t0); // rellotge monòton i d'alta resolució
    requestAnimationFrame(tick);
  }

  // ── Pantalles superposades ────────────────────────────────

  /** Mostra l'overlay amb aquest HTML i dóna el focus al primer camp o botó. */
  function showOverlay(html) {
    overlayEl.innerHTML = html;
    overlayEl.hidden = false;
    overlayEl.querySelector('input, .btn')?.focus();
  }

  /** Amaga l'overlay i treu el focus perquè Enter/Espai no tornin a activar cap botó. */
  function hideOverlay() {
    overlayEl.hidden = true;
    document.activeElement?.blur();
  }

  /**
   * Accions dels botons de l'overlay, pel valor del seu atribut data-action.
   * Els botons es recreen amb innerHTML, així que un sol listener al contenidor
   * (delegació d'esdeveniments) els serveix tots.
   */
  const ACTIONS = {
    solo: () => startCountdown(),
    menu: () => showIdle(),
    online: () => showOnlineMenu(),
    create: () => enterRoom(true),
    join: () => enterRoom(false),
    start: () => api(`/rooms/${online.code}/start`).catch(() => {}),
  };
  overlayEl.addEventListener('click', (e) => {
    ACTIONS[e.target.closest('[data-action]')?.dataset.action]?.();
  });

  /** Menú principal: tria entre Entrenament i En línia. */
  function showIdle() {
    leaveOnline(); // si veníem d'una partida en línia, es tanca la connexió
    phase = 'idle';
    const best = readBest();
    showOverlay(
      '<h2>Repeteix la combinació</h2>' +
      `<p>Apareixen entre ${CONFIG.minLen} i ${CONFIG.maxLen} fletxes. Prem-les en el mateix ordre amb el teclat. ` +
      `Si falles, aquesta combinació torna a començar. Aconsegueix ${CONFIG.target} punts tan ràpid com puguis.</p>` +
      (best ? `<p class="record">El teu millor temps: ${fmt(best)}</p>` : '') +
      '<div class="actions"><button class="btn" data-action="solo">Entrenament</button>' +
      '<button class="btn" data-action="online">En línia</button></div>'
    );
  }

  /** Pantalla de resultat de l'Entrenament: estadístiques i rècord. */
  function showResult(total) {
    phase = 'result';
    const avg = comboTimes.reduce((a, b) => a + b, 0) / comboTimes.length; // 0 = valor inicial
    const best = readBest();
    const isRecord = !best || total < best;
    if (isRecord) writeBest(total);
    showOverlay(
      '<h2>Partida completada</h2>' +
      '<dl class="stats">' +
        `<div><dt>Temps total</dt><dd>${fmt(total)}</dd></div>` +
        `<div><dt>Errors</dt><dd>${match.state().fails}</dd></div>` +
        `<div><dt>Mitjana per combo</dt><dd>${fmt(avg)}</dd></div>` +
        `<div><dt>Combo més ràpid</dt><dd>${fmt(Math.min(...comboTimes))}</dd></div>` +
      '</dl>' +
      '<p class="record">' + (isRecord ? '<strong>Nou rècord</strong>' : 'El teu millor temps: ' + fmt(best)) + '</p>' +
      '<div class="actions"><button class="btn" data-action="solo">Torna a jugar</button>' +
      '<button class="btn alt" data-action="menu">Menú</button></div>'
    );
  }

  // ── Flux de la partida (Entrenament) ──────────────────────

  /** Prepara una partida nova d'Entrenament i comença el compte enrere. */
  function startCountdown() {
    clearTimeout(timer);
    clockOn = false;
    phase = 'countdown';
    match = createMatch({ seed: (Math.random() * 4294967296) >>> 0, ...CONFIG });
    comboTimes = [];
    clockEl.textContent = '0.0 s';
    modeEl.textContent = 'Entrenament · un jugador';
    renderPips(0);
    renderCombo(SAMPLE, 0, true);
    setStatus();
    countdown(CONFIG.countdownMs, begin);
  }

  /**
   * Compte enrere 3, 2, 1 amb setTimeout encadenats (més fàcil de cancel·lar que setInterval).
   * @param {number} ms Durada de cada número.
   * @param {() => void} [done] Què fer en acabar (en línia no cal: ho marca el servidor).
   */
  function countdown(ms, done) {
    let n = 3;
    const step = () => {
      if (n === 0) return done?.();
      showOverlay(`<div class="big" aria-live="assertive">${n--}</div><p>Prepara les fletxes</p>`);
      timer = setTimeout(step, ms);
    };
    step();
  }

  /** Comença a jugar: dibuixa la combinació i engega el rellotge. */
  function begin() {
    hideOverlay();
    renderCombo(match.state().combo, 0);
    setStatus('Repeteix la combinació');
    phase = 'playing';
    t0 = comboT0 = performance.now();
    clockOn = true;
    tick();
  }

  /** Bloqueja les pulsacions ms mil·lisegons (perquè es vegi l'animació) i després executa fn. */
  function lockThen(ms, fn) {
    phase = 'locked';
    timer = setTimeout(fn, ms);
  }

  /** Error de pulsació (comú a Entrenament i en línia): fitxes en vermell i torna a començar. */
  function showFail() {
    tiles.forEach((t) => { t.classList.remove('done', 'current'); t.classList.add('fail'); });
    setStatus('Error. Aquesta combinació torna a començar', 'bad');
    lockThen(260, () => { updateTiles(0); setStatus('Repeteix la combinació'); phase = 'playing'; });
  }

  /**
   * Punt d'entrada de totes les pulsacions (teclat o comandament).
   * @param {'up'|'down'|'left'|'right'} dir
   */
  function handleDir(dir) {
    flashKey(dir);                       // el comandament sempre reacciona
    if (phase !== 'playing') return;     // ...però només compta si estem jugant
    if (online) return onlinePress(dir);

    const ev = match.press(dir);
    const now = performance.now();

    if (ev.type === 'progress') {
      updateTiles(ev.pos);
      return;
    }
    if (ev.type === 'fail') return showFail();

    // complete | win: s'ha acabat una combinació
    comboTimes.push(now - comboT0);
    updateTiles(tiles.length);
    renderPips(ev.score);

    if (ev.type === 'complete') {
      setStatus('Punt!', 'good');
      lockThen(420, () => {
        renderCombo(match.state().combo, 0);
        setStatus('Repeteix la combinació');
        comboT0 = performance.now();
        phase = 'playing';
      });
    } else {
      clockOn = false;
      const total = now - t0;
      clockEl.textContent = fmt(total);
      setStatus('Cinc de cinc!', 'good');
      lockThen(650, () => showResult(total));
    }
  }

  // ── En línia ──────────────────────────────────────────────

  /** POST amb JSON al servidor. Retorna la resposta o rebutja amb el missatge d'error del servidor. */
  const api = (path, body = {}) =>
    fetch(SERVER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json().then((d) => (r.ok ? d : Promise.reject(new Error(d.error)))));

  /** Punts del jugador local segons l'últim marcador rebut. */
  const myScore = () => online.scores.find((s) => s.id === online.id)?.score ?? 0;

  /** Dibuixa (o amaga) la classificació de la dreta, amb qui va guanyant a dalt. */
  function renderSide() {
    sideEl.hidden = !online;
    if (!online) return;
    const rows = [...online.scores].sort((a, b) => b.score - a.score);
    sideEl.innerHTML = '<h2>Classificació</h2><ol>' + rows.map((s) =>
      `<li class="${s.id === online.id ? 'me' : ''}"><span>${esc(s.name)}</span><b>${s.score}</b></li>`).join('') + '</ol>';
  }

  /** Tanca la connexió en línia i ho deixa tot a punt per al mode Entrenament. */
  function leaveOnline() {
    online?.es?.close();
    online = null;
    clearTimeout(timer);
    clockOn = false;
    renderSide();
  }

  /** Menú en línia: nom, codi de sala i botons per crear-la o unir-s'hi. */
  function showOnlineMenu() {
    showOverlay(
      '<h2>En línia</h2>' +
      '<input id="name" placeholder="El teu nom" maxlength="20" autocomplete="off">' +
      '<input id="code" placeholder="Codi de sala" maxlength="6" autocomplete="off">' +
      '<p class="err" id="err"></p>' +
      '<div class="actions"><button class="btn" data-action="create">Crea sala</button>' +
      '<button class="btn" data-action="join">Uneix-te</button>' +
      '<button class="btn alt" data-action="menu">Torna</button></div>'
    );
  }

  /** Sala d'espera: mostra el codi per compartir i el botó de començar. */
  function renderLobby() {
    showOverlay(
      `<h2>Sala ${esc(online.code)}</h2>` +
      `<p>Comparteix el codi. Jugadors connectats: ${online.scores.length}</p>` +
      '<button class="btn" data-action="start">Comença</button>'
    );
  }

  /**
   * Crea una sala (o s'hi uneix amb el codi escrit) i obre el canal d'esdeveniments.
   * @param {boolean} create true = crear sala nova; false = unir-se a la del camp de codi.
   */
  async function enterRoom(create) {
    const name = $('name').value.trim() || 'Jugador';
    let code = $('code').value.trim().toUpperCase();
    try {
      if (create) ({ code } = await api('/rooms'));
      const { playerId } = await api(`/rooms/${code}/join`, { name });
      online = { code, id: playerId, round: 0, combo: [], pos: 0, presses: [], scores: [] };
      modeEl.textContent = 'En línia · sala ' + code;
      phase = 'lobby';
      connect();
    } catch (err) {
      $('err').textContent = err.message; // p. ex. "sala no trobada"
    }
  }

  /**
   * Avisa de qui ha puntuat a la ronda anterior i, a l'1,5 s, torna al missatge normal.
   * @param {{scorers?: string[], scores: object[]}} d Dades de l'esdeveniment "round".
   */
  function announce({ scorers = [], scores }) {
    if (!scorers.length) return;
    const mine = scorers.includes(online.id);
    const who = scorers.map((id) => id === online.id ? 'tu' : scores.find((s) => s.id === id)?.name);
    const msg = mine && who.length === 1 ? 'Punt per a tu!' : 'Punt per a ' + who.join(', ');
    setStatus(msg, mine ? 'good' : 'bad');
    // Només es restableix si el missatge no ha estat substituït per un altre (p. ex. un error)
    setTimeout(() => { if (statusEl.textContent === msg) setStatus('Repeteix la combinació'); }, 1500);
  }

  /**
   * Canal SSE: el servidor decideix, el client només dibuixa el que li arriba.
   * Esdeveniments: players (marcador), start (compte enrere), round (combinació nova), gameOver.
   */
  function connect() {
    const es = online.es = new EventSource(`${SERVER}/rooms/${online.code}/events?player=${online.id}`);
    const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));

    on('players', (scores) => {
      online.scores = scores;
      renderSide();
      if (phase === 'lobby') renderLobby();
    });

    on('start', (d) => {
      phase = 'countdown';
      clockEl.textContent = '0.0 s';
      renderPips(0);
      renderCombo(SAMPLE, 0, true);
      setStatus();
      countdown(d.startsIn / 3); // tres números repartits en el temps que indica el servidor
    });

    on('round', (d) => {
      Object.assign(online, { round: d.round, combo: d.combo, scores: d.scores, pos: 0, presses: [] });
      clearTimeout(timer);
      hideOverlay();
      renderSide();
      renderPips(myScore());
      renderCombo(d.combo, 0);
      setStatus('Repeteix la combinació');
      announce(d);
      phase = 'playing';
      if (!clockOn) { t0 = performance.now(); clockOn = true; tick(); }
    });

    on('gameOver', (d) => {
      online.scores = d.scores;
      renderSide();
      renderPips(myScore());
      clearTimeout(timer);
      clockOn = false;
      phase = 'result';
      es.close();
      const names = d.winners.map((id) => esc(d.scores.find((s) => s.id === id).name)).join(', ');
      showOverlay(
        `<h2>${d.winners.includes(online.id) ? 'Has guanyat!' : 'Partida acabada'}</h2>` +
        `<p>Guanyador: ${names}</p>` +
        '<button class="btn" data-action="menu">Torna al menú</button>'
      );
    });

    // Si el navegador ha tancat el canal definitivament (p. ex. servidor aturat)
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) setStatus('Connexió perduda', 'bad'); };
  }

  /**
   * Pulsació en mode en línia. Es valida en local (resposta instantània) i, en acabar
   * la combinació, s'envia al servidor, que la comprova i decideix qui puntua.
   */
  function onlinePress(dir) {
    const o = online;
    if (dir !== o.combo[o.pos]) { o.pos = 0; o.presses = []; return showFail(); }
    o.presses.push(dir);
    updateTiles(++o.pos);
    if (o.pos < o.combo.length) return;
    phase = 'waiting'; // fins que arribi la ronda següent
    setStatus('Completada! Esperant el servidor…', 'good');
    // Si arriba tard el servidor respon 409; no cal fer res: la ronda nova ja arribarà per SSE
    api(`/rooms/${o.code}/complete`, { player: o.id, round: o.round, presses: o.presses }).catch(() => {});
  }

  // ── Teclat ────────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    const dir = KEY_TO_DIR[e.key];
    // Als menús (idle/result) no es fa res, perquè les fletxes han de poder moure el cursor als camps de text
    if (!dir || phase === 'idle' || phase === 'result') return;
    e.preventDefault();                 // evita el desplaçament de la pàgina
    if (!e.repeat) handleDir(dir);      // ignora la repetició en mantenir la tecla premuda
  });

  // ── Arrencada: es prepara la pantalla inicial ─────────────
  buildPad();
  renderPips(0);
  renderCombo(SAMPLE, 0, true);
  showIdle();
})();
