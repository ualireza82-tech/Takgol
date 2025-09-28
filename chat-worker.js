export default {
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") return handleWebSocket(req);
    return new Response("AJ Chat running", { status: 200 });
  }
};

const rooms = {}; // { roomName: Set of sockets }

function handleWebSocket(req) {
  if (req.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected websocket", { status: 400 });
  }

  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  let currentRoom = null;

  server.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "join") {
      currentRoom = data.room;
      rooms[currentRoom] ??= new Set();
      rooms[currentRoom].add(server);
    }

    if (data.type === "msg" && currentRoom) {
      for (const peer of rooms[currentRoom]) {
        if (peer.readyState === 1) {
          peer.send(JSON.stringify({ room: currentRoom, text: data.text }));
        }
      }
    }
  });

  server.addEventListener("close", () => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].delete(server);
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}