const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ─── 56 Game Logic ───────────────────────────────────────────────────────────

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7'];

// Point values in 56:
// J=3, 9=2, A=1, 10=1, others=0
// Total = 4*(3+2+1+1) = 28 points per pack, 56 total for double pack
const CARD_POINTS = { 'J': 3, '9': 2, 'A': 1, '10': 1, 'K': 0, 'Q': 0, '8': 0, '7': 0 };

// Trick-taking rank (higher = wins): J > 9 > A > 10 > K > Q > 8 > 7
const TRICK_RANK = { 'J': 8, '9': 7, 'A': 6, '10': 5, 'K': 4, 'Q': 3, '8': 2, '7': 1 };

function buildDeck() {
  const deck = [];
  // Double pack = 56 cards
  for (let p = 0; p < 2; p++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({ suit, rank, id: `${rank}${suit}-${p}` });
      }
    }
  }
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

function cardPoints(card) {
  return CARD_POINTS[card.rank] || 0;
}

function trickRank(card) {
  return TRICK_RANK[card.rank] || 0;
}

// Determine winner of a trick
function trickWinner(trick, trump) {
  // trick = [{playerId, card}, ...]
  const leadSuit = trick[0].card.suit;
  let best = trick[0];
  for (let i = 1; i < trick.length; i++) {
    const c = trick[i].card;
    const b = best.card;
    const cTrump = c.suit === trump;
    const bTrump = b.suit === trump;
    if (cTrump && !bTrump) { best = trick[i]; continue; }
    if (!cTrump && bTrump) continue;
    // Same trump status
    if (c.suit === b.suit) {
      if (trickRank(c) > trickRank(b)) best = trick[i];
    } else {
      // c not lead suit and not trump = doesn't win
      if (c.suit === leadSuit && b.suit !== leadSuit && !bTrump) {
        best = trick[i];
      }
    }
  }
  return best.playerId;
}

// ─── Room Management ─────────────────────────────────────────────────────────

const rooms = {}; // roomId -> Room
const clients = {}; // ws -> { playerId, roomId, name }

function createRoom(roomId) {
  return {
    id: roomId,
    players: [], // { id, name, ws, team, hand, ready }
    state: 'lobby', // lobby | bidding | trump | playing | roundEnd | gameEnd
    deck: [],
    bids: [],
    currentBid: { amount: 0, player: null },
    trump: null,
    currentTrick: [],
    trickLeader: null,
    currentPlayer: null,
    scores: { A: 0, B: 0 }, // team scores (points in current round)
    totalScores: { A: 0, B: 0 }, // game total
    tricksWon: { A: 0, B: 0 },
    roundHistory: [],
    targetScore: 56,
    maxPlayers: 6,
  };
}

function broadcast(room, msg, excludeId = null) {
  room.players.forEach(p => {
    if (p.id !== excludeId && p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify(msg));
    }
  });
}

function broadcastAll(room, msg) {
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify(msg));
    }
  });
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function getRoomState(room, forPlayerId = null) {
  return {
    type: 'room_state',
    roomId: room.id,
    state: room.state,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      handCount: p.hand ? p.hand.length : 0,
      ready: p.ready,
    })),
    hand: forPlayerId ? (room.players.find(p => p.id === forPlayerId)?.hand || []) : [],
    bids: room.bids,
    currentBid: room.currentBid,
    trump: room.trump,
    currentTrick: room.currentTrick,
    currentPlayer: room.currentPlayer,
    scores: room.scores,
    totalScores: room.totalScores,
    tricksWon: room.tricksWon,
    trickLeader: room.trickLeader,
    roundHistory: room.roundHistory,
  };
}

function sendState(room) {
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === 1) {
      sendTo(p.ws, getRoomState(room, p.id));
    }
  });
}

function assignTeams(room) {
  // Alternate teams: 0,2,4 = Team A; 1,3,5 = Team B
  room.players.forEach((p, i) => {
    p.team = i % 2 === 0 ? 'A' : 'B';
  });
}

function dealCards(room) {
  room.deck = shuffle(buildDeck());
  const n = room.players.length;
  const cardsPerPlayer = Math.floor(56 / n);
  room.players.forEach((p, i) => {
    p.hand = room.deck.slice(i * cardsPerPlayer, (i + 1) * cardsPerPlayer);
  });
}

function startBidding(room) {
  room.state = 'bidding';
  room.bids = [];
  room.currentBid = { amount: 0, player: null };
  room.trump = null;
  room.scores = { A: 0, B: 0 };
  room.tricksWon = { A: 0, B: 0 };
  room.currentTrick = [];
  // Bidding starts from player index 0
  room.currentPlayer = room.players[0].id;
  dealCards(room);
  sendState(room);
  broadcastAll(room, { type: 'log', msg: `🃏 Cards dealt! Bidding starts. Minimum bid: 28. Player ${room.players[0].name} bids first.` });
}

