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
 *   POST /rooms                          crea una sala             → { code, mode }
 *   POST /rooms/:code/join    { name }                             → { playerId, mode }
 *   GET  /rooms/:code/events?player=ID   canal SSE (servidor → jugador)
 *   POST /rooms/:code/start              comença la partida
 *   POST /rooms/:code/complete  { player, round, presses }         combinació acabada
 *
 * Esdeveniments SSE: players | start | round | combo | eliminated | gameOver
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TARGET = 5;      // punts per guanyar
const BR_TARGET = 3;   // punts per superar una fase del Battle Royale
const MIN_LEN = 4;     // mida mínima d'una combinació
const MAX_LEN = 12;    // mida màxima
const GRACE_MS = 120;  // finestra de gràcia: qui arriba dins d'aquest temps també puntua
const START_MS = 3000; // compte enrere abans de la primera ronda
const DIRS = ['up', 'down', 'left', 'right'];
const MAX_PLAYERS = 10; // màxim de jugadors per sala
const MAX_ROOMS = 100;  // màxim de sales simultànies per procés
const ROOM_TTL_MS = 5 * 60 * 1000; // caducitat de sales i jugadors desconnectats

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
  room.lastScorers = scorers;
  broadcast(room, 'round', { round: room.round, combo: room.combo, scores: scoreboard(room), scorers });
}

/**
 * Comença una fase del Battle Royale.
 * Cada jugador rep una combinació pròpia.
 */
function startBattleRoyalePhase(room) {
  room.round++;
  room.brFinished = new Set();
  room.brLastFinisher = null;

  for (const player of room.players.values()) {
    player.score = 0;
    player.combo = newCombo();
  }

  broadcast(room, 'round', {
    round: room.round,
    scores: scoreboard(room),
    scorers: []
  });

  for (const player of room.players.values()) {
    if (player.res) {
      send(player.res, 'combo', {
        round: room.round,
        combo: player.combo,
        score: player.score
      });
    }
  }
}

/**
 * Gestiona que un jugador hagi arribat als BR_TARGET punts.
 * Els jugadors que arriben esperen mentre els altres continuen jugant.
 */
function completeBattleRoyalePhase(room, playerId) {
  room.brFinished.add(playerId);
  room.brLastFinisher = playerId;

  const remaining = [...room.players.values()]
    .filter((player) => !room.brFinished.has(player.id));

  if (remaining.length > 1) return;

  // Si queda un jugador sense acabar, aquest és l'últim i queda eliminat.
  // Si tots han acabat, s'elimina l'últim que ha arribat.
  const eliminated = remaining.length === 1
    ? remaining[0]
    : room.players.get(room.brLastFinisher);

  if (!eliminated) return;

  const eliminatedRes = eliminated.res;
  room.players.delete(eliminated.id);

  const scores = scoreboard(room);

  // Només queda un jugador: tenim guanyador.
  if (room.players.size === 1) {
    room.state = 'over';

    if (eliminatedRes) {
      send(eliminatedRes, 'eliminated', {
        eliminated: eliminated.id,
        scores
      });
      eliminatedRes.end();
    }

    const winner = [...room.players.values()][0];

    broadcast(room, 'gameOver', {
      scores,
      winners: [winner.id]
    });

    return;
  }

  // Avisem tant els supervivents com el jugador eliminat.
  if (eliminatedRes) {
    send(eliminatedRes, 'eliminated', {
      eliminated: eliminated.id,
      scores
    });
    eliminatedRes.end();
  }

  broadcast(room, 'eliminated', {
    eliminated: eliminated.id,
    scores
  });

  startBattleRoyalePhase(room);
}

