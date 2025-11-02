let clients = [];

export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    clients.push(res);
    req.on('close', () => clients = clients.filter(c => c !== res));
  } else if (req.method === 'POST') {
    const body = await new Promise(r => {
      let data = ''; req.on('data', c => data += c);
      req.on('end', () => r(JSON.parse(data || '{}')));
    });
    for (const client of clients) {
      client.write(`data: ${JSON.stringify(body)}\n\n`);
    }
    res.status(200).json({ ok: true });
  } else {
    res.status(405).end();
  }
}