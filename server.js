/**
 * Servidor del Duel de Fletxes (Node, sense dependències). Ús: node server.js
 *
 * Idea: el servidor envia una combinació a tothom, cada jugador respon quan l'ha
 * completada, s'espera una finestra de gràcia, es puntua tothom qui hagi arribat
 * a temps, i es repeteix fins que algú arriba als punts objectiu.
 *
 * També serveix els arxius del joc (index.html, styles.css, script.js).
 *
 * Protocol:
 *   POST /rooms                          crea una sala             → { code }
 *   POST /rooms/:code/join    { name }                             → { playerId }
 *   GET  /rooms/:code/events?player=ID   canal SSE (servidor → jugador)
 *   POST /rooms/:code/start              comença la partida
 *   POST /rooms/:code/complete  { player, round, presses }         combinació acabada
 *
 * Esdeveniments SSE: players | start | round | gameOver
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TARGET = 5;      // punts per guanyar
const MIN_LEN = 4;     // mida mínima d'una combinació
const MAX_LEN = 12;    // mida màxima
const GRACE_MS = 120;  // finestra de gràcia: qui arriba dins d'aquest temps també puntua
const START_MS = 3000; // compte enrere abans de la primera ronda
const DIRS = ['up', 'down', 'left', 'right'];
const MAX_PLAYERS = 10; // màxim de jugadors per sala

/** Sales actives: codi → { state, players, round, combo, winners }. Viuen només a la memòria. */
const rooms = new Map();

// ── Combinacions ─────────────────────────────────────────────

/** Una combinació aleatòria de MIN_LEN a MAX_LEN direccions. */
function newCombo() {
  const len = MIN_LEN + Math.floor(Math.random() * (MAX_LEN - MIN_LEN + 1));
  return Array.from({ length: len }, () => DIRS[Math.floor(Math.random() * DIRS.length)]);
}

// ── Enviament de paquets (SSE) ───────────────────────────────

/** Marcador: només les dades públiques de cada jugador. */
const scoreboard = (room) =>
  [...room.players.values()].map(({ id, name, score }) => ({ id, name, score }));

/** Escriu un missatge SSE ("camp: valor" i una línia en blanc final) en una resposta oberta. */
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** Envia un esdeveniment a tots els jugadors connectats de la sala. */
function broadcast(room, event, data) {
  for (const p of room.players.values()) if (p.res) send(p.res, event, data);
}

// ── Rondes ───────────────────────────────────────────────────

/** Comença una ronda: combinació nova per a tothom. scorers = qui ha puntuat a l'anterior. */
function startRound(room, scorers = []) {
  room.round++;
  room.combo = newCombo();
  room.winners = null; // ningú ha acabat encara aquesta ronda
  broadcast(room, 'round', { round: room.round, combo: room.combo, scores: scoreboard(room), scorers });
}

/** Acaba la finestra de gràcia: puntua els qui han arribat i decideix si hi ha guanyador. */
function closeRound(room, round) {
  if (room.round !== round) return; // temporitzador d'una ronda antiga

  const scorers = [...room.winners];
  for (const id of scorers) room.players.get(id).score++;

  const scores = scoreboard(room);
  const top = Math.max(...scores.map((s) => s.score));
  if (top >= TARGET) {
    room.state = 'over';
    broadcast(room, 'gameOver', { scores, winners: scores.filter((s) => s.score === top).map((s) => s.id) });
  } else {
    startRound(room, scorers);
  }
}

// ── HTTP ─────────────────────────────────────────────────────

/** Respon amb JSON i un codi d'estat. */
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

/** Llegeix el cos de la petició com a JSON ({} si és invàlid). */
const readBody = (req) => new Promise((ok) => {
  let s = '';
  req.on('data', (c) => (s += c));
  req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } });
});

