/**
 * A standalone local "webhook inbox" for manual testing — a real HTTP server
 * that accepts a POST on any path, records it, and shows the stream on a live
 * web page. No dependency on the app or on npm packages beyond Node.
 *
 *   npm run inbox                 # listens on http://localhost:4000
 *   WEBHOOK_INBOX_PORT=5000 npm run inbox
 *
 * Point a subscription's targetUrl at it, e.g. http://localhost:4000/orders.
 * (The app's SSRF guard blocks loopback, so run the app with
 * SSRF_GUARD_ENABLED=false ALLOW_INSECURE_TARGET_URLS=true for local testing.)
 *
 * Make the subscriber misbehave, to exercise retries:
 *   http://localhost:4000/orders?status=500       -> always responds 500
 *   http://localhost:4000/orders?status=500,200   -> 500 then 200 then 200...
 *   http://localhost:4000/orders?delay=8000       -> waits 8s before responding
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const PORT = Number(process.env.WEBHOOK_INBOX_PORT ?? 4000);
const MAX_RECORDS = 200;

interface Received {
  readonly n: number;
  readonly receivedAt: string;
  readonly method: string;
  readonly path: string;
  readonly respondedStatus: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const received: Received[] = [];
let counter = 0;

const INTERESTING_HEADERS = [
  'content-type',
  'user-agent',
  'x-webhook-event-id',
  'x-webhook-delivery-id',
  'x-webhook-attempt',
];

function pickHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of INTERESTING_HEADERS) {
    const value = raw[key];
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

/** Returns the status this request should get, and advances a per-path sequence. */
const statusSequences = new Map<string, number[]>();
function nextStatus(pathname: string, query: URLSearchParams): number {
  const raw = query.get('status');
  if (raw === null) {
    return 200;
  }
  const codes = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 100 && n <= 599);
  if (codes.length === 0) {
    return 200;
  }
  if (codes.length === 1) {
    return codes[0] ?? 200;
  }
  const key = `${pathname}?${raw}`;
  const remaining = statusSequences.get(key) ?? [...codes];
  const status = remaining.shift() ?? codes[codes.length - 1] ?? 200;
  statusSequences.set(key, remaining.length > 0 ? remaining : [codes[codes.length - 1] ?? 200]);
  return status;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);

  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/_inbox.json') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(received));
    return;
  }
  if (url.pathname === '/_inbox/clear') {
    received.length = 0;
    statusSequences.clear();
    response.writeHead(204);
    response.end();
    return;
  }

  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const status = nextStatus(url.pathname, url.searchParams);
    counter += 1;
    const record: Received = {
      n: counter,
      receivedAt: new Date().toISOString(),
      method: request.method ?? '',
      path: url.pathname + url.search,
      respondedStatus: status,
      headers: pickHeaders(request.headers),
      body: parseJson(rawBody),
    };
    received.unshift(record);
    if (received.length > MAX_RECORDS) {
      received.length = MAX_RECORDS;
    }
    process.stdout.write(
      `${record.receivedAt}  ${record.method} ${record.path}  -> ${status}` +
        `  attempt=${record.headers['x-webhook-attempt'] ?? '-'}` +
        `  event=${record.headers['x-webhook-event-id'] ?? '-'}\n`,
    );

    const delayMs = Number(url.searchParams.get('delay') ?? 0);
    const send = (): void => {
      response.writeHead(status);
      response.end();
    };
    if (delayMs > 0) {
      setTimeout(send, delayMs);
    } else {
      send();
    }
  });
});

server.listen(PORT, () => {
  const address = server.address() as AddressInfo;
  process.stdout.write(`webhook inbox listening on http://localhost:${address.port}\n`);
  process.stdout.write(`open http://localhost:${address.port} to watch incoming webhooks\n`);
});

function parseJson(raw: string): unknown {
  if (raw.length === 0) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Webhook Inbox</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 1rem; }
    h1 { font-size: 1.1rem; margin: 0 0 .5rem; }
    .bar { display: flex; gap: 1rem; align-items: center; margin-bottom: 1rem; }
    .count { opacity: .7; }
    button { font: inherit; padding: .3rem .7rem; }
    .item { border: 1px solid rgba(128,128,128,.4); border-radius: 6px; padding: .6rem .8rem; margin-bottom: .6rem; }
    .head { display: flex; gap: .8rem; flex-wrap: wrap; align-items: baseline; }
    .method { font-weight: 700; }
    .status-2 { color: #2e7d32; } .status-4, .status-5 { color: #c62828; }
    .time { opacity: .6; font-size: .85em; }
    .meta { opacity: .8; font-size: .85em; margin: .3rem 0; }
    pre { background: rgba(128,128,128,.12); padding: .5rem; border-radius: 4px; overflow-x: auto; margin: .3rem 0 0; }
    .empty { opacity: .6; }
  </style>
</head>
<body>
  <h1>Webhook Inbox</h1>
  <div class="bar">
    <span class="count" id="count">0 received</span>
    <button onclick="clearInbox()">Clear</button>
    <label><input type="checkbox" id="auto" checked /> auto-refresh</label>
  </div>
  <div id="list"><p class="empty">Waiting for webhooks…</p></div>
  <script>
    async function clearInbox() {
      await fetch('/_inbox/clear');
      render([]);
    }
    function statusClass(s) { return 'status-' + String(s)[0]; }
    function render(items) {
      document.getElementById('count').textContent = items.length + ' received';
      const list = document.getElementById('list');
      if (items.length === 0) { list.innerHTML = '<p class="empty">Waiting for webhooks…</p>'; return; }
      list.innerHTML = items.map(function (r) {
        var h = r.headers || {};
        var meta = ['event=' + (h['x-webhook-event-id'] || '-'),
                    'delivery=' + (h['x-webhook-delivery-id'] || '-'),
                    'attempt=' + (h['x-webhook-attempt'] || '-'),
                    'content-type=' + (h['content-type'] || '-')].join('  ·  ');
        return '<div class="item">' +
          '<div class="head">' +
            '<span class="method">' + r.method + '</span>' +
            '<span>' + r.path + '</span>' +
            '<span class="' + statusClass(r.respondedStatus) + '">responded ' + r.respondedStatus + '</span>' +
            '<span class="time">' + r.receivedAt + '</span>' +
          '</div>' +
          '<div class="meta">' + meta + '</div>' +
          '<pre>' + escapeHtml(JSON.stringify(r.body, null, 2)) + '</pre>' +
        '</div>';
      }).join('');
    }
    function escapeHtml(s) { return s.replace(/[&<>]/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;' }[c]; }); }
    async function poll() {
      if (!document.getElementById('auto').checked) return;
      try { render(await (await fetch('/_inbox.json')).json()); } catch (e) {}
    }
    setInterval(poll, 1500);
    poll();
  </script>
</body>
</html>
`;
