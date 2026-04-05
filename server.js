const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════════
//  56 (AMBATHIYAARU) — RULES-ACCURATE IMPLEMENTATION
//
//  Each player always gets exactly 8 cards:
//   4 players: J 9 A 10 × 2 packs = 32 cards
//   6 players: J 9 A 10 K Q × 2 packs = 48 cards  (standard)
//   8 players: J 9 A 10 K Q 8 7 × 2 packs = 64 cards
//
//  Trick rank: J > 9 > A > 10 > K > Q (> 8 > 7)
//  Points: J=3, 9=2, A=1, 10=1. Total in game = 56.
//
//  Bidding: counter-clockwise. Right of dealer goes first.
//  Supports: number+suit, suit+number, +n+suit, NT, NS, Pass, Double, Redouble
//
//  Scoring uses "tables" (each team starts with 12):
//   Bid 28-39: win+1 / lose-2
//   Bid 40-47: win+2 / lose-3
//   Bid 48-55: win+3 / lose-4
//   Bid 56:    win+4 / lose-5
//   Double: multiplier ×2, Redouble: ×3
//  Match ends when a team reaches 0 tables.
// ═══════════════════════════════════════════════════════════════════

const SUITS = ['♠', '♥', '♦', '♣'];
const CARD_POINTS = { 'J': 3, '9': 2, 'A': 1, '10': 1, 'K': 0, 'Q': 0, '8': 0, '7': 0 };
const TRICK_RANK  = { 'J': 8, '9': 7, 'A': 6, '10': 5, 'K': 4, 'Q': 3, '8': 2, '7': 1 };

const RANKS_BY_PLAYERS = {
  4: ['J', '9', 'A', '10'],
  6: ['J', '9', 'A', '10', 'K', 'Q'],
  8: ['J', '9', 'A', '10', 'K', 'Q', '8', '7'],
};

function buildDeck(numPlayers) {
  const ranks = RANKS_BY_PLAYERS[numPlayers] || RANKS_BY_PLAYERS[6];
  const deck = [];
  for (let p = 0; p < 2; p++)
    for (const suit of SUITS)
      for (const rank of ranks)
        deck.push({ suit, rank, id: `${rank}${suit}-${p}` });
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Tables: win amount for a bid
function tablesWin(bidAmt) {
  if (bidAmt <= 39) return 1;
  if (bidAmt <= 47) return 2;
  if (bidAmt <= 55) return 3;
  return 4;
}
// Tables: lose amount (always win+1)
function tablesLose(bidAmt) { return tablesWin(bidAmt) + 1; }

function applyMultiplier(base, doubleState) {
  if (doubleState === 2) return base * 3;
  if (doubleState === 1) return base * 2;
  return base;
}

function trickWinner(trick, trump) {
  const leadSuit = trick[0].card.suit;
  let best = trick[0];
  for (let i = 1; i < trick.length; i++) {
    const c = trick[i].card, b = best.card;
    const cT = trump && c.suit === trump;
    const bT = trump && b.suit === trump;
    if (cT && !bT)  { best = trick[i]; continue; }
    if (!cT && bT) continue;
    if (c.suit === b.suit) {
      if ((TRICK_RANK[c.rank] || 0) > (TRICK_RANK[b.rank] || 0)) best = trick[i];
    } else if (c.suit === leadSuit && !bT && b.suit !== leadSuit) {
      best = trick[i];
    }
  }
  return best.playerId;
}

// ─── Room State ──────────────────────────────────────────────────────────────

const rooms   = {};
const clients = {};

function createRoom(id) {
  return {
    id,
    players: [],
    state: 'lobby',
    dealerIdx: 0,
    currentBidderIdx: null,
    bids: [],
    currentBid: { amount: 0, playerId: null, trump: null },
    doubleState: 0,
    doubledBy: null,
    trump: null,
    currentTrick: [],
    trickLeader: null,
    currentPlayer: null,
    roundPoints: { A: 0, B: 0 },
    tables: { A: 12, B: 12 },
    roundHistory: [],
    passCount: 0,
  };
}

const broadcast = (room, msg) =>
  room.players.forEach(p => p.ws?.readyState === 1 && p.ws.send(JSON.stringify(msg)));

const sendTo = (ws, msg) =>
  ws?.readyState === 1 && ws.send(JSON.stringify(msg));

function sendState(room) {
  room.players.forEach(p => {
    if (!p.ws || p.ws.readyState !== 1) return;
    p.ws.send(JSON.stringify({
      type: 'room_state',
      roomId: room.id,
      state: room.state,
      players: room.players.map((pl, i) => ({
        id: pl.id, name: pl.name, team: pl.team,
        handCount: pl.hand?.length ?? 0,
        isDealer: i === room.dealerIdx,
      })),
      hand: p.hand || [],
      bids: room.bids,
      currentBid: room.currentBid,
      doubleState: room.doubleState,
      trump: room.trump,
      currentTrick: room.currentTrick,
      currentPlayer: room.currentPlayer,
      currentBidder: room.players[room.currentBidderIdx]?.id ?? null,
      roundPoints: room.roundPoints,
      tables: room.tables,
      roundHistory: room.roundHistory,
      dealerIdx: room.dealerIdx,
    }));
  });
}

function ccwNext(room, idx) {
  return (idx - 1 + room.players.length) % room.players.length;
}

function getTeam(room, pid) {
  return room.players.find(p => p.id === pid)?.team ?? null;
}

function assignTeams(room) {
  room.players.forEach((p, i) => { p.team = i % 2 === 0 ? 'A' : 'B'; });
}

function dealCards(room) {
  const deck = shuffle(buildDeck(room.players.length));
  room.players.forEach((p, i) => { p.hand = deck.slice(i * 8, (i + 1) * 8); });
}

// ─── Bid Parsing ─────────────────────────────────────────────────────────────

const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];
function extractSuit(text) {
  for (const s of SUIT_SYMBOLS) if (text.includes(s)) return s;
  const lo = text.toLowerCase();
  if (lo.includes('spade'))   return '♠';
  if (lo.includes('heart'))   return '♥';
  if (lo.includes('diamond') || lo.includes('dice')) return '♦';
  if (lo.includes('club'))    return '♣';
  return null;
}

