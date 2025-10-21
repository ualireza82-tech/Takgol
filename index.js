const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let messages = [];

function broadcast(obj) {
  const raw = JSON.stringify(obj);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(raw);
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', messages }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const out = {
        id: Date.now() + Math.floor(Math.random()*999),
        user: String(msg.user || 'Anonymous'),
        text: String(msg.text || '').slice(0, 1000),
        ts: new Date().toISOString()
      };
      messages.push(out);
      if (messages.length > 200) messages.shift();
      broadcast({ type: 'message', message: out });
    } catch (err) {
      console.error('bad message', err);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});