/** Acaba la finestra de gràcia: puntua els qui han arribat i decideix si hi ha guanyador. */
function closeRound(room, round) {
  if (rooms.get(room.code) !== room || room.state !== 'playing' || room.round !== round || !room.winners)
    return; // sala esborrada, partida acabada o temporitzador d'una ronda antiga

  const scorers = [...room.winners];
  for (const id of scorers) {
    const player = room.players.get(id);
    if (player) player.score++;
  }

  const scores = scoreboard(room);
  const top = Math.max(...scores.map((s) => s.score));
  if (top >= TARGET) {
    room.state = 'over';
    broadcast(room, 'gameOver', { scores, winners: scores.filter((s) => s.score === top).map((s) => s.id) });
  } else {
    startRound(room, scorers);
  }
}

/** Elimina jugadors i sales inactius; conserva els jugadors desconnectats durant el període de reconexió. */
function pruneRooms(now = Date.now()) {
  for (const [code, room] of rooms) {
    let playersChanged = false;
    for (const [id, player] of room.players) {
      if (!player.res && player.disconnectedAt && now - player.disconnectedAt >= ROOM_TTL_MS) {
        room.players.delete(id);
        room.winners?.delete(id);
        room.brFinished?.delete(id);
        room.lastScorers = room.lastScorers.filter((scorer) => scorer !== id);
        playersChanged = true;
      }
    }
    if (playersChanged && room.players.size) broadcast(room, 'players', scoreboard(room));

    const connected = [...room.players.values()].some((player) => player.res && !player.res.destroyed);
    if (!connected && now - room.lastActivity >= ROOM_TTL_MS) rooms.delete(code);
  }
}