function parseBid(text, currentHighest) {
  const t = text.trim();
  const lo = t.toLowerCase();

  if (lo === 'pass')     return { type: 'pass' };
  if (lo === 'double')   return { type: 'double' };
  if (lo === 'redouble') return { type: 'redouble' };

  const isNT = /nt|no.?trump/i.test(t);
  const isNS = /noes|ns\b/i.test(t);
  const isPass = /pass/i.test(t);
  const nums = (t.match(/\d+/g) || []).map(Number);
  const suit = extractSuit(t);
  const isPlus = t.startsWith('+');

  if (isPlus) {
    const inc = nums[0] || 1;
    const newVal = currentHighest + inc;
    if (isNT || isNS) return { type: 'plus_nt', numericValue: newVal, trump: null };
    if (suit) return { type: 'plus_suit', numericValue: newVal, trump: suit };
    return null;
  }

  if (isPass && nums.length > 0) return { type: 'pass_bid', numericValue: nums[0], trump: null };
  if (isNT && nums.length > 0)   return { type: 'nt', numericValue: nums[0], trump: null };
  if (isNS && nums.length > 0)   return { type: 'ns', numericValue: nums[0], trump: null };

  if (suit && nums.length > 0) {
    const suitFirst = t.indexOf(suit) < t.indexOf(String(nums[0]));
    return { type: suitFirst ? 'reverse' : 'normal', numericValue: nums[0], trump: suit };
  }
  if (suit && t.includes('+')) {
    return { type: 'suit_plus', numericValue: currentHighest + (nums[0] || 1), trump: suit };
  }
  if (nums.length > 0) return { type: 'nt', numericValue: nums[0], trump: null };
  return null;
}

// ─── Game Flow ───────────────────────────────────────────────────────────────

function startBidding(room) {
  room.state = 'bidding';
  room.bids = [];
  room.currentBid = { amount: 0, playerId: null, trump: null };
  room.doubleState = 0;
  room.doubledBy = null;
  room.trump = null;
  room.roundPoints = { A: 0, B: 0 };
  room.currentTrick = [];
  room.passCount = 0;
  dealCards(room);
  room.currentBidderIdx = ccwNext(room, room.dealerIdx);
  broadcast(room, { type: 'log', msg: `🃏 Cards dealt! ${room.players[room.currentBidderIdx].name} bids first.` });
  sendState(room);
}

