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
 *   GET  /rooms/:code/time?player=ID     hora del servidor per sincronitzar
 *   POST /rooms/:code/sync { player, offset, rtt } calibratge del rellotge
 *   GET  /rooms/:code/events?player=ID   canal SSE (servidor → jugador)
 *   POST /rooms/:code/start              comença la partida
 *   POST /rooms/:code/complete  { player, round, presses, finishedAt }
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
const MAX_COMPENSATION_MS = 120;
const BR_PHASE_TIMEOUT_MS = 30000;
const START_BUFFER_MS = 250;
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

/** Converteix una marca local a hora de servidor i limita la compensació al retard mesurat. */
function adjustedFinishAt(player, finishedAt, receivedAt) {
  const estimatedAt = finishedAt + player.clockOffset;
  const compensation = Math.min(MAX_COMPENSATION_MS, player.rtt / 2);
  return Math.min(receivedAt, Math.max(receivedAt - compensation, estimatedAt));
}

// ── Rondes ───────────────────────────────────────────────────

/** Comença una ronda: combinació nova per a tothom. scorers = qui ha puntuat a l'anterior. */
function startRound(room, scorers = [], startAt = room.startAt) {
  room.round++;
  room.combo = newCombo();
  room.winners = null; // ningú ha acabat encara aquesta ronda
  room.lastScorers = scorers;
  room.startAt = startAt;
  broadcast(room, 'round', {
    round: room.round,
    combo: room.combo,
    scores: scoreboard(room),
    scorers,
    startAt: room.startAt
  });
}

/**
 * Comença una fase del Battle Royale.
 * Tothom rep les mateixes tres combinacions i les completa en ordre.
 */
function startBattleRoyalePhase(room, startAt = Date.now() + Math.max(750, room.maxRtt + START_BUFFER_MS)) {
  clearTimeout(room.brPhaseTimer);
  room.round++;
  room.brFinished = new Set();
  room.brFinishTimes = new Map();
  room.brCombos = Array.from({ length: BR_TARGET }, newCombo);
  room.startAt = startAt;

  for (const player of room.players.values()) {
    player.score = 0;
  }

  broadcast(room, 'round', {
    round: room.round,
    scores: scoreboard(room),
    scorers: [],
    combos: room.brCombos,
    startAt: room.startAt
  });

  for (const player of room.players.values()) {
    if (player.res && !room.brFinished.has(player.id)) {
      send(player.res, 'combo', {
        round: room.round,
        combo: room.brCombos[player.score],
        score: player.score
      });
    }
  }

  const round = room.round;
  const phaseStartDelay = Math.max(0, room.startAt - Date.now());
  room.brPhaseTimer = setTimeout(
    () => timeoutBattleRoyalePhase(room, round),
    phaseStartDelay + BR_PHASE_TIMEOUT_MS
  );
}

/**
 * Resol una fase quan tots els jugadors que continuen a la sala han acabat.
 */
function resolveBattleRoyalePhase(room) {
  if (room.state !== 'playing' || room.mode !== 'battleRoyale') return;
  if (!room.players.size) {
    clearTimeout(room.brPhaseTimer);
    room.brPhaseTimer = null;
    rooms.delete(room.code);
    return;
  }
  if (room.players.size === 1) {
    clearTimeout(room.brPhaseTimer);
    room.brPhaseTimer = null;
    room.state = 'over';
    const winner = [...room.players.values()][0];
    broadcast(room, 'gameOver', {
      scores: scoreboard(room),
      winners: [winner.id]
    });
    return;
  }

  const unfinished = [...room.players.values()]
    .filter((player) => !room.brFinished.has(player.id));
  if (unfinished.length) return;

  const eliminated = room.players.get([...room.brFinishTimes.entries()]
    .sort((a, b) => b[1].finishedAt - a[1].finishedAt || b[1].receivedAt - a[1].receivedAt)[0]?.[0]);
  if (!eliminated) return;

  eliminateBattleRoyalePlayers(room, [eliminated.id]);
}