/** Estat actual d'una sala, enviat en obrir o reprendre un canal SSE. */
function sendRoomState(res, room, playerId) {
  send(res, 'players', scoreboard(room));
  if (room.state === 'lobby') return;

  if (room.state === 'playing' && room.round === 0) {
    send(res, 'start', { startsIn: Math.max(0, room.startAt - Date.now()) });
    return;
  }

  if (room.state === 'playing') {
    if (room.mode === 'battleRoyale') {
      const player = room.players.get(playerId);

      send(res, 'round', {
        round: room.round,
        scores: scoreboard(room),
        scorers: [],
        finished: room.brFinished.has(playerId)
      });

      if (player && !room.brFinished.has(playerId)) {
        send(res, 'combo', {
          round: room.round,
          combo: player.combo,
          score: player.score
        });
      }

      return;
    }

    send(res, 'round', {
      round: room.round,
      combo: room.combo,
      scores: scoreboard(room),
      scorers: room.lastScorers.filter((id) => room.players.has(id)),
    });
    return;
  }

  const scores = scoreboard(room);
  const top = Math.max(...scores.map((player) => player.score));
  send(res, 'gameOver', { scores, winners: scores.filter((player) => player.score === top).map((player) => player.id) });
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
    pruneRooms();
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'servidor ple, torna-ho a provar més tard' });

    const { mode } = await readBody(req);

    let newCode;
    do { newCode = Math.random().toString(36).slice(2, 8).toUpperCase(); } while (rooms.has(newCode));

    rooms.set(newCode, {
      code: newCode,
      mode: mode === 'battleRoyale' ? 'battleRoyale' : 'classic',
      state: 'lobby',
      players: new Map(),
      round: 0,
      combo: [],
      winners: null,
      lastScorers: [],
      brFinished: new Set(),
      brLastFinisher: null,
      startAt: 0,
      lastActivity: Date.now(),
    });

    return json(res, 201, {
      code: newCode,
      mode: rooms.get(newCode).mode
    });
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
    room.players.set(id, {
      id,
      name: String(name || 'Jugador').slice(0, 20),
      score: 0,
      combo: [],
      res: null,
      disconnectedAt: Date.now(),
    });
    room.lastActivity = Date.now();
    broadcast(room, 'players', scoreboard(room));
    return json(res, 200, {
      playerId: id,
      mode: room.mode
    });
  }

  // Sortir de la sala i alliberar la plaça del jugador.
  if (action === 'leave' && req.method === 'POST') {
    const { player: id } = await readBody(req);
    const player = room.players.get(id);
    if (!player) return json(res, 404, { error: 'jugador desconegut' });
    room.players.delete(id);
    room.winners?.delete(id);
    room.brFinished?.delete(id);
    room.lastScorers = room.lastScorers.filter((scorer) => scorer !== id);
    if (player.res) {
      const resToClose = player.res;
      player.res = null;
      resToClose.end();
    }
    room.lastActivity = Date.now();
    if (!room.players.size) {
      rooms.delete(code);
      return json(res, 200, { ok: true });
    }
    broadcast(room, 'players', scoreboard(room));
    return json(res, 200, { ok: true });
  }

  // Canal SSE: la resposta es deixa oberta i es guarda al jugador per escriure-hi més tard
  if (action === 'events' && req.method === 'GET') {
    const playerId = url.searchParams.get('player');
    const p = room.players.get(playerId);
    if (!p) return json(res, 404, { error: 'jugador desconegut' });
    p.res?.end(); // només es manté un canal obert per jugador
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    p.res = res;
    p.disconnectedAt = null;
    room.lastActivity = Date.now();
    res.flushHeaders();
    sendRoomState(res, room, playerId);
    res.on('close', () => {
      if (p.res === res) {
        p.res = null;
        p.disconnectedAt = Date.now();
        room.lastActivity = p.disconnectedAt;
      }
    }); // conserva el jugador durant el període de reconnexió
    return;
  }

  // Començar la partida
  if (action === 'start' && req.method === 'POST') {
    if (room.state !== 'lobby') return json(res, 409, { error: 'ja començada' });

    room.state = 'playing';
    room.lastActivity = Date.now();
    room.startAt = Date.now() + START_MS;
    broadcast(room, 'start', { startsIn: START_MS });

    setTimeout(() => {
      if (rooms.get(code) === room && room.state === 'playing') {
        if (room.mode === 'battleRoyale') startBattleRoyalePhase(room);
        else startRound(room);
      }
    }, START_MS);

    return json(res, 200, { ok: true });
  }

  // Un jugador diu que ha completat la combinació
  if (action === 'complete' && req.method === 'POST') {
    const { player, round, presses } = await readBody(req);
    // Sense cap await a partir d'aquí: Node executa el bloc sencer sense interrupcions
    if (!room.players.has(player)) return json(res, 404, { error: 'jugador desconegut' });
    if (room.state !== 'playing' || round !== room.round) return json(res, 409, { error: 'tard' });

    const currentPlayer = room.players.get(player);

    // Battle Royale: cada jugador té la seva pròpia combinació
    if (room.mode === 'battleRoyale') {
      if (room.brFinished.has(player))
        return json(res, 409, { error: 'ja acabat' });

      if (!Array.isArray(presses) || presses.join() !== currentPlayer.combo.join())
        return json(res, 400, { error: 'seqüència incorrecta' });

      room.lastActivity = Date.now();
      currentPlayer.score++;

      if (currentPlayer.score >= BR_TARGET) {
        completeBattleRoyalePhase(room, player);
        return json(res, 200, { ok: true, finished: true, score: BR_TARGET });
      }

      currentPlayer.combo = newCombo();

      return json(res, 200, {
        ok: true,
        finished: false,
        score: currentPlayer.score,
        combo: currentPlayer.combo
      });
    }

    // Mode clàssic
    if (!Array.isArray(presses) || presses.join() !== room.combo.join())
      return json(res, 400, { error: 'seqüència incorrecta' });
    room.lastActivity = Date.now();

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

// Cada 15 s: comentari SSE (":") per mantenir les connexions obertes i neteja d'inactivitat.
setInterval(() => {
  for (const [code, room] of rooms) {
    const open = [...room.players.values()].filter((p) => p.res);
    open.forEach((p) => p.res.write(':\n\n'));
  }
  pruneRooms();
}, 15000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Servidor al port', PORT));