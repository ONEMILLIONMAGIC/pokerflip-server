"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const ws_1 = require("ws");
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const wsServer_1 = require("./wsServer");
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.get('/', (_req, res) => res.json({ status: 'PokerFlip server running ♠️' }));
app.get('/tables', (_req, res) => {
    res.json({ tables: [{ id: 'main', name: 'Main Table', blinds: '10/20', players: 0, maxPlayers: 6 }] });
});
const server = (0, http_1.createServer)(app);
const wss = new ws_1.WebSocketServer({ server });
(0, wsServer_1.setupWS)(wss);
const PORT = process.env.PORT || 3002;
server.listen(PORT, () => console.log(`\n♠️ PokerFlip server → http://localhost:${PORT}\n   WebSocket → ws://localhost:${PORT}\n`));
