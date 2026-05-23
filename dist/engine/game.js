"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTable = createTable;
exports.canStart = canStart;
exports.startHand = startHand;
exports.applyAction = applyAction;
exports.advanceStreet = advanceStreet;
exports.addPlayer = addPlayer;
exports.removePlayer = removePlayer;
exports.maskForPlayer = maskForPlayer;
const deck_1 = require("./deck");
const handEval_1 = require("./handEval");
function createTable(tableId, sb = 10, bb = 20) {
    return {
        tableId, players: [], deck: [], board: [],
        street: 'waiting', pot: 0, sidePots: [],
        currentBet: 0, minRaise: bb,
        dealerIdx: 0, actionIdx: 0,
        smallBlind: sb, bigBlind: bb,
        lastActionTime: Date.now(), winners: [],
    };
}
function canStart(state) {
    return state.players.filter(p => p.connected && p.chips > 0).length >= 2;
}
function startHand(state) {
    const s = deepClone(state);
    const activePlayers = s.players.filter(p => p.connected && p.chips > 0);
    if (activePlayers.length < 2)
        return s;
    // Reset hand state
    s.deck = (0, deck_1.shuffle)((0, deck_1.makeDeck)());
    s.board = [];
    s.pot = 0;
    s.sidePots = [];
    s.currentBet = s.bigBlind;
    s.minRaise = s.bigBlind;
    s.winners = [];
    s.street = 'preflop';
    s.lastActionTime = Date.now();
    for (const p of s.players) {
        p.holeCards = [];
        p.bet = 0;
        p.totalBet = 0;
        p.folded = p.chips === 0;
        p.allIn = false;
        p.hasActed = false;
    }
    // Move dealer button (skip broke/disconnected)
    s.dealerIdx = nextActiveIdx(s, s.dealerIdx);
    // Deal 2 cards to each active player
    for (const p of s.players.filter(p => !p.folded)) {
        p.holeCards = [s.deck.pop(), s.deck.pop()];
    }
    // Post blinds
    const sbIdx = nextActiveIdx(s, s.dealerIdx);
    const bbIdx = nextActiveIdx(s, sbIdx);
    postBlind(s, sbIdx, s.smallBlind);
    postBlind(s, bbIdx, s.bigBlind);
    // Action starts left of BB
    s.actionIdx = nextActiveIdx(s, bbIdx);
    return s;
}
function postBlind(s, idx, amount) {
    const p = s.players[idx];
    if (!p)
        return;
    const actual = Math.min(amount, p.chips);
    p.chips -= actual;
    p.bet += actual;
    p.totalBet += actual;
    s.pot += actual;
    if (p.chips === 0)
        p.allIn = true;
}
function applyAction(state, playerId, action, amount = 0) {
    const s = deepClone(state);
    const p = s.players[s.actionIdx];
    if (!p || p.id !== playerId || p.folded || p.allIn)
        return s;
    const toCall = s.currentBet - p.bet;
    switch (action) {
        case 'fold':
            p.folded = true;
            break;
        case 'check':
            if (toCall > 0)
                return s; // can't check
            break;
        case 'call': {
            const callAmt = Math.min(toCall, p.chips);
            p.chips -= callAmt;
            p.bet += callAmt;
            p.totalBet += callAmt;
            s.pot += callAmt;
            if (p.chips === 0)
                p.allIn = true;
            break;
        }
        case 'raise':
        case 'allin': {
            const raiseAmt = action === 'allin' ? p.chips : Math.min(amount, p.chips);
            if (raiseAmt < s.minRaise && p.chips > raiseAmt)
                return s; // invalid raise
            const newBet = p.bet + raiseAmt;
            s.minRaise = Math.max(s.minRaise, newBet - s.currentBet);
            s.currentBet = Math.max(s.currentBet, newBet);
            p.chips -= raiseAmt;
            p.bet += raiseAmt;
            p.totalBet += raiseAmt;
            s.pot += raiseAmt;
            if (p.chips === 0)
                p.allIn = true;
            break;
        }
    }
    p.hasActed = true;
    s.lastActionTime = Date.now();
    // Check if street is over
    if (isStreetOver(s)) {
        return advanceStreet(s);
    }
    s.actionIdx = nextActiveIdx(s, s.actionIdx);
    return s;
}
function isStreetOver(s) {
    const active = s.players.filter(p => !p.folded && !p.allIn);
    if (active.length === 0)
        return true;
    // All active players have matched the current bet AND had a chance to act
    return active.every(p => p.hasActed && p.bet === s.currentBet);
}
function advanceStreet(s) {
    // Reset bets and acted flags for new street
    for (const p of s.players) {
        p.bet = 0;
        p.hasActed = false;
    }
    s.currentBet = 0;
    s.minRaise = s.bigBlind;
    const notFolded = s.players.filter(p => !p.folded);
    if (notFolded.length === 1) {
        // Everyone else folded — winner takes pot
        s.winners = [{ playerId: notFolded[0].id, amount: s.pot, hand: 'Last standing' }];
        notFolded[0].chips += s.pot;
        s.pot = 0;
        s.street = 'showdown';
        return s;
    }
    switch (s.street) {
        case 'preflop':
            s.board.push(s.deck.pop(), s.deck.pop(), s.deck.pop()); // flop
            s.street = 'flop';
            break;
        case 'flop':
            s.board.push(s.deck.pop()); // turn
            s.street = 'turn';
            break;
        case 'turn':
            s.board.push(s.deck.pop()); // river
            s.street = 'river';
            break;
        case 'river':
            s.street = 'showdown';
            return resolveShowdown(s);
    }
    // Action starts from first active player left of dealer
    s.actionIdx = nextActiveIdx(s, s.dealerIdx);
    return s;
}
// Build side pots from players' total bets (including folded contributors)
function calculatePots(players) {
    const contributors = players.filter(p => p.totalBet > 0);
    if (contributors.length === 0)
        return [];
    const levels = [...new Set(contributors.map(p => p.totalBet))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
        const contribution = level - prev;
        const numContributors = contributors.filter(p => p.totalBet >= level).length;
        const potAmount = contribution * numContributors;
        const eligible = players.filter(p => !p.folded && p.totalBet >= level).map(p => p.id);
        if (potAmount > 0)
            pots.push({ amount: potAmount, eligible });
        prev = level;
    }
    return pots;
}
function resolveShowdown(s) {
    const boardStr = s.board.map(c => `${c.rank}${c.suit}`).join(' ');
    for (const p of s.players.filter(p => !p.folded)) {
        const hole = p.holeCards.map(c => `${c.rank}${c.suit}`).join(' ');
        const r = (0, handEval_1.evaluate)([...p.holeCards, ...s.board]);
        console.log(`[Showdown] ${p.name}: hole=[${hole}] board=[${boardStr}] → ${r.name} (score=${r.score})`);
    }
    for (const p of s.players.filter(p => p.folded && p.holeCards.length > 0)) {
        const hole = p.holeCards.map(c => `${c.rank}${c.suit}`).join(' ');
        const ev = (0, handEval_1.evaluate)([...p.holeCards, ...s.board]);
        console.log(`[Showdown] ${p.name} (FOLDED): hole=[${hole}] board=[${boardStr}] → would have had ${ev.name} (score=${ev.score})`);
    }
    const pots = calculatePots(s.players);
    const winnerMap = new Map();
    for (const pot of pots) {
        const eligible = s.players.filter(p => pot.eligible.includes(p.id));
        if (eligible.length === 0)
            continue;
        if (eligible.length === 1) {
            eligible[0].chips += pot.amount;
            const e = winnerMap.get(eligible[0].id);
            if (e)
                e.amount += pot.amount;
            else
                winnerMap.set(eligible[0].id, { amount: pot.amount, hand: 'Last standing' });
            continue;
        }
        const results = eligible
            .map(p => ({ player: p, result: (0, handEval_1.evaluate)([...p.holeCards, ...s.board]) }))
            .sort((a, b) => (0, handEval_1.compareHands)(b.result, a.result));
        const topScore = results[0].result.score;
        const potWinners = results.filter(r => r.result.score === topScore);
        const share = Math.floor(pot.amount / potWinners.length);
        const remainder = pot.amount - share * potWinners.length;
        if (potWinners.length > 1) {
            console.log(`[Showdown] SPLIT ${pot.amount}: ${potWinners.map(w => w.player.name).join(' & ')} each ${share}`);
        }
        else {
            console.log(`[Showdown] WIN: ${potWinners[0].player.name} takes ${pot.amount} with ${potWinners[0].result.name}`);
        }
        for (let i = 0; i < potWinners.length; i++) {
            const amount = share + (i === 0 ? remainder : 0);
            potWinners[i].player.chips += amount;
            const e = winnerMap.get(potWinners[i].player.id);
            if (e)
                e.amount += amount;
            else
                winnerMap.set(potWinners[i].player.id, { amount, hand: potWinners[i].result.name });
        }
    }
    s.winners = [...winnerMap.entries()].map(([playerId, { amount, hand }]) => ({ playerId, amount, hand }));
    s.pot = 0;
    return s;
}
function nextActiveIdx(s, fromIdx) {
    const n = s.players.length;
    let idx = (fromIdx + 1) % n;
    let tries = 0;
    while (tries < n) {
        const p = s.players[idx];
        if (p && !p.folded && !p.allIn && p.connected && p.chips > 0)
            return idx;
        idx = (idx + 1) % n;
        tries++;
    }
    return fromIdx;
}
function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function addPlayer(state, id, name, chips, seat) {
    const s = deepClone(state);
    const existing = s.players.find(p => p.id === id);
    if (existing) {
        existing.connected = true;
        return s;
    }
    s.players.push({ id, name, chips, holeCards: [], bet: 0, totalBet: 0, folded: false, allIn: false, connected: true, seatIndex: seat, hasActed: false });
    s.players.sort((a, b) => a.seatIndex - b.seatIndex);
    return s;
}
function removePlayer(state, id) {
    const s = deepClone(state);
    const p = s.players.find(p => p.id === id);
    if (p)
        p.connected = false;
    return s;
}
// Mask hole cards for a specific viewer (hide opponent cards)
function maskForPlayer(state, viewerId) {
    const s = deepClone(state);
    // All-in players show cards if no more betting action is possible
    const activeBettors = s.players.filter(p => !p.folded && !p.allIn);
    const allInShowdown = activeBettors.length <= 1; // all remaining are all-in → show cards
    for (const p of s.players) {
        if (p.id !== viewerId && s.street !== 'showdown') {
            // Keep cards visible if player is all-in and board is being run out
            if (p.allIn && allInShowdown)
                continue;
            p.holeCards = p.holeCards.map(() => ({ rank: '?', suit: '?' }));
        }
    }
    return s;
}