function handleBid(room, playerId, bidText) {
  if (room.state !== 'bidding') return;
  const bidderIdx = room.players.findIndex(p => p.id === playerId);
  if (bidderIdx !== room.currentBidderIdx) {
    sendTo(room.players[bidderIdx]?.ws, { type: 'error', msg: "Not your turn to bid." });
    return;
  }
  const player = room.players[bidderIdx];
  const parsed = parseBid(bidText, room.currentBid.amount);
  if (!parsed) {
    sendTo(player.ws, { type: 'error', msg: "Invalid bid. Try: 28♥  ♥28  +2♥  32NT  33NS  Pass  Double" });
    return;
  }

  const bidTeam = player.team;

  if (parsed.type === 'double') {
    if (room.doubleState !== 0) { sendTo(player.ws, { type: 'error', msg: "Already doubled." }); return; }
    if (!room.currentBid.playerId) { sendTo(player.ws, { type: 'error', msg: "Nothing to double." }); return; }
    if (getTeam(room, room.currentBid.playerId) === bidTeam) { sendTo(player.ws, { type: 'error', msg: "Can't double your own team." }); return; }
    room.doubleState = 1; room.doubledBy = playerId;
    room.bids.push({ playerId, name: player.name, text: 'DOUBLE', type: 'double', numericValue: room.currentBid.amount, trump: room.currentBid.trump });
    broadcast(room, { type: 'log', msg: `⚡ ${player.name} DOUBLED!` });
    room.passCount = 0;
    room.currentBidderIdx = ccwNext(room, bidderIdx);
    sendState(room); return;
  }

  if (parsed.type === 'redouble') {
    if (room.doubleState !== 1) { sendTo(player.ws, { type: 'error', msg: "No double to redouble." }); return; }
    if (getTeam(room, room.doubledBy) === bidTeam) { sendTo(player.ws, { type: 'error', msg: "Can't redouble your own team's double." }); return; }
    room.doubleState = 2;
    room.bids.push({ playerId, name: player.name, text: 'REDOUBLE', type: 'redouble', numericValue: room.currentBid.amount, trump: room.currentBid.trump });
    broadcast(room, { type: 'log', msg: `💥 ${player.name} REDOUBLED! Bidding ends.` });
    startPlay(room); return;
  }

  if (parsed.type === 'pass') {
    room.bids.push({ playerId, name: player.name, text: 'Pass', type: 'pass', numericValue: room.currentBid.amount, trump: room.currentBid.trump });
    broadcast(room, { type: 'log', msg: `${player.name} passed.` });
    room.passCount++;
    const needed = room.currentBid.playerId ? room.players.length - 1 : room.players.length;
    if (room.passCount >= needed) {
      if (!room.currentBid.playerId) {
        const firstBidder = room.players[ccwNext(room, room.dealerIdx)];
        room.currentBid = { amount: 28, playerId: firstBidder.id, trump: null };
        broadcast(room, { type: 'log', msg: `All passed. No-Trump game, scored as bid 28 by opponents.` });
      }
      startPlay(room);
    } else {
      room.currentBidderIdx = ccwNext(room, bidderIdx);
      sendState(room);
    }
    return;
  }

  // Real bid
  const val = parsed.numericValue;
  if (!val || val < 28 || val > 56) { sendTo(player.ws, { type: 'error', msg: "Bid must be 28–56." }); return; }
  if (val <= room.currentBid.amount) { sendTo(player.ws, { type: 'error', msg: `Must beat current bid of ${room.currentBid.amount}.` }); return; }

  room.currentBid = { amount: val, playerId, trump: parsed.trump };
  room.doubleState = 0; room.doubledBy = null; room.passCount = 0;

  const typeHint = {
    normal: '— has J + cards in suit',
    reverse: '— suit strength, no J',
    plus_suit: '— singleton/extra in suit',
    suit_plus: '— partial suit strength',
    nt: '— no trump / general',
    plus_nt: '— no trump extra',
    ns: '— no cards in last bid suit',
    pass_bid: '— obligatory/no info',
  }[parsed.type] || '';

  const trumpLabel = parsed.trump || 'NT';
  room.bids.push({ playerId, name: player.name, text: bidText, type: parsed.type, numericValue: val, trump: parsed.trump });
  broadcast(room, { type: 'log', msg: `📢 ${player.name}: ${val}${trumpLabel} ${typeHint}` });

  if (val === 56) { broadcast(room, { type: 'log', msg: `Max bid of 56! Bidding ends.` }); startPlay(room); return; }
  room.currentBidderIdx = ccwNext(room, bidderIdx);
  sendState(room);
}

