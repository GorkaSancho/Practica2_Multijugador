/**
 * Servidor del Duel de Fletxes (Node, sense dependències).
 * Ús: node server.js   (port 3000 o process.env.PORT)
 *
 * Fa dues feines:
 *   1. Serveix els arxius del joc (index.html, styles.css, script.js).
 *   2. Gestiona les sales i les partides en línia. El servidor és qui decideix.
 *
 * Protocol:
 *   POST /rooms                          crea una sala            → { code }
 *   POST /rooms/:code/join    { name }                            → { playerId }
 *   GET  /rooms/:code/events?player=ID   canal SSE (servidor → jugador)
 *   POST /rooms/:code/start              comença la partida
 *   POST /rooms/:code/complete  { player, round, presses }        combinació acabada
 *
 * Esdeveniments SSE que envia: players | start | round | gameOver
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Configuració de la partida.
 *  - target:       punts per guanyar
 *  - minLen/maxLen: mida de les combinacions
 *  - graceMs:      finestra de gràcia (ms) per comptar els qui arriben gairebé alhora
 *  - startDelayMs: compte enrere abans de la primera ronda
 */
const CONFIG = { target: 5, minLen: 4, maxLen: 12, graceMs: 120, startDelayMs: 3000 };
const DIRS = ['up', 'down', 'left', 'right'];

/** Totes les sales actives: codi → sala. Viuen només a la memòria del procés. */
const rooms = new Map();

// ───────────────────────────────────────────────────────────
// Lògica de combinacions (la mateixa idea que al client)
// ───────────────────────────────────────────────────────────

/**
 * Generador de nombres pseudoaleatoris repetible (mulberry32).
 * Amb la mateixa llavor dóna sempre la mateixa seqüència de valors a [0, 1).
 * @param {number} seed Llavor de 32 bits.
 * @returns {() => number} Funció que retorna el següent nombre.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Genera una combinació nova per a la sala, diferent de l'anterior.
 * @param {object} room Sala (usa room.rng i room.lastKey).
 * @returns {string[]} Llista de direccions.
 */
function newCombo(room) {
  let next, key;
  do {
    const len = CONFIG.minLen + Math.floor(room.rng() * (CONFIG.maxLen - CONFIG.minLen + 1));
    next = Array.from({ length: len }, () => DIRS[Math.floor(room.rng() * DIRS.length)]);
    key = next.join(','); // els arrays no es comparen per contingut; el text sí
  } while (key === room.lastKey);
  room.lastKey = key;
  return next;
}

// ───────────────────────────────────────────────────────────
// Enviament de paquets (SSE)
// ───────────────────────────────────────────────────────────

/** Marcador de la sala: només les dades públiques de cada jugador. */
const scoreboard = (room) =>
  [...room.players.values()].map(({ id, name, score }) => ({ id, name, score }));

/**
 * Escriu un missatge SSE en una resposta oberta.
 * Format: línies "camp: valor" i una línia en blanc final.
 */
function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Envia un esdeveniment a tots els jugadors connectats de la sala. */
function broadcast(room, event, data) {
  for (const p of room.players.values()) if (p.res) send(p.res, event, data);
}

// ───────────────────────────────────────────────────────────
// Rondes
// ───────────────────────────────────────────────────────────

/**
 * Comença una ronda nova: genera la combinació i l'envia a tothom.
 * @param {object} room
 * @param {string[]} scorers Ids dels qui han puntuat a la ronda anterior (per avisar-ne).
 */
function startRound(room, scorers = []) {
  room.round++;
  room.combo = newCombo(room);
  room.winners = null; // ningú ha acabat encara aquesta ronda
  broadcast(room, 'round', { round: room.round, combo: room.combo, scores: scoreboard(room), scorers });
}

/**
 * Es crida en acabar la finestra de gràcia: reparteix punts i decideix si hi ha guanyador.
 * @param {object} room
 * @param {number} round Ronda per a la qual es va programar el tancament.
 */
function closeRound(room, round) {
  // Si la ronda ja ha canviat (o la partida ha acabat), aquest temporitzador és antic
  if (room.round !== round || room.state !== 'playing') return;

  const scorers = [...room.winners];
  for (const id of scorers) room.players.get(id).score++;

  const scores = scoreboard(room);
  const top = Math.max(...scores.map((s) => s.score));
  if (top >= CONFIG.target) {
    room.state = 'over';
    const winners = scores.filter((s) => s.score === top).map((s) => s.id); // empat possible
    broadcast(room, 'gameOver', { scores, winners });
  } else {
    startRound(room, scorers);
  }
}

// ───────────────────────────────────────────────────────────
// HTTP
// ───────────────────────────────────────────────────────────

/** Respon amb JSON i un codi d'estat. */
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

