export default function handler(req, res) {
  if (req.headers.upgrade !== 'websocket') {
    return res.status(400).send('Expected WebSocket');
  }

  const { socket } = res;
  socket.upgrade(req);

  const clients = globalThis.clients || (globalThis.clients = new Set());
  clients.add(socket);

  socket.addEventListener('message', (event) => {
    for (const client of clients) {
      if (client.readyState === 1) client.send(event.data);
    }
  });

  socket.addEventListener('close', () => clients.delete(socket));
}