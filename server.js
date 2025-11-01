import express from "express";
import { WebSocketServer } from "ws";
import http from "http";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
let clients = [];

wss.on("connection", ws => {
  clients.push(ws);
  ws.on("message", msg => clients.forEach(c => c.send(msg)));
  ws.on("close", () => clients = clients.filter(c => c !== ws));
});

app.get("/", (req, res) => res.send("✅ WebSocket chat is running"));
server.listen(10000);