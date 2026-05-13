const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'web')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ─── Card helpers ───────────────────────────────────────────────
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const VALUES = { A: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 0 };
const POWER_CARDS = { 6: 'peek_own', 7: 'peek_own', 8: 'peek_opponent', 9: 'peek_opponent', 10: 'blind_swap', J: 'blind_swap' };

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s, value: VALUES[r] });
  return d;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

// ─── Games store ────────────────────────────────────────────────
const games = {};

function createGame(id) {
  return {
    id,
    players: [],
    deck: [],
    discardPile: [],
    currentPlayerIndex: 0,
    phase: 'lobby',       // lobby | peek | playing | cabo_round | game_over
    roundNumber: 0,
    drawnCard: null,
    drawnFrom: null,
    caboCaller: null,
    turnsAfterCabo: 0,
    peeksDone: 0,
    actionPending: null,  // { type, playerId } for multi-step actions
  };
}

function getPlayer(game, socketId) {
  return game.players.find(p => p.id === socketId);
}
function getPlayerIndex(game, socketId) {
  return game.players.findIndex(p => p.id === socketId);
}

function cardLabel(c) { return c ? `${c.rank}${c.suit}` : '??'; }

function topDiscard(game) {
  return game.discardPile.length > 0 ? game.discardPile[game.discardPile.length - 1] : null;
}

// Build the state object that each player receives (hiding secret info)
function stateForPlayer(game, socketId) {
  const pIdx = getPlayerIndex(game, socketId);
  const me = game.players[pIdx];

  const players = game.players.map((p, i) => ({
    name: p.name,
    id: p.id,
    cardCount: p.cards.length,
    isCurrentTurn: i === game.currentPlayerIndex,
    isCaboCaller: game.caboCaller === i,
    // only reveal cards in game_over
    cards: game.phase === 'game_over'
      ? p.cards.map(c => ({ rank: c.rank, suit: c.suit, value: c.value, faceUp: true }))
      : p.cards.map((c, ci) => ({ faceUp: false, position: ci })),
  }));

  const isMyTurn = pIdx === game.currentPlayerIndex;
  const drawnCard = (isMyTurn && game.drawnCard) ? { rank: game.drawnCard.rank, suit: game.drawnCard.suit, value: game.drawnCard.value } : null;

  return {
    gameId: game.id,
    phase: game.phase,
    myIndex: pIdx,
    players,
    topDiscard: topDiscard(game) ? { rank: topDiscard(game).rank, suit: topDiscard(game).suit, value: topDiscard(game).value } : null,
    deckCount: game.deck.length,
    isMyTurn,
    drawnCard,
    drawnFrom: isMyTurn ? game.drawnFrom : null,
    roundNumber: game.roundNumber,
    caboCaller: game.caboCaller,
    actionPending: game.actionPending && game.actionPending.playerId === socketId ? game.actionPending.type : null,
    scores: game.phase === 'game_over' ? game.players.map(p => ({
      name: p.name,
      score: p.cards.reduce((s, c) => s + c.value, 0),
      isCaboCaller: game.caboCaller === game.players.indexOf(p),
    })) : null,
  };
}

function broadcastState(game) {
  for (const p of game.players) {
    io.to(p.id).emit('game_state', stateForPlayer(game, p.id));
  }
}

function broadcastMessage(game, msg, type = 'info') {
  io.to(game.id).emit('game_message', { text: msg, type });
}

function nextTurn(game) {
  game.drawnCard = null;
  game.drawnFrom = null;
  game.actionPending = null;

  if (game.phase === 'cabo_round') {
    game.turnsAfterCabo++;
    if (game.turnsAfterCabo >= game.players.length - 1) {
      endGame(game);
      return;
    }
  }

  game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
  // Skip cabo caller in cabo round
  if (game.phase === 'cabo_round' && game.currentPlayerIndex === game.caboCaller) {
    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
  }
  game.roundNumber++;
  broadcastState(game);
}