function timeoutBattleRoyalePhase(room, round) {
  if (rooms.get(room.code) !== room || room.state !== 'playing' || room.round !== round) return;
  const unfinished = [...room.players.values()]
    .filter((player) => !room.brFinished.has(player.id))
    .map((player) => player.id);
  if (unfinished.length) eliminateBattleRoyalePlayers(room, unfinished);
}

function eliminateBattleRoyalePlayers(room, playerIds) {
  clearTimeout(room.brPhaseTimer);
  room.brPhaseTimer = null;
  const eliminated = playerIds
    .map((id) => room.players.get(id))
    .filter(Boolean);
  if (!eliminated.length) return;

  const eliminatedIds = eliminated.map((player) => player.id);
  for (const player of eliminated) room.players.delete(player.id);

  const scores = scoreboard(room);

  for (const player of eliminated) {
    if (player.res) {
      send(player.res, 'eliminated', {
        eliminated: eliminatedIds,
        scores
      });
      player.res.end();
    }
  }

  // Només queda un jugador: tenim guanyador.
  if (room.players.size === 1) {
    room.state = 'over';
    const winner = [...room.players.values()][0];
    broadcast(room, 'gameOver', {
      scores,
      winners: [winner.id]
    });

    return;
  }

  if (!room.players.size) {
    room.state = 'over';
    return;
  }

  broadcast(room, 'eliminated', {
    eliminated: eliminatedIds,
    scores
  });

  startBattleRoyalePhase(room);
}

function completeBattleRoyalePhase(room, playerId, finishedAt, receivedAt) {
  room.brFinished.add(playerId);
  room.brFinishTimes.set(playerId, { finishedAt, receivedAt });
  resolveBattleRoyalePhase(room);
}

/** Acaba la finestra ajustada: puntua els qui han acabat dins de GRACE_MS. */
function closeRound(room, round) {
  if (rooms.get(room.code) !== room || room.state !== 'playing' || room.round !== round || !room.winners)
    return; // sala esborrada, partida acabada o temporitzador d'una ronda antiga

  const earliestFinish = Math.min(...[...room.winners.values()].map((finish) => finish.adjustedAt));
  const scorers = [...room.winners.entries()]
    .filter(([, finish]) => finish.adjustedAt <= earliestFinish + GRACE_MS)
    .map(([id]) => id);
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
    room.startAt = Date.now() + Math.max(750, room.maxRtt + START_BUFFER_MS);
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
        room.brFinishTimes?.delete(id);
        room.lastScorers = room.lastScorers.filter((scorer) => scorer !== id);
        playersChanged = true;
      }
    }
    if (playersChanged && room.players.size) broadcast(room, 'players', scoreboard(room));
    if (playersChanged) resolveBattleRoyalePhase(room);

    const connected = [...room.players.values()].some((player) => player.res && !player.res.destroyed);
    if (!connected && now - room.lastActivity >= ROOM_TTL_MS) rooms.delete(code);
  }
}