function nextBidder(room) {
  const idx = room.players.findIndex(p => p.id === room.currentPlayer);
  const nextIdx = (idx + 1) % room.players.length;
  // Check if we've gone around and all passed except highest bidder
  return room.players[nextIdx].id;
}

function handleBid(room, playerId, amount) {
  if (room.state !== 'bidding') return;
  if (room.currentPlayer !== playerId) return;

  const player = room.players.find(p => p.id === playerId);
  const minBid = Math.max(28, room.currentBid.amount + 1);

  if (amount === 0) {
    // Pass
    room.bids.push({ player: playerId, name: player.name, amount: 0 });
    broadcastAll(room, { type: 'log', msg: `${player.name} passed.` });
  } else if (amount >= minBid && amount <= 56) {
    room.bids.push({ player: playerId, name: player.name, amount });
    room.currentBid = { amount, player: playerId };
    broadcastAll(room, { type: 'log', msg: `${player.name} bid ${amount}!` });
  } else {
    sendTo(player.ws, { type: 'error', msg: `Invalid bid. Min: ${minBid}` });
    return;
  }

  // Check if bidding is over: all others passed
  const activePlayers = room.players.map(p => p.id);
  const lastRound = room.bids.slice(-room.players.length);
  const allPassed = lastRound.filter(b => b.amount === 0).length >= room.players.length - 1 && room.currentBid.amount > 0;

  if (allPassed || room.currentBid.amount === 56) {
    // Bidding done
    const winner = room.players.find(p => p.id === room.currentBid.player);
    broadcastAll(room, { type: 'log', msg: `🏆 ${winner.name} won the bid with ${room.currentBid.amount}! Choose trump suit.` });
    room.state = 'trump';
    room.currentPlayer = room.currentBid.player;
    sendState(room);
  } else {
    room.currentPlayer = nextBidder(room);
    sendState(room);
  }
}

function handleTrump(room, playerId, suit) {
  if (room.state !== 'trump') return;
  if (room.currentPlayer !== playerId) return;
  if (!SUITS.includes(suit)) return;

  room.trump = suit;
  const player = room.players.find(p => p.id === playerId);
  broadcastAll(room, { type: 'log', msg: `${player.name} chose ${suit} as trump! Game begins.` });

  room.state = 'playing';
  room.trickLeader = playerId;
  room.currentPlayer = playerId;
  sendState(room);
}

function handlePlayCard(room, playerId, cardId) {
  if (room.state !== 'playing') return;
  if (room.currentPlayer !== playerId) return;

  const player = room.players.find(p => p.id === playerId);
  const cardIdx = player.hand.findIndex(c => c.id === cardId);
  if (cardIdx === -1) {
    sendTo(player.ws, { type: 'error', msg: 'Card not in hand!' });
    return;
  }

  // Follow suit validation
  if (room.currentTrick.length > 0) {
    const leadSuit = room.currentTrick[0].card.suit;
    const card = player.hand[cardIdx];
    const hasSuit = player.hand.some(c => c.suit === leadSuit);
    if (hasSuit && card.suit !== leadSuit) {
      sendTo(player.ws, { type: 'error', msg: `Must follow suit: ${leadSuit}` });
      return;
    }
  }

  const [card] = player.hand.splice(cardIdx, 1);
  room.currentTrick.push({ playerId, name: player.name, card });

  broadcastAll(room, { type: 'log', msg: `${player.name} played ${card.rank}${card.suit}` });

  if (room.currentTrick.length === room.players.length) {
    // Evaluate trick
    setTimeout(() => resolveTrick(room), 1200);
  } else {
    // Next player
    const idx = room.players.findIndex(p => p.id === playerId);
    room.currentPlayer = room.players[(idx + 1) % room.players.length].id;
    sendState(room);
  }
}

function resolveTrick(room) {
  const winnerId = trickWinner(room.currentTrick, room.trump);
  const winner = room.players.find(p => p.id === winnerId);
  const trickPoints = room.currentTrick.reduce((sum, t) => sum + cardPoints(t.card), 0);

  const team = winner.team;
  room.scores[team] += trickPoints;
  room.tricksWon[team]++;

  broadcastAll(room, { type: 'log', msg: `✅ ${winner.name} wins the trick! (+${trickPoints} pts for Team ${team})` });

  room.currentTrick = [];
  room.trickLeader = winnerId;
  room.currentPlayer = winnerId;

  // Check if round over
  const totalCards = room.players.reduce((s, p) => s + p.hand.length, 0);
  if (totalCards === 0) {
    setTimeout(() => endRound(room), 800);
  } else {
    sendState(room);
  }
}

