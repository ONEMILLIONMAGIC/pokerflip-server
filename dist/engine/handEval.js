"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluate = evaluate;
exports.compareHands = compareHands;
const deck_1 = require("./deck");
const HAND_NAMES = ['High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
function rankVal(r) { return deck_1.RANK_VAL[r]; }
function evaluate(cards) {
    // Pick best 5 from up to 7 cards (2 hole + 5 board)
    const combos = choose5(cards);
    let best = null;
    for (const combo of combos) {
        const result = eval5(combo);
        if (!best || result.score > best.score)
            best = result;
    }
    return best;
}
function choose5(cards) {
    if (cards.length === 5)
        return [cards];
    const result = [];
    for (let i = 0; i < cards.length - 4; i++)
        for (let j = i + 1; j < cards.length - 3; j++)
            for (let k = j + 1; k < cards.length - 2; k++)
                for (let l = k + 1; l < cards.length - 1; l++)
                    for (let m = l + 1; m < cards.length; m++)
                        result.push([cards[i], cards[j], cards[k], cards[l], cards[m]]);
    return result;
}
function eval5(cards) {
    const vals = cards.map(c => rankVal(c.rank)).sort((a, b) => b - a);
    const suits = cards.map(c => c.suit);
    const isFlush = suits.every(s => s === suits[0]);
    const isStraight = checkStraight(vals);
    const groups = groupBy(vals);
    const counts = Object.values(groups).sort((a, b) => b - a);
    let rank;
    let score;
    if (isFlush && isStraight) {
        rank = 8;
        score = 8000000 + (isStraight === 'wheel' ? 5 : vals[0]);
    }
    else if (counts[0] === 4) {
        rank = 7;
        score = 7000000 + quads(groups) * 1000 + kickers(groups, [4]);
    }
    else if (counts[0] === 3 && counts[1] === 2) {
        rank = 6;
        score = 6000000 + trips(groups) * 1000 + pairs(groups)[0];
    }
    else if (isFlush) {
        rank = 5;
        score = 5000000 + encodeVals(vals);
    }
    else if (isStraight) {
        rank = 4;
        score = 4000000 + (isStraight === 'wheel' ? 5 : vals[0]);
    }
    else if (counts[0] === 3) {
        rank = 3;
        score = 3000000 + trips(groups) * 10000 + kickers(groups, [3]);
    }
    else if (counts[0] === 2 && counts[1] === 2) {
        rank = 2;
        const ps = pairs(groups).sort((a, b) => b - a);
        score = 2000000 + ps[0] * 1000 + ps[1] * 50 + kickers(groups, [2, 2]);
    }
    else if (counts[0] === 2) {
        rank = 1;
        score = 1000000 + pairs(groups)[0] * 10000 + kickers(groups, [2]);
    }
    else {
        rank = 0;
        score = encodeVals(vals);
    }
    return { rank, name: HAND_NAMES[rank], score, best5: cards };
}
function checkStraight(vals) {
    const unique = [...new Set(vals)];
    if (unique.length < 5)
        return false;
    if (unique[0] - unique[4] === 4)
        return 'normal';
    // Wheel A-2-3-4-5
    if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2)
        return 'wheel';
    return false;
}
function groupBy(vals) {
    const g = {};
    for (const v of vals)
        g[v] = (g[v] || 0) + 1;
    return g;
}
function encodeVals(vals) {
    return vals.reduce((acc, v, i) => acc + v * Math.pow(15, 4 - i), 0);
}
function quads(g) { return Number(Object.entries(g).find(([, c]) => c === 4)[0]); }
function trips(g) { return Number(Object.entries(g).find(([, c]) => c === 3)[0]); }
function pairs(g) { return Object.entries(g).filter(([, c]) => c === 2).map(([v]) => Number(v)); }
function kickers(g, exclude) {
    const excl = [...exclude];
    return Object.entries(g)
        .filter(([, c]) => { const i = excl.indexOf(c); if (i >= 0) {
        excl.splice(i, 1);
        return false;
    } return true; })
        .map(([v]) => Number(v))
        .sort((a, b) => b - a)
        .reduce((acc, v, i) => acc + v * Math.pow(15, 2 - i), 0);
}
function compareHands(a, b) {
    return a.score - b.score;
}