/** Llegeix el cos de la petició com a JSON. Si és invàlid, retorna {}. */
const readBody = (req) => new Promise((ok) => {
  let s = '';
  req.on('data', (c) => (s += c));
  req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } });
});

/** Arxius estàtics que serveix el servidor: ruta → [arxiu, tipus MIME]. */
const FILES = {
  '/': ['index.html', 'text/html'],
  '/styles.css': ['styles.css', 'text/css'],
  '/script.js': ['script.js', 'text/javascript'],
};

const server = http.createServer(async (req, res) => {
  // CORS: permet que el joc es carregui des d'un altre origen.
  // Els POST amb JSON provoquen una petició prèvia OPTIONS (preflight).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  // req.url només porta la ruta; new URL necessita una base per analitzar-la
  const url = new URL(req.url, 'http://localhost');

  // Arxius del joc
  if (req.method === 'GET' && FILES[url.pathname]) {
    const [file, type] = FILES[url.pathname];
    return fs.readFile(path.join(__dirname, file), (err, data) => {
      if (err) return json(res, 500, { error: `no s'ha pogut llegir ${file}` });
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      res.end(data);
    });
  }

  // /rooms/:code/:action → [root, code, action]; filter(Boolean) treu els trossos buits
  const [root, code, action] = url.pathname.split('/').filter(Boolean);
  if (root !== 'rooms') return json(res, 404, { error: 'no existeix' });

  // Crear sala
  if (!code && req.method === 'POST') {
    const newCode = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 caràcters
    rooms.set(newCode, {
      code: newCode,
      state: 'lobby',                 // lobby | playing | over
      players: new Map(),             // id → { id, name, score, res }
      round: 0,
      combo: [],
      winners: null,                  // Set d'ids que han acabat la ronda actual
      lastKey: '',
      rng: mulberry32(crypto.randomInt(2 ** 32)),
    });
    return json(res, 201, { code: newCode });
  }

  const room = rooms.get(code);
  if (!room) return json(res, 404, { error: 'sala no trobada' });

  // Entrar a la sala
  if (action === 'join' && req.method === 'POST') {
    if (room.state !== 'lobby') return json(res, 409, { error: 'partida ja començada' });
    const { name } = await readBody(req);
    const id = crypto.randomUUID(); // impossible d'endevinar: fa de credencial
    room.players.set(id, { id, name: String(name || 'Jugador').slice(0, 20), score: 0, res: null });
    broadcast(room, 'players', scoreboard(room));
    return json(res, 200, { playerId: id });
  }

  // Canal d'esdeveniments (SSE): la resposta es deixa oberta
  if (action === 'events' && req.method === 'GET') {
    const p = room.players.get(url.searchParams.get('player'));
    if (!p) return json(res, 404, { error: 'jugador desconegut' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', // indica al navegador que és un flux d'esdeveniments
      'Cache-Control': 'no-cache',         // evita que els intermediaris el guardin
      Connection: 'keep-alive',
    });
    p.res = res;
    send(res, 'players', scoreboard(room));
    // res 'close' s'emet quan el client es desconnecta
    res.on('close', () => { p.res = null; });
    return;
  }

  // Començar la partida
  if (action === 'start' && req.method === 'POST') {
    if (room.state !== 'lobby') return json(res, 409, { error: 'ja començada' });
    room.state = 'playing';
    broadcast(room, 'start', { startsIn: CONFIG.startDelayMs });
    setTimeout(() => startRound(room), CONFIG.startDelayMs);
    return json(res, 200, { ok: true });
  }

  // Un jugador diu que ha completat la combinació
  if (action === 'complete' && req.method === 'POST') {
    const { player, round, presses } = await readBody(req);
    // Des d'aquí fins al return no hi ha cap await: Node executa tot aquest bloc
    // sense interrupcions, així que dues peticions no es poden barrejar.
    if (!room.players.has(player)) return json(res, 404, { error: 'jugador desconegut' });
    if (room.state !== 'playing' || round !== room.round) return json(res, 409, { error: 'tard' });
    if (!Array.isArray(presses) || presses.join() !== room.combo.join())
      return json(res, 400, { error: 'seqüència incorrecta' });

    // El primer que arriba obre la finestra de gràcia
    if (!room.winners) {
      room.winners = new Set();
      const r = room.round;
      setTimeout(() => closeRound(room, r), CONFIG.graceMs);
    }
    room.winners.add(player); // el Set ignora els duplicats
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'no existeix' });
});

// Cada 15 s: envia un comentari SSE (":") perquè no es tanquin les connexions
// per inactivitat, i esborra les sales on tothom s'ha desconnectat.
setInterval(() => {
  for (const [code, room] of rooms) {
    const open = [...room.players.values()].filter((p) => p.res);
    open.forEach((p) => p.res.write(':\n\n'));
    if (room.players.size && !open.length) rooms.delete(code);
  }
}, 15000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Servidor al port', PORT));