function startPlay(room) {
  room.state = 'playing';
  room.trump = room.currentBid.trump;
  room.currentTrick = [];
  const leaderIdx = ccwNext(room, room.dealerIdx);
  room.trickLeader = room.players[leaderIdx].id;
  room.currentPlayer = room.trickLeader;
  const bidder = room.players.find(p => p.id === room.currentBid.playerId);
  broadcast(room, { type: 'log', msg: `🎮 Play! Bid: ${room.currentBid.amount} by ${bidder?.name}. ${room.trump ? 'Trump: ' + room.trump : 'No Trump'}. ${room.players[leaderIdx].name} leads.` });
  sendState(room);
}

function handlePlayCard(room, playerId, cardId) {
  if (room.state !== 'playing') return;
  if (room.currentPlayer !== playerId) {
    sendTo(room.players.find(p => p.id === playerId)?.ws, { type: 'error', msg: "Not your turn." });
    return;
  }
  const player = room.players.find(p => p.id === playerId);
  const idx = player.hand.findIndex(c => c.id === cardId);
  if (idx === -1) { sendTo(player.ws, { type: 'error', msg: "Card not in hand." }); return; }

  if (room.currentTrick.length > 0) {
    const leadSuit = room.currentTrick[0].card.suit;
    const card = player.hand[idx];
    if (card.suit !== leadSuit && player.hand.some(c => c.suit === leadSuit)) {
      sendTo(player.ws, { type: 'error', msg: `Must follow suit: ${leadSuit}` }); return;
    }
  }

  const [card] = player.hand.splice(idx, 1);
  room.currentTrick.push({ playerId, name: player.name, card });
  broadcast(room, { type: 'log', msg: `${player.name} ▶ ${card.rank}${card.suit}` });

  if (room.currentTrick.length === room.players.length) {
    setTimeout(() => resolveTrick(room), 1400);
  } else {
    const pi = room.players.findIndex(p => p.id === playerId);
    room.currentPlayer = room.players[ccwNext(room, pi)].id;
    sendState(room);
  }
}

function resolveTrick(room) {
  const winnerId = trickWinner(room.currentTrick, room.trump);
  const winner = room.players.find(p => p.id === winnerId);
  const pts = room.currentTrick.reduce((s, t) => s + (CARD_POINTS[t.card.rank] || 0), 0);
  room.roundPoints[winner.team] += pts;
  broadcast(room, { type: 'log', msg: `✅ ${winner.name} wins trick! +${pts}pts → Team ${winner.team} has ${room.roundPoints[winner.team]}pts` });

  room.currentTrick = [];
  room.trickLeader = winnerId;
  room.currentPlayer = winnerId;

  const totalLeft = room.players.reduce((s, p) => s + p.hand.length, 0);
  const bidTeam = getTeam(room, room.currentBid.playerId);
  const remaining = 56 - room.roundPoints.A - room.roundPoints.B;
  const stillNeeded = room.currentBid.amount - room.roundPoints[bidTeam];

  if (totalLeft === 0 || stillNeeded > remaining) {
    setTimeout(() => endRound(room), 700);
  } else {
    sendState(room);
  }
}