function endRound(room) {
  room.state = 'roundEnd';
  const bidTeam = room.players.find(p => p.id === room.currentBid.player)?.team;
  const bidAmount = room.currentBid.amount;
  const bidTeamScore = room.scores[bidTeam];
  const otherTeam = bidTeam === 'A' ? 'B' : 'A';

  let msg = '';
  if (bidTeamScore >= bidAmount) {
    room.totalScores[bidTeam] += bidTeamScore;
    room.totalScores[otherTeam] += room.scores[otherTeam];
    msg = `🎉 Team ${bidTeam} made their bid of ${bidAmount}! (scored ${bidTeamScore}). Team ${otherTeam} scored ${room.scores[otherTeam]}.`;
  } else {
    // Bid team set — they lose bid amount, other team gets their points
    room.totalScores[bidTeam] -= bidAmount;
    room.totalScores[otherTeam] += room.scores[otherTeam];
    msg = `💀 Team ${bidTeam} was SET! Bid ${bidAmount}, only scored ${bidTeamScore}. -${bidAmount} pts!`;
  }

  room.roundHistory.push({
    bid: bidAmount,
    bidTeam,
    scores: { ...room.scores },
    totals: { ...room.totalScores },
  });

  broadcastAll(room, { type: 'log', msg });

  // Check game win (first to 56 total, or other conditions)
  const winner = Object.entries(room.totalScores).find(([t, s]) => s >= room.targetScore);
  if (winner) {
    room.state = 'gameEnd';
    broadcastAll(room, { type: 'log', msg: `🏆🏆 TEAM ${winner[0]} WINS THE GAME with ${winner[1]} points! 🏆🏆` });
    sendState(room);
  } else {
    sendState(room);
    broadcastAll(room, { type: 'log', msg: `Round over. Totals → Team A: ${room.totalScores.A} | Team B: ${room.totalScores.B}. Host can start next round.` });
  }
}

// ─── WebSocket Handler ────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  const playerId = uuidv4();
  clients[ws] = { playerId, roomId: null, name: null };

  sendTo(ws, { type: 'connected', playerId });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const client = clients[ws];

    switch (msg.type) {
      case 'join_room': {
        const { roomId, name } = msg;
        if (!roomId || !name) return;

        let room = rooms[roomId];
        if (!room) {
          room = createRoom(roomId);
          rooms[roomId] = room;
        }

        if (room.players.length >= room.maxPlayers) {
          sendTo(ws, { type: 'error', msg: 'Room is full (max 6 players).' });
          return;
        }

        if (room.state !== 'lobby') {
          sendTo(ws, { type: 'error', msg: 'Game already in progress.' });
          return;
        }

        client.roomId = roomId;
        client.name = name;
        client.playerId = playerId;

        room.players.push({ id: playerId, name, ws, team: null, hand: [], ready: false });

        broadcast(room, { type: 'log', msg: `${name} joined the room! (${room.players.length}/${room.maxPlayers})` }, playerId);
        sendTo(ws, { type: 'joined', playerId, roomId });
        sendState(room);
        break;
      }

      case 'start_game': {
        const room = rooms[client.roomId];
        if (!room) return;
        if (room.players[0].id !== playerId) {
          sendTo(ws, { type: 'error', msg: 'Only the host can start the game.' });
          return;
        }
        if (room.players.length < 2) {
          sendTo(ws, { type: 'error', msg: 'Need at least 2 players.' });
          return;
        }
        assignTeams(room);
        startBidding(room);
        broadcastAll(room, { type: 'log', msg: `🎮 Game started! Teams assigned. Team A: ${room.players.filter(p=>p.team==='A').map(p=>p.name).join(', ')} | Team B: ${room.players.filter(p=>p.team==='B').map(p=>p.name).join(', ')}` });
        break;
      }

      case 'next_round': {
        const room = rooms[client.roomId];
        if (!room) return;
        if (room.players[0].id !== playerId) return;
        if (room.state !== 'roundEnd') return;
        startBidding(room);
        broadcastAll(room, { type: 'log', msg: `🔄 New round started!` });
        break;
      }

      case 'bid': {
        const room = rooms[client.roomId];
        if (!room) return;
        handleBid(room, playerId, msg.amount);
        break;
      }

      case 'choose_trump': {
        const room = rooms[client.roomId];
        if (!room) return;
        handleTrump(room, playerId, msg.suit);
        break;
      }

      case 'play_card': {
        const room = rooms[client.roomId];
        if (!room) return;
        handlePlayCard(room, playerId, msg.cardId);
        break;
      }

      case 'chat': {
        const room = rooms[client.roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === playerId);
        broadcastAll(room, { type: 'chat', name: player?.name || 'Unknown', msg: msg.text });
        break;
      }
    }
  });

  ws.on('close', () => {
    const client = clients[ws];
    if (client?.roomId) {
      const room = rooms[client.roomId];
      if (room) {
        const idx = room.players.findIndex(p => p.id === client.playerId);
        if (idx !== -1) {
          const name = room.players[idx].name;
          room.players.splice(idx, 1);
          broadcastAll(room, { type: 'log', msg: `${name} left the room.` });
          if (room.players.length === 0) {
            delete rooms[client.roomId];
          } else {
            sendState(room);
          }
        }
      }
    }
    delete clients[ws];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`56 Game server running on http://localhost:${PORT}`);
});
