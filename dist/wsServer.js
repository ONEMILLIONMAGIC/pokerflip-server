"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupWS = setupWS;
const ws_1 = require("ws");
const game_1 = require("./engine/game");
const db_1 = require("./db");
const tables = new Map();
const clients = new Map();
// Auto-start timer per table
const startTimers = new Map();
// Action timeout timers
const actionTimers = new Map();
const STARTING_CHIPS = 1000;
const ACTION_TIMEOUT_MS = 30000;
function setupWS(wss) {
    wss.on('connection', (ws) => {
        console.log('WS connected');
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                handleMessage(ws, msg);
            }
            catch (e) {
                send(ws, { type: 'error', message: 'Invalid message' });
            }
        });
        ws.on('close', () => handleDisconnect(ws));
        ws.on('error', () => handleDisconnect(ws));
    });
}
function handleMessage(ws, msg) {
    const { type } = msg;
    if (type === 'join') {
        const { tableId = 'main', playerId, playerName } = msg;
        if (!playerId || !playerName)
            return send(ws, { type: 'error', message: 'Need playerId and playerName' });
        // Get or create table
        if (!tables.has(tableId))
            tables.set(tableId, (0, game_1.createTable)(tableId));
        let state = tables.get(tableId);
        // Find free seat (0-5)
        const takenSeats = state.players.map(p => p.seatIndex);
        const seat = [0, 1, 2, 3, 4, 5].find(s => !takenSeats.includes(s)) ?? 0;
        state = (0, game_1.addPlayer)(state, playerId, playerName, STARTING_CHIPS, seat);
        tables.set(tableId, state);
        clients.set(ws, { ws, playerId, playerName, tableId });
        broadcastTable(tableId);
        send(ws, { type: 'joined', playerId, tableId, chips: STARTING_CHIPS });
        // Auto-start if enough players
        scheduleStart(tableId);
        return;
    }
    const client = clients.get(ws);
    if (!client)
        return send(ws, { type: 'error', message: 'Not joined' });
    const { playerId, tableId } = client;
    if (type === 'action') {
        const { action, amount } = msg;
        let state = tables.get(tableId);
        if (!state)
            return;
        const prevStreet = state.street;
        state = (0, game_1.applyAction)(state, playerId, action, amount);
        tables.set(tableId, state);
        clearActionTimer(tableId);
        broadcastTable(tableId);
        if (state.street === 'showdown' && prevStreet !== 'showdown') {
            saveHandStats(state).catch(e => console.error('stats error:', e));
            setTimeout(() => {
                let s = tables.get(tableId);
                if (!s)
                    return;
                if ((0, game_1.canStart)(s)) {
                    s = (0, game_1.startHand)(s);
                    tables.set(tableId, s);
                }
                else
                    s.street = 'waiting';
                broadcastTable(tableId);
                setActionTimer(tableId);
            }, 4000);
        }
        else {
            setActionTimer(tableId);
        }
        return;
    }
    if (type === 'start') {
        let state = tables.get(tableId);
        if (!state || !(0, game_1.canStart)(state))
            return send(ws, { type: 'error', message: 'Need 2+ players' });
        state = (0, game_1.startHand)(state);
        tables.set(tableId, state);
        broadcastTable(tableId);
        setActionTimer(tableId);
        return;
    }
    if (type === 'chat') {
        broadcastToTable(tableId, { type: 'chat', playerId, playerName: client.playerName, message: String(msg.message).slice(0, 200) });
        return;
    }
    if (type === 'ping') {
        send(ws, { type: 'pong' });
        return;
    }
}
function handleDisconnect(ws) {
    const client = clients.get(ws);
    if (!client)
        return;
    clients.delete(ws);
    const { tableId, playerId } = client;
    let state = tables.get(tableId);
    if (!state)
        return;
    state = (0, game_1.removePlayer)(state, playerId);
    tables.set(tableId, state);
    broadcastTable(tableId);
    console.log(`Player ${playerId} disconnected from ${tableId}`);
}
function scheduleStart(tableId) {
    if (startTimers.has(tableId))
        return;
    const timer = setTimeout(() => {
        startTimers.delete(tableId);
        let state = tables.get(tableId);
        if (!state || !(0, game_1.canStart)(state) || state.street !== 'waiting')
            return;
        state = (0, game_1.startHand)(state);
        tables.set(tableId, state);
        broadcastTable(tableId);
        setActionTimer(tableId);
    }, 3000);
    startTimers.set(tableId, timer);
}
function setActionTimer(tableId) {
    clearActionTimer(tableId);
    const timer = setTimeout(() => {
        let state = tables.get(tableId);
        if (!state || state.street === 'waiting' || state.street === 'showdown')
            return;
        const p = state.players[state.actionIdx];
        if (!p || p.folded || p.allIn)
            return;
        // Auto-fold on timeout
        state = (0, game_1.applyAction)(state, p.id, 'fold');
        tables.set(tableId, state);
        broadcastTable(tableId);
    }, ACTION_TIMEOUT_MS);
    actionTimers.set(tableId, timer);
}
function clearActionTimer(tableId) {
    const t = actionTimers.get(tableId);
    if (t) {
        clearTimeout(t);
        actionTimers.delete(tableId);
    }
}
function broadcastTable(tableId) {
    const state = tables.get(tableId);
    if (!state)
        return;
    // Send each player their own masked view
    for (const [ws, client] of clients) {
        if (client.tableId !== tableId)
            continue;
        if (ws.readyState !== ws_1.WebSocket.OPEN)
            continue;
        const masked = (0, game_1.maskForPlayer)(state, client.playerId);
        send(ws, { type: 'state', state: masked });
    }
}
function broadcastToTable(tableId, msg) {
    for (const [ws, client] of clients) {
        if (client.tableId === tableId && ws.readyState === ws_1.WebSocket.OPEN)
            send(ws, msg);
    }
}
function send(ws, msg) {
    if (ws.readyState === ws_1.WebSocket.OPEN)
        ws.send(JSON.stringify(msg));
}
async function saveHandStats(state) {
    if (!process.env.DATABASE_URL)
        return;
    const db = (0, db_1.getPool)();
    const winnerIds = new Set(state.winners.map(w => w.playerId));
    const pot = state.pot;
    for (const player of state.players) {
        if (!player.connected)
            continue;
        const isWinner = winnerIds.has(player.id);
        const wonAmount = state.winners.find(w => w.playerId === player.id)?.amount || 0;
        await db.query(`UPDATE pf_users SET
        hands_played = hands_played + 1,
        hands_won    = hands_won + $1,
        biggest_pot  = GREATEST(biggest_pot, $2)
       WHERE tg_id = $3`, [isWinner ? 1 : 0, isWinner ? wonAmount : 0, player.id]).catch(() => { });
    }
    console.log(`Hand stats saved: pot=${pot}, winners=${[...winnerIds].join(',')}`);
}