function endRound(room) {
  room.state = 'roundEnd';
  const bidTeam = getTeam(room, room.currentBid.playerId);
  const oppTeam = bidTeam === 'A' ? 'B' : 'A';
  const bidAmt = room.currentBid.amount;
  const bidPts = room.roundPoints[bidTeam];
  const made = bidPts >= bidAmt;

  if (made) {
    const win = applyMultiplier(tablesWin(bidAmt), room.doubleState);
    room.tables[bidTeam] = Math.min(24, room.tables[bidTeam] + win);
    broadcast(room, { type: 'log', msg: `🏆 Team ${bidTeam} MADE ${bidAmt} (scored ${bidPts})! +${win} tables → A:${room.tables.A} B:${room.tables.B}` });
  } else {
    const lose = applyMultiplier(tablesLose(bidAmt), room.doubleState);
    const actual = Math.min(room.tables[bidTeam], lose);
    room.tables[bidTeam] -= actual;
    room.tables[oppTeam] = Math.min(24, room.tables[oppTeam] + actual);
    broadcast(room, { type: 'log', msg: `💀 Team ${bidTeam} FAILED ${bidAmt} (only ${bidPts})! -${actual} tables → A:${room.tables.A} B:${room.tables.B}` });
  }

  room.roundHistory.push({ bidAmt, bidTeam, made, scores: { ...room.roundPoints }, tables: { ...room.tables }, double: room.doubleState });

  if (room.tables.A <= 0 || room.tables.B <= 0) {
    const winner = room.tables.A > room.tables.B ? 'A' : 'B';
    room.state = 'matchEnd';
    broadcast(room, { type: 'log', msg: `🏆🏆 MATCH OVER! TEAM ${winner} WINS!` });
    sendState(room); return;
  }

  room.dealerIdx = ccwNext(room, room.dealerIdx);
  broadcast(room, { type: 'log', msg: `Host can start next round.` });
  sendState(room);
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  const playerId = uuidv4();
  clients[ws] = { playerId };
  sendTo(ws, { type: 'connected', playerId });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { roomId } = clients[ws];
    const room = roomId ? rooms[roomId] : null;

    if (msg.type === 'join_room') {
      const { roomId: rid, name } = msg;
      if (!rid || !name) return;
      let r = rooms[rid];
      if (!r) { r = createRoom(rid); rooms[rid] = r; }
      if (r.players.length >= 8) { sendTo(ws, { type: 'error', msg: 'Room full.' }); return; }
      if (r.state !== 'lobby') { sendTo(ws, { type: 'error', msg: 'Game in progress.' }); return; }
      clients[ws].roomId = rid;
      r.players.push({ id: playerId, name, ws, team: null, hand: [] });
      broadcast(r, { type: 'log', msg: `${name} joined! (${r.players.length} players)` });
      sendTo(ws, { type: 'joined', playerId, roomId: rid });
      sendState(r);
      return;
    }

    if (!room) return;

    switch (msg.type) {
      case 'start_game': {
        if (room.players[0]?.id !== playerId) { sendTo(ws, { type: 'error', msg: 'Only host can start.' }); return; }
        const n = room.players.length;
        if (![4, 6, 8].includes(n)) { sendTo(ws, { type: 'error', msg: `Need 4, 6, or 8 players. You have ${n}.` }); return; }
        assignTeams(room);
        room.tables = { A: 12, B: 12 };
        broadcast(room, { type: 'log', msg: `🎮 Match begins! Team A: ${room.players.filter(p=>p.team==='A').map(p=>p.name).join(', ')} | Team B: ${room.players.filter(p=>p.team==='B').map(p=>p.name).join(', ')}` });
        startBidding(room);
        break;
      }
      case 'next_round':
        if (room.players[0]?.id !== playerId || room.state !== 'roundEnd') return;
        startBidding(room);
        broadcast(room, { type: 'log', msg: '🔄 New round!' });
        break;
      case 'bid':
        handleBid(room, playerId, msg.text || '');
        break;
      case 'play_card':
        handlePlayCard(room, playerId, msg.cardId);
        break;
      case 'chat': {
        const player = room.players.find(p => p.id === playerId);
        broadcast(room, { type: 'chat', name: player?.name || '?', msg: msg.text });
        break;
      }
    }
  });

  ws.on('close', () => {
    const { roomId } = clients[ws] || {};
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      const i = room.players.findIndex(p => p.id === playerId);
      if (i !== -1) {
        const name = room.players[i].name;
        room.players.splice(i, 1);
        broadcast(room, { type: 'log', msg: `${name} disconnected.` });
        if (room.players.length === 0) delete rooms[roomId];
        else sendState(room);
      }
    }
    delete clients[ws];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`56 Game server → http://localhost:${PORT}`));
