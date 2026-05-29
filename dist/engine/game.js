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
        dealerIdx: 0, actionIdx: 0, bbIdx: 0,
        smallBlind: sb, bigBlind: bb,
        lastActionTime: Date.now(), winners: [],
    };
}
function canStart(state) {
    return state.players.filter(p => p.connected && p.chips > 0).length >= 2;
}
// All mutations happen in-place; functions return the same reference.
// Only maskForPlayer (view generation) deep-clones, never the hot path.
function startHand(state) {
    const activePlayers = state.players.filter(p => p.connected && p.chips > 0);
    if (activePlayers.length < 2)
        return state;
    state.deck = (0, deck_1.shuffle)((0, deck_1.makeDeck)());
    state.board = [];
    state.pot = 0;
    state.sidePots = [];
    state.currentBet = state.bigBlind;
    state.minRaise = state.bigBlind;
    state.winners = [];
    state.street = 'preflop';
    state.lastActionTime = Date.now();
    for (const p of state.players) {
        p.holeCards = [];
        p.bet = 0;
        p.totalBet = 0;
        p.folded = p.chips === 0;
        p.allIn = false;
        p.hasActed = false;
    }
    state.dealerIdx = nextActiveIdx(state, state.dealerIdx);
    for (const p of state.players.filter(p => !p.folded)) {
        p.holeCards = [state.deck.pop(), state.deck.pop()];
    }
    const sbIdx = nextActiveIdx(state, state.dealerIdx);
    const bbIdx = nextActiveIdx(state, sbIdx);
    postBlind(state, sbIdx, state.smallBlind);
    postBlind(state, bbIdx, state.bigBlind);
    state.bbIdx = bbIdx;
    state.actionIdx = nextActiveIdx(state, bbIdx);
    return state;
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
    const p = state.players[state.actionIdx];
    if (!p || p.id !== playerId || p.folded || p.allIn)
        return state;
    const toCall = state.currentBet - p.bet;
    switch (action) {
        case 'fold':
            p.folded = true;
            break;
        case 'check':
            if (toCall > 0)
                return state;
            break;
        case 'call': {
            const callAmt = Math.min(toCall, p.chips);
            p.chips -= callAmt;
            p.bet += callAmt;
            p.totalBet += callAmt;
            state.pot += callAmt;
            if (p.chips === 0)
                p.allIn = true;
            break;
        }
        case 'raise':
        case 'allin': {
            const raiseAmt = action === 'allin' ? p.chips : Math.min(amount, p.chips);
            if (raiseAmt < state.minRaise && p.chips > raiseAmt)
                return state;
            const newBet = p.bet + raiseAmt;
            state.minRaise = Math.max(state.minRaise, newBet - state.currentBet);
            state.currentBet = Math.max(state.currentBet, newBet);
            p.chips -= raiseAmt;
            p.bet += raiseAmt;
            p.totalBet += raiseAmt;
            state.pot += raiseAmt;
            if (p.chips === 0)
                p.allIn = true;
            break;
        }
    }
    p.hasActed = true;
    state.lastActionTime = Date.now();
    if (isStreetOver(state)) {
        return advanceStreet(state);
    }
    state.actionIdx = nextActiveIdx(state, state.actionIdx);
    return state;
}
function isStreetOver(s) {
    const notFolded = s.players.filter(p => !p.folded);
    if (notFolded.length <= 1)
        return true;
    const active = notFolded.filter(p => !p.allIn);
    if (active.length === 0)
        return true;
    return active.every(p => p.hasActed && p.bet === s.currentBet);
}
function advanceStreet(s) {
    for (const p of s.players) {
        p.bet = 0;
        p.hasActed = false;
    }
    s.currentBet = 0;
    s.minRaise = s.bigBlind;
    const notFolded = s.players.filter(p => !p.folded);
    if (notFolded.length === 1) {
        const winner = notFolded[0];
        // Return uncalled portion: winner may have raised more than anyone matched
        const others = s.players.filter(p => p.id !== winner.id && p.totalBet > 0);
        const maxOtherBet = others.length > 0 ? Math.max(...others.map(p => p.totalBet)) : 0;
        const uncalled = Math.max(0, winner.totalBet - maxOtherBet);
        const wonAmount = s.pot - uncalled;
        winner.chips += s.pot;
        s.winners = [{ playerId: winner.id, amount: wonAmount, hand: 'Last standing' }];
        s.pot = 0;
        s.street = 'showdown';
        return s;
    }
    switch (s.street) {
        case 'preflop':
            s.board.push(s.deck.pop(), s.deck.pop(), s.deck.pop());
            s.street = 'flop';
            break;
        case 'flop':
            s.board.push(s.deck.pop());
            s.street = 'turn';
            break;
        case 'turn':
            s.board.push(s.deck.pop());
            s.street = 'river';
            break;
        case 'river':
            s.street = 'showdown';
            return resolveShowdown(s);
    }
    s.actionIdx = nextActiveIdx(s, s.dealerIdx);
    return s;
}
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
        // refund = only one player ever put money at this level (uncalled excess)
        if (potAmount > 0)
            pots.push({ amount: potAmount, eligible, refund: numContributors === 1 });
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
    const pots = calculatePots(s.players);
    const winnerMap = new Map();
    for (const pot of pots) {
        const eligible = s.players.filter(p => pot.eligible.includes(p.id));
        if (eligible.length === 0)
            continue;
        if (eligible.length === 1) {
            eligible[0].chips += pot.amount;
            if (!pot.refund) {
                // Others contributed but folded — legitimate uncontested win
                const e = winnerMap.get(eligible[0].id);
                if (e)
                    e.amount += pot.amount;
                else
                    winnerMap.set(eligible[0].id, { amount: pot.amount, hand: 'Last standing' });
            }
            // refund === true: player's own uncalled excess returned silently, not a win
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
    for (let i = 1; i <= n; i++) {
        const idx = (fromIdx + i) % n;
        const p = s.players[idx];
        if (p && !p.folded && !p.allIn && p.chips > 0)
            return idx;
    }
    return fromIdx;
}
function addPlayer(state, id, name, chips, seat) {
    const existing = state.players.find(p => p.id === id);
    if (existing) {
        existing.connected = true;
        return state;
    }
    state.players.push({ id, name, chips, holeCards: [], bet: 0, totalBet: 0, folded: false, allIn: false, connected: true, seatIndex: seat, hasActed: false });
    state.players.sort((a, b) => a.seatIndex - b.seatIndex);
    return state;
}
function removePlayer(state, id) {
    const p = state.players.find(p => p.id === id);
    if (p)
        p.connected = false;
    return state;
}
function maskForPlayer(state, viewerId) {
    const s = structuredClone(state);
    const activeBettors = s.players.filter(p => !p.folded && !p.allIn);
    const allInShowdown = activeBettors.length === 0;
    for (const p of s.players) {
        if (p.id !== viewerId && s.street !== 'showdown') {
            if (p.allIn && allInShowdown)
                continue;
            p.holeCards = p.holeCards.map(() => ({ rank: '?', suit: '?' }));
        }
    }
    return s;
}
