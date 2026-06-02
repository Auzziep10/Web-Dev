// Task Organizer server — zero external dependencies, just Node built-ins.
// Run: node server.js   (or double-click start.bat on Windows)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 3030;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const TOKEN_FILE = path.join(ROOT, '.tokens.json');
const INDEX_FILE = path.join(ROOT, 'index.html');

// --- Tokens (auto-generated on first run) ---
let tokens;
if (fs.existsSync(TOKEN_FILE)) {
  tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
} else {
  tokens = {
    editor: crypto.randomBytes(18).toString('base64url'),
    viewer: crypto.randomBytes(12).toString('base64url'),
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

// --- State ---
let state;
if (fs.existsSync(DATA_FILE)) {
  state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} else {
  state = { tasks: [] };
  saveState();
}

function saveState() {
  // Atomic-ish: write to tmp, rename
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// --- SSE clients for live updates ---
const sseClients = new Set();

function broadcast(senderCid) {
  const payload = `data: ${JSON.stringify({ ...state, _from: senderCid || null })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { /* client gone */ }
  }
}

// --- Auth ---
function getToken(req, url) {
  const fromQuery = url.searchParams.get('token');
  if (fromQuery) return fromQuery;
  const auth = req.headers.authorization || '';
  return auth.replace(/^Bearer\s+/i, '');
}

function authLevel(token) {
  if (token && token === tokens.editor) return 'editor';
  if (token && token === tokens.viewer) return 'viewer';
  return null;
}

// --- Helpers ---
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 5_000_000) { req.destroy(); reject(new Error('too large')); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : null); }
      catch (e) { resolve(null); }
    });
    req.on('error', reject);
  });
}

// --- Routing ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const token = getToken(req, url);
  const role = authLevel(token);

  // Serve index.html at root (no auth needed — the page will prompt for token)
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    try {
      const html = fs.readFileSync(INDEX_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500); res.end('index.html missing');
    }
    return;
  }

  // Auth check endpoint — returns role for the given token
  if (req.method === 'GET' && p === '/api/whoami') {
    if (!role) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, { role });
  }

  // Fetch current state
  if (req.method === 'GET' && p === '/api/tasks') {
    if (!role) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, state);
  }

  // Live updates via Server-Sent Events
  if (req.method === 'GET' && p === '/api/stream') {
    if (!role) return sendJson(res, 401, { error: 'unauthorized' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    sseClients.add(res);
    // Heartbeat every 25s to keep proxies/firewalls happy
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25_000);
    req.on('close', () => {
      clearInterval(hb);
      sseClients.delete(res);
    });
    return;
  }

  // Save whole state (editor only)
  if (req.method === 'POST' && p === '/api/tasks') {
    if (role !== 'editor') return sendJson(res, 403, { error: 'forbidden' });
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJson(res, 413, { error: 'too large' }); }
    if (!body || !Array.isArray(body.tasks)) return sendJson(res, 400, { error: 'bad body' });
    state = { tasks: body.tasks };
    saveState();
    const cid = url.searchParams.get('cid');
    broadcast(cid);
    return sendJson(res, 200, { ok: true });
  }

  // 404
  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }

  const editorUrl = `http://localhost:${PORT}/?token=${tokens.editor}`;
  console.log('');
  console.log('=== App Design Tasks — server running ===');
  console.log('');
  console.log(`Editor (you):  ${editorUrl}`);
  if (ips.length) {
    console.log('');
    console.log('Share with teammates on your network (read-only):');
    for (const ip of ips) {
      console.log(`  http://${ip}:${PORT}/?token=${tokens.viewer}&view=1`);
    }
    console.log('');
    console.log('Editor URL from another machine on your network:');
    for (const ip of ips) {
      console.log(`  http://${ip}:${PORT}/?token=${tokens.editor}`);
    }
  }
  console.log('');
  console.log(`Data file:   ${DATA_FILE}`);
  console.log(`Tokens file: ${TOKEN_FILE}  (delete to regenerate)`);
  console.log('');
  console.log('Press Ctrl+C to stop.');
  console.log('');

  if (process.env.NO_OPEN !== '1') {
    // Open default browser to the editor URL (Windows / mac / linux)
    const cmd = process.platform === 'win32'
      ? `start "" "${editorUrl}"`
      : process.platform === 'darwin'
        ? `open "${editorUrl}"`
        : `xdg-open "${editorUrl}"`;
    exec(cmd, () => {});
  }
});