/** Estat actual d'una sala, enviat en obrir o reprendre un canal SSE. */
function sendRoomState(res, room, playerId) {
  send(res, 'players', scoreboard(room));
  if (room.state === 'lobby') return;

  if (room.state === 'playing' && room.round === 0) {
    send(res, 'start', { startAt: room.startAt });
    return;
  }

  if (room.state === 'playing') {
    if (room.mode === 'battleRoyale') {
      const player = room.players.get(playerId);

      send(res, 'round', {
        round: room.round,
        scores: scoreboard(room),
        scorers: [],
        finished: room.brFinished.has(playerId),
        combos: room.brCombos,
        startAt: room.startAt
      });

      if (player && !room.brFinished.has(playerId)) {
        send(res, 'combo', {
          round: room.round,
          combo: room.brCombos[player.score],
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
      startAt: room.startAt
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
      brFinishTimes: new Map(),
      brCombos: [],
      brPhaseTimer: null,
      maxRtt: 0,
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

  if (action === 'time' && req.method === 'GET') {
    const playerId = url.searchParams.get('player');
    if (!room.players.has(playerId)) return json(res, 404, { error: 'jugador desconegut' });
    return json(res, 200, { serverTime: Date.now() });
  }

  if (action === 'sync' && req.method === 'POST') {
    if (room.state !== 'lobby') return json(res, 409, { error: 'la partida ja ha començat' });
    const { player: playerId, offset, rtt } = await readBody(req);
    const player = room.players.get(playerId);
    if (!player) return json(res, 404, { error: 'jugador desconegut' });
    if (!Number.isFinite(offset) || !Number.isFinite(rtt) || rtt < 0 || rtt > 2000)
      return json(res, 400, { error: 'mesura de sincronització no vàlida' });

    player.clockOffset = offset;
    player.rtt = rtt;
    room.maxRtt = Math.max(...[...room.players.values()].map((p) => p.rtt));
    return json(res, 200, { ok: true });
  }

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
      clockOffset: null,
      rtt: 0,
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
    resolveBattleRoyalePhase(room);
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
    if (room.mode === 'battleRoyale' && room.players.size < 2)
      return json(res, 409, { error: 'calen almenys dos jugadors per al Battle Royale' });
    if ([...room.players.values()].some((player) => player.clockOffset === null))
      return json(res, 409, { error: 'espera que tots els jugadors acabin la sincronització' });

    room.state = 'playing';
    room.lastActivity = Date.now();
    room.startAt = Date.now() + Math.max(START_MS, room.maxRtt + START_BUFFER_MS);
    broadcast(room, 'start', { startAt: room.startAt });
    if (room.mode === 'battleRoyale') startBattleRoyalePhase(room, room.startAt);
    else startRound(room, [], room.startAt);

    return json(res, 200, { ok: true });
  }

  // Un jugador diu que ha completat la combinació
  if (action === 'complete' && req.method === 'POST') {
    const { player, round, presses, finishedAt } = await readBody(req);
    // Sense cap await a partir d'aquí: Node executa el bloc sencer sense interrupcions
    if (!room.players.has(player)) return json(res, 404, { error: 'jugador desconegut' });
    if (room.state !== 'playing' || round !== room.round) return json(res, 409, { error: 'tard' });
    if (Date.now() < room.startAt) return json(res, 409, { error: 'la ronda encara no ha començat' });

    const currentPlayer = room.players.get(player);

    // Battle Royale: tothom completa les mateixes tres combinacions en ordre.
    if (room.mode === 'battleRoyale') {
      if (room.brFinished.has(player))
        return json(res, 409, { error: 'ja acabat' });

      if (!Array.isArray(presses) || presses.join() !== room.brCombos[currentPlayer.score]?.join())
        return json(res, 400, { error: 'seqüència incorrecta' });

      const receivedAt = Date.now();
      let adjustedAt;
      if (currentPlayer.score + 1 >= BR_TARGET) {
        if (!Number.isFinite(finishedAt))
          return json(res, 400, { error: 'marca temporal no vàlida' });

        adjustedAt = adjustedFinishAt(currentPlayer, finishedAt, receivedAt);
      }

      room.lastActivity = Date.now();
      currentPlayer.score++;

      if (currentPlayer.score >= BR_TARGET) {
        completeBattleRoyalePhase(room, player, adjustedAt, receivedAt);
        return json(res, 200, { ok: true, finished: true, score: BR_TARGET });
      }

      return json(res, 200, {
        ok: true,
        finished: false,
        score: currentPlayer.score,
        combo: room.brCombos[currentPlayer.score]
      });
    }

    // Mode clàssic
    if (!Array.isArray(presses) || presses.join() !== room.combo.join())
      return json(res, 400, { error: 'seqüència incorrecta' });
    if (!Number.isFinite(finishedAt))
      return json(res, 400, { error: 'marca temporal no vàlida' });

    const receivedAt = Date.now();
    const adjustedAt = adjustedFinishAt(currentPlayer, finishedAt, receivedAt);
    room.lastActivity = receivedAt;

    if (!room.winners) { // el primer que arriba obre la finestra de gràcia
      room.winners = new Map();
      const r = room.round;
      setTimeout(() => closeRound(room, r), GRACE_MS + MAX_COMPENSATION_MS);
    }
    if (!room.winners.has(player)) room.winners.set(player, { adjustedAt, receivedAt });
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