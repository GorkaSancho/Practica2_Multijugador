// Servidor del Duelo de Flechas. Node puro, sin dependencias.
// Uso: node server.js   (puerto 3000 o process.env.PORT)
//
// Protocolo:
//   POST /rooms                    crea una sala            → { code }
//   POST /rooms/:code/join         { name }                 → { playerId }
//   GET  /rooms/:code/events?player=ID   canal SSE (servidor → jugador)
//   POST /rooms/:code/start        empieza la partida
//   POST /rooms/:code/complete     { player, round, presses } combinación terminada
//
// Eventos SSE: players | start | round | gameOver
const http = require('node:http');
const crypto = require('node:crypto');

const CONFIG = { target: 5, minLen: 4, maxLen: 12, graceMs: 120, startDelayMs: 3000 };
const DIRS = ['up', 'down', 'left', 'right'];
const rooms = new Map(); // código → sala

// ── Lógica de combinaciones (misma idea que en el cliente) ───
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function newCombo(room) {
  let next, key;
  do {
    const len = CONFIG.minLen + Math.floor(room.rng() * (CONFIG.maxLen - CONFIG.minLen + 1));
    next = Array.from({ length: len }, () => DIRS[Math.floor(room.rng() * DIRS.length)]);
    key = next.join(',');
  } while (key === room.lastKey);
  room.lastKey = key;
  return next;
}

// ── Envío de paquetes (SSE) ──────────────────────────────────
const scoreboard = (room) =>
  [...room.players.values()].map(({ id, name, score }) => ({ id, name, score }));

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(room, event, data) {
  for (const p of room.players.values()) if (p.res) send(p.res, event, data);
}

// ── Rondas ───────────────────────────────────────────────────
function startRound(room) {
  room.round++;
  room.combo = newCombo(room);
  room.winners = null;
  broadcast(room, 'round', { round: room.round, combo: room.combo, scores: scoreboard(room) });
}

// Se llama al acabar la ventana de gracia: reparte puntos y decide si hay ganador
function closeRound(room, round) {
  if (room.round !== round || room.state !== 'playing') return;
  for (const id of room.winners) room.players.get(id).score++;
  const scores = scoreboard(room);
  const top = Math.max(...scores.map((s) => s.score));
  if (top >= CONFIG.target) {
    room.state = 'over';
    const winners = scores.filter((s) => s.score === top).map((s) => s.id);
    broadcast(room, 'gameOver', { scores, winners });
  } else {
    startRound(room);
  }
}

// ── HTTP ─────────────────────────────────────────────────────
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};
const readBody = (req) => new Promise((ok) => {
  let s = '';
  req.on('data', (c) => (s += c));
  req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } });
});

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const url = new URL(req.url, 'http://localhost');
  const [root, code, action] = url.pathname.split('/').filter(Boolean);
  if (root !== 'rooms') return json(res, 404, { error: 'no existe' });

  // Crear sala
  if (!code && req.method === 'POST') {
    const newCode = crypto.randomBytes(3).toString('hex').toUpperCase();
    rooms.set(newCode, {
      code: newCode, state: 'lobby', players: new Map(),
      round: 0, combo: [], winners: null, lastKey: '',
      rng: mulberry32(crypto.randomInt(2 ** 32)),
    });
    return json(res, 201, { code: newCode });
  }

  const room = rooms.get(code);
  if (!room) return json(res, 404, { error: 'sala no encontrada' });

  // Entrar en la sala
  if (action === 'join' && req.method === 'POST') {
    if (room.state !== 'lobby') return json(res, 409, { error: 'partida ya empezada' });
    const { name } = await readBody(req);
    const id = crypto.randomUUID();
    room.players.set(id, { id, name: String(name || 'Jugador').slice(0, 20), score: 0, res: null });
    broadcast(room, 'players', scoreboard(room));
    return json(res, 200, { playerId: id });
  }

  // Canal de eventos (SSE)
  if (action === 'events' && req.method === 'GET') {
    const p = room.players.get(url.searchParams.get('player'));
    if (!p) return json(res, 404, { error: 'jugador desconocido' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    p.res = res;
    send(res, 'players', scoreboard(room));
    res.on('close', () => { p.res = null; });
    return;
  }

  // Empezar partida
  if (action === 'start' && req.method === 'POST') {
    if (room.state !== 'lobby') return json(res, 409, { error: 'ya empezada' });
    room.state = 'playing';
    broadcast(room, 'start', { startsIn: CONFIG.startDelayMs });
    setTimeout(() => startRound(room), CONFIG.startDelayMs);
    return json(res, 200, { ok: true });
  }

  // Un jugador dice que ha completado la combinación
  if (action === 'complete' && req.method === 'POST') {
    const { player, round, presses } = await readBody(req);
    if (!room.players.has(player)) return json(res, 404, { error: 'jugador desconocido' });
    if (room.state !== 'playing' || round !== room.round) return json(res, 409, { error: 'tarde' });
    if (!Array.isArray(presses) || presses.join() !== room.combo.join())
      return json(res, 400, { error: 'secuencia incorrecta' });

    if (!room.winners) { // el primero abre la ventana de gracia
      room.winners = new Set();
      const r = room.round;
      setTimeout(() => closeRound(room, r), CONFIG.graceMs);
    }
    room.winners.add(player);
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'no existe' });
});

// Mantiene vivas las conexiones SSE y limpia salas sin nadie conectado
setInterval(() => {
  for (const [code, room] of rooms) {
    const open = [...room.players.values()].filter((p) => p.res);
    open.forEach((p) => p.res.write(':\n\n'));
    if (room.players.size && !open.length) rooms.delete(code);
  }
}, 15000);

server.listen(process.env.PORT || 3000, () => console.log('Servidor en puerto', process.env.PORT || 3000));