/** Arxius que serveix el servidor: ruta → [arxiu, tipus MIME]. */
const FILES = {
  '/': ['index.html', 'text/html'],
  '/styles.css': ['styles.css', 'text/css'],
  '/script.js': ['script.js', 'text/javascript'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); // new URL necessita una base per analitzar la ruta

  // Arxius del joc
  if (req.method === 'GET' && FILES[url.pathname]) {
    const [file, type] = FILES[url.pathname];
    return fs.readFile(path.join(import.meta.dirname, file), (err, data) => {
      if (err) return json(res, 500, { error: `no s'ha pogut llegir ${file}` });
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      res.end(data);
    });
  }

  // /rooms/:code/:action → [root, code, action]
  const [root, code, action] = url.pathname.split('/').filter(Boolean);
  if (root !== 'rooms') return json(res, 404, { error: 'no existeix' });

  // Crear sala
  if (!code && req.method === 'POST') {
    const newCode = Math.random().toString(36).slice(2, 8).toUpperCase();
    rooms.set(newCode, { state: 'lobby', players: new Map(), round: 0, combo: [], winners: null });
    return json(res, 201, { code: newCode });
  }

  const room = rooms.get(code);
  if (!room) return json(res, 404, { error: 'sala no trobada' });

  // Entrar a la sala
  if (action === 'join' && req.method === 'POST') {
    if (room.state !== 'lobby') return json(res, 409, { error: 'partida ja començada' });
    if (room.players.size >= MAX_PLAYERS) return json(res, 409, { error: 'sala plena (màxim 10 jugadors)' });
    const { name } = await readBody(req);
    // Torna a comprovar després de llegir el cos per evitar superar el límit amb entrades simultànies.
    if (room.state !== 'lobby') return json(res, 409, { error: 'partida ja començada' });
    if (room.players.size >= MAX_PLAYERS) return json(res, 409, { error: 'sala plena (màxim 10 jugadors)' });
    const id = randomUUID(); // impossible d'endevinar: fa de credencial
    room.players.set(id, { id, name: String(name || 'Jugador').slice(0, 20), score: 0, res: null });
    broadcast(room, 'players', scoreboard(room));
    return json(res, 200, { playerId: id });
  }

  // Canal SSE: la resposta es deixa oberta i es guarda al jugador per escriure-hi més tard
  if (action === 'events' && req.method === 'GET') {
    const p = room.players.get(url.searchParams.get('player'));
    if (!p) return json(res, 404, { error: 'jugador desconegut' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    p.res = res;
    send(res, 'players', scoreboard(room));
    res.on('close', () => { p.res = null; }); // el client s'ha desconnectat
    return;
  }

  // Començar la partida
  if (action === 'start' && req.method === 'POST') {
    if (room.state !== 'lobby') return json(res, 409, { error: 'ja començada' });
    room.state = 'playing';
    broadcast(room, 'start', { startsIn: START_MS });
    setTimeout(() => startRound(room), START_MS);
    return json(res, 200, { ok: true });
  }

  // Un jugador diu que ha completat la combinació
  if (action === 'complete' && req.method === 'POST') {
    const { player, round, presses } = await readBody(req);
    // Sense cap await a partir d'aquí: Node executa el bloc sencer sense interrupcions
    if (!room.players.has(player)) return json(res, 404, { error: 'jugador desconegut' });
    if (room.state !== 'playing' || round !== room.round) return json(res, 409, { error: 'tard' });
    if (!Array.isArray(presses) || presses.join() !== room.combo.join())
      return json(res, 400, { error: 'seqüència incorrecta' });

    if (!room.winners) { // el primer que arriba obre la finestra de gràcia
      room.winners = new Set();
      const r = room.round;
      setTimeout(() => closeRound(room, r), GRACE_MS);
    }
    room.winners.add(player);
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'no existeix' });
});

// Cada 15 s: comentari SSE (":") perquè les connexions no es tanquin per inactivitat,
// i esborra les sales on tothom s'ha desconnectat.
setInterval(() => {
  for (const [code, room] of rooms) {
    const open = [...room.players.values()].filter((p) => p.res);
    open.forEach((p) => p.res.write(':\n\n'));
    if (room.players.size && !open.length) rooms.delete(code);
  }
}, 15000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Servidor al port', PORT));