function endGame(game) {
  game.phase = 'game_over';
  // Calculate scores
  const scores = game.players.map((p, i) => ({
    index: i,
    name: p.name,
    rawScore: p.cards.reduce((s, c) => s + c.value, 0),
  }));

  const caboCallerScore = scores[game.caboCaller].rawScore;
  const otherScores = scores.filter((_, i) => i !== game.caboCaller).map(s => s.rawScore);
  const minOther = Math.min(...otherScores);

  // Cabo caller must have STRICTLY lowest
  if (caboCallerScore < minOther) {
    scores[game.caboCaller].finalScore = caboCallerScore;
  } else {
    scores[game.caboCaller].finalScore = 24;
  }
  for (let i = 0; i < scores.length; i++) {
    if (i !== game.caboCaller) scores[i].finalScore = scores[i].rawScore;
  }

  game.finalScores = scores;
  broadcastState(game);
  broadcastMessage(game, `Game over! ${scores.map(s => `${s.name}: ${s.finalScore}pts`).join(', ')}`, 'result');
}

// ─── Socket.IO ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on('create_game', ({ playerName }, cb) => {
    const gameId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const game = createGame(gameId);
    game.players.push({ id: socket.id, name: playerName, cards: [], peeked: [] });
    games[gameId] = game;
    socket.join(gameId);
    cb({ gameId });
    broadcastState(game);
    broadcastMessage(game, `${playerName} created the room.`);
  });

  socket.on('join_game', ({ gameId, playerName }, cb) => {
    const gid = gameId.toUpperCase();
    const game = games[gid];
    if (!game) return cb({ error: 'Room not found' });
    if (game.phase !== 'lobby') return cb({ error: 'Game already started' });
    if (game.players.length >= 6) return cb({ error: 'Room full (max 6)' });
    if (game.players.find(p => p.id === socket.id)) return cb({ error: 'Already in room' });

    game.players.push({ id: socket.id, name: playerName, cards: [], peeked: [] });
    socket.join(gid);
    cb({ gameId: gid });
    broadcastState(game);
    broadcastMessage(game, `${playerName} joined the room.`);
  });

  socket.on('start_game', () => {
    const game = findGameBySocket(socket.id);
    if (!game || game.phase !== 'lobby') return;
    if (game.players.length < 2) return socket.emit('game_message', { text: 'Need at least 2 players', type: 'error' });
    if (game.players[0].id !== socket.id) return socket.emit('game_message', { text: 'Only host can start', type: 'error' });

    // Deal
    game.deck = shuffle(makeDeck());
    for (const p of game.players) {
      p.cards = [game.deck.pop(), game.deck.pop(), game.deck.pop(), game.deck.pop()];
      p.peeked = [false, false, false, false];
    }
    // Flip one card to start discard
    game.discardPile.push(game.deck.pop());
    game.phase = 'peek';
    game.peeksDone = 0;
    game.currentPlayerIndex = 0;
    game.roundNumber = 0;

    broadcastState(game);
    broadcastMessage(game, 'Game started! Peek at your bottom 2 cards (positions 3 & 4). Click them to peek.', 'info');
  });

  // During peek phase, player peeks at bottom cards (indices 2 and 3)
  socket.on('peek_card', ({ cardIndex }) => {
    const game = findGameBySocket(socket.id);
    if (!game || game.phase !== 'peek') return;
    const player = getPlayer(game, socket.id);
    if (!player) return;

    if (cardIndex !== 2 && cardIndex !== 3) return socket.emit('game_message', { text: 'You can only peek at your bottom 2 cards!', type: 'error' });
    if (player.peeked[cardIndex]) return;

    player.peeked[cardIndex] = true;
    const card = player.cards[cardIndex];
    socket.emit('peek_result', { cardIndex, card: { rank: card.rank, suit: card.suit, value: card.value } });

    // Check if all players done peeking
    const allPeeked = game.players.every(p => p.peeked[2] && p.peeked[3]);
    if (allPeeked) {
      game.phase = 'playing';
      game.roundNumber = 1;
      broadcastState(game);
      broadcastMessage(game, `All players peeked! ${game.players[0].name}'s turn. Draw a card!`, 'info');
    }
  });

  // Draw a card from deck or discard
  socket.on('draw_card', ({ from }) => {
    const game = findGameBySocket(socket.id);
    if (!game || (game.phase !== 'playing' && game.phase !== 'cabo_round')) return;
    const pIdx = getPlayerIndex(game, socket.id);
    if (pIdx !== game.currentPlayerIndex) return socket.emit('game_message', { text: 'Not your turn!', type: 'error' });
    if (game.drawnCard) return socket.emit('game_message', { text: 'Already drew a card!', type: 'error' });

    if (from === 'deck') {
      if (game.deck.length === 0) {
        // Reshuffle discard into deck, keep top card
        const top = game.discardPile.pop();
        game.deck = shuffle(game.discardPile);
        game.discardPile = top ? [top] : [];
      }
      game.drawnCard = game.deck.pop();
      game.drawnFrom = 'deck';
    } else if (from === 'discard') {
      if (game.discardPile.length === 0) return socket.emit('game_message', { text: 'Discard pile empty!', type: 'error' });
      game.drawnCard = game.discardPile.pop();
      game.drawnFrom = 'discard';
    }

    broadcastState(game);
    const player = game.players[pIdx];
    if (game.drawnFrom === 'deck') {
      const power = POWER_CARDS[game.drawnCard.rank];
      let msg = `${player.name} drew from deck.`;
      if (power) msg += ` Card has a power! (${game.drawnCard.rank})`;
      broadcastMessage(game, msg);
    } else {
      broadcastMessage(game, `${player.name} drew ${cardLabel(game.drawnCard)} from discard. Must swap.`);
    }
  });

  // Swap drawn card with one of your cards
  socket.on('swap_card', ({ cardIndex }) => {
    const game = findGameBySocket(socket.id);
    if (!game || !game.drawnCard) return;
    const pIdx = getPlayerIndex(game, socket.id);
    if (pIdx !== game.currentPlayerIndex) return;
    const player = game.players[pIdx];

    if (cardIndex < 0 || cardIndex >= player.cards.length) return;

    const old = player.cards[cardIndex];
    player.cards[cardIndex] = game.drawnCard;
    player.peeked[cardIndex] = false; // new card is face down, unknown
    game.discardPile.push(old);

    broadcastMessage(game, `${player.name} swapped card at position ${cardIndex + 1}. ${cardLabel(old)} discarded.`);
    nextTurn(game);
  });

  // Discard drawn card (optionally use power)
  socket.on('discard_drawn', () => {
    const game = findGameBySocket(socket.id);
    if (!game || !game.drawnCard) return;
    const pIdx = getPlayerIndex(game, socket.id);
    if (pIdx !== game.currentPlayerIndex) return;

    if (game.drawnFrom === 'discard') {
      return socket.emit('game_message', { text: 'You drew from discard — you must swap!', type: 'error' });
    }

    const card = game.drawnCard;
    const power = POWER_CARDS[card.rank];
    game.discardPile.push(card);
    game.drawnCard = null;

    if (power) {
      // Set pending action
      game.actionPending = { type: power, playerId: socket.id };
      broadcastState(game);
      const player = game.players[pIdx];
      if (power === 'peek_own') {
        broadcastMessage(game, `${player.name} discarded ${cardLabel(card)} — peeking at own card!`);
        socket.emit('game_message', { text: 'Click one of YOUR cards to peek at it.', type: 'action' });
      } else if (power === 'peek_opponent') {
        broadcastMessage(game, `${player.name} discarded ${cardLabel(card)} — peeking at opponent card!`);
        socket.emit('game_message', { text: "Click one of an OPPONENT's cards to peek at it.", type: 'action' });
      } else if (power === 'blind_swap') {
        broadcastMessage(game, `${player.name} discarded ${cardLabel(card)} — blind swap!`);
        socket.emit('game_message', { text: 'Click 2 cards (any players) to blind swap them.', type: 'action' });
        game.actionPending.selections = [];
      }
    } else {
      const player = game.players[pIdx];
      broadcastMessage(game, `${player.name} discarded ${cardLabel(card)}.`);
      nextTurn(game);
    }
  });

  // Handle power actions (peek, blind swap)
  socket.on('power_action', ({ targetPlayerIndex, cardIndex }) => {
    const game = findGameBySocket(socket.id);
    if (!game || !game.actionPending || game.actionPending.playerId !== socket.id) return;

    const pIdx = getPlayerIndex(game, socket.id);
    const action = game.actionPending;

    if (action.type === 'peek_own') {
      if (targetPlayerIndex !== pIdx) return socket.emit('game_message', { text: 'Must peek at YOUR own card!', type: 'error' });
      const card = game.players[pIdx].cards[cardIndex];
      if (!card) return;
      game.players[pIdx].peeked[cardIndex] = true;
      socket.emit('peek_result', { cardIndex, card: { rank: card.rank, suit: card.suit, value: card.value }, targetPlayerIndex });
      broadcastMessage(game, `${game.players[pIdx].name} peeked at their card.`);
      nextTurn(game);
    } else if (action.type === 'peek_opponent') {
      if (targetPlayerIndex === pIdx) return socket.emit('game_message', { text: "Must peek at an OPPONENT's card!", type: 'error' });
      const target = game.players[targetPlayerIndex];
      if (!target) return;
      const card = target.cards[cardIndex];
      if (!card) return;
      socket.emit('peek_result', { cardIndex, card: { rank: card.rank, suit: card.suit, value: card.value }, targetPlayerIndex, targetName: target.name });
      broadcastMessage(game, `${game.players[pIdx].name} peeked at ${target.name}'s card.`);
      nextTurn(game);
    } else if (action.type === 'blind_swap') {
      action.selections.push({ playerIndex: targetPlayerIndex, cardIndex });
      if (action.selections.length === 1) {
        socket.emit('game_message', { text: 'Now click the second card to swap with.', type: 'action' });
        broadcastState(game);
      } else if (action.selections.length === 2) {
        const s1 = action.selections[0];
        const s2 = action.selections[1];
        const p1 = game.players[s1.playerIndex];
        const p2 = game.players[s2.playerIndex];
        const temp = p1.cards[s1.cardIndex];
        p1.cards[s1.cardIndex] = p2.cards[s2.cardIndex];
        p2.cards[s2.cardIndex] = temp;
        // Reset peek status for swapped cards
        p1.peeked[s1.cardIndex] = false;
        p2.peeked[s2.cardIndex] = false;
        broadcastMessage(game, `${game.players[pIdx].name} blind-swapped ${p1.name}'s pos ${s1.cardIndex + 1} with ${p2.name}'s pos ${s2.cardIndex + 1}!`);
        nextTurn(game);
      }
    }
  });

  // Snap/Slap: match card to top of discard pile
  socket.on('snap_own', ({ cardIndex }) => {
    const game = findGameBySocket(socket.id);
    if (!game || (game.phase !== 'playing' && game.phase !== 'cabo_round')) return;
    const pIdx = getPlayerIndex(game, socket.id);
    const player = game.players[pIdx];
    const top = topDiscard(game);
    if (!top) return;

    const card = player.cards[cardIndex];
    if (!card) return;

    if (card.value === top.value) {
      // Correct snap
      game.discardPile.push(card);
      player.cards.splice(cardIndex, 1);
      player.peeked.splice(cardIndex, 1);
      broadcastMessage(game, `🎯 ${player.name} snapped their ${cardLabel(card)} — matches discard!`, 'success');
      broadcastState(game);
    } else {
      // Penalty: draw a card from deck
      if (game.deck.length > 0) {
        const penalty = game.deck.pop();
        player.cards.push(penalty);
        player.peeked.push(false);
        broadcastMessage(game, `❌ ${player.name} tried to snap ${cardLabel(card)} but it doesn't match! Penalty card added.`, 'error');
        broadcastState(game);
      }
    }
  });

  // Snap opponent: throw opponent's card and give them one of yours
  socket.on('snap_opponent', ({ targetPlayerIndex, targetCardIndex, myCardIndex }) => {
    const game = findGameBySocket(socket.id);
    if (!game || (game.phase !== 'playing' && game.phase !== 'cabo_round')) return;
    const pIdx = getPlayerIndex(game, socket.id);
    if (targetPlayerIndex === pIdx) return;
    const player = game.players[pIdx];
    const target = game.players[targetPlayerIndex];
    const top = topDiscard(game);
    if (!top || !target) return;

    const targetCard = target.cards[targetCardIndex];
    if (!targetCard) return;

    if (targetCard.value === top.value) {
      // Correct — discard opponent's card, give them one of yours
      game.discardPile.push(targetCard);
      const myCard = player.cards[myCardIndex];
      target.cards[targetCardIndex] = myCard;
      target.peeked[targetCardIndex] = false;
      player.cards.splice(myCardIndex, 1);
      player.peeked.splice(myCardIndex, 1);
      broadcastMessage(game, `🎯 ${player.name} snapped ${target.name}'s ${cardLabel(targetCard)} and gave them a card!`, 'success');
      broadcastState(game);
    } else {
      // Penalty
      if (game.deck.length > 0) {
        const penalty = game.deck.pop();
        player.cards.push(penalty);
        player.peeked.push(false);
        broadcastMessage(game, `❌ ${player.name} tried to snap ${target.name}'s card but was wrong! Penalty card.`, 'error');
        broadcastState(game);
      }
    }
  });

  // Call Cabo
  socket.on('call_cabo', () => {
    const game = findGameBySocket(socket.id);
    if (!game || game.phase !== 'playing') return;
    const pIdx = getPlayerIndex(game, socket.id);
    if (pIdx !== game.currentPlayerIndex) return socket.emit('game_message', { text: 'Not your turn!', type: 'error' });
    if (game.drawnCard) return socket.emit('game_message', { text: 'Finish your draw action first!', type: 'error' });

    // Must have played at least 3 rounds
    const totalTurns = game.roundNumber;
    const turnsPerPlayer = Math.floor(totalTurns / game.players.length);
    if (turnsPerPlayer < 3) {
      return socket.emit('game_message', { text: `Must wait until round 3 to call Cabo! (currently round ${turnsPerPlayer + 1})`, type: 'error' });
    }

    game.caboCaller = pIdx;
    game.phase = 'cabo_round';
    game.turnsAfterCabo = 0;
    broadcastMessage(game, `🚨 ${game.players[pIdx].name} called CABO! Everyone else gets one more turn.`, 'cabo');

    // Move to next player
    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
    if (game.currentPlayerIndex === game.caboCaller) {
      game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
    }
    broadcastState(game);
  });

  // Restart
  socket.on('restart_game', () => {
    const game = findGameBySocket(socket.id);
    if (!game) return;
    game.phase = 'lobby';
    game.deck = [];
    game.discardPile = [];
    game.drawnCard = null;
    game.drawnFrom = null;
    game.caboCaller = null;
    game.turnsAfterCabo = 0;
    game.roundNumber = 0;
    game.actionPending = null;
    game.finalScores = null;
    for (const p of game.players) { p.cards = []; p.peeked = []; }
    broadcastState(game);
    broadcastMessage(game, 'Game reset! Host can start a new game.');
  });

  socket.on('disconnect', () => {
    const game = findGameBySocket(socket.id);
    if (!game) return;
    const player = getPlayer(game, socket.id);
    if (player) {
      broadcastMessage(game, `${player.name} disconnected.`);
      game.players = game.players.filter(p => p.id !== socket.id);
      if (game.players.length === 0) {
        delete games[game.id];
      } else {
        if (game.currentPlayerIndex >= game.players.length) game.currentPlayerIndex = 0;
        broadcastState(game);
      }
    }
  });
});

function findGameBySocket(socketId) {
  return Object.values(games).find(g => g.players.some(p => p.id === socketId));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Cabo server running on port ${PORT}`));