const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Read .env
const envPath = path.join(__dirname, '.env');
const env = {};
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const match = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
  if (match) env[match[1]] = match[2];
});

const WC_URL = env.WC_URL;
const WC_KEY = env.WC_KEY;
const WC_SECRET = env.WC_SECRET;
const PORT = 3000;

if (!WC_URL || !WC_KEY || !WC_SECRET) {
  console.error('Missing WC_URL, WC_KEY, or WC_SECRET in .env file');
  process.exit(1);
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'WC-Dashboard/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    }).on('error', reject);
  });
}

async function fetchAllSubscriptions(status) {
  const all = [];
  let page = 1;
  while (true) {
    const url = `${WC_URL}/wp-json/wc/v3/subscriptions?status=${status}&per_page=100&page=${page}&consumer_key=${WC_KEY}&consumer_secret=${WC_SECRET}`;
    const res = await httpsGet(url);

    if (res.status === 404) {
      return { error: 'endpoint_not_found', status: 404, message: 'The /wc/v3/subscriptions endpoint returned 404. The WooCommerce Subscriptions plugin REST API may not be active.' };
    }
    if (res.status === 401) {
      return { error: 'auth_failed', status: 401, message: 'Authentication failed. Check your WC_KEY and WC_SECRET in .env.' };
    }
    if (res.status !== 200) {
      return { error: 'api_error', status: res.status, message: `WooCommerce API returned status ${res.status}`, detail: res.body };
    }

    const items = res.body;
    if (!Array.isArray(items)) {
      return { error: 'unexpected_response', message: 'Expected array from API', detail: items };
    }

    all.push(...items);

    const totalPages = parseInt(res.headers['x-wp-totalpages'] || '1', 10);
    if (page >= totalPages) break;
    page++;
  }
  return all;
}

async function fetchExchangeRates() {
  try {
    const res = await httpsGet('https://open.er-api.com/v6/latest/USD');
    if (res.status === 200 && res.body.rates) return res.body.rates;
    return null;
  } catch {
    return null;
  }
}

async function handleSubscriptions(req, res) {
  try {
    const [active, pendingCancel, rates] = await Promise.all([
      fetchAllSubscriptions('active'),
      fetchAllSubscriptions('pending-cancel'),
      fetchExchangeRates()
    ]);

    // Check for errors
    if (active.error) { res.writeHead(active.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(active)); return; }
    if (pendingCancel.error) { res.writeHead(pendingCancel.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(pendingCancel)); return; }

    // Merge and deduplicate by ID
    const seen = new Set();
    const merged = [];
    for (const sub of [...pendingCancel, ...active]) {
      if (!seen.has(sub.id)) {
        seen.add(sub.id);
        merged.push(sub);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ subscriptions: merged, rates }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'server_error', message: err.message }));
  }
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);

  if (parsed.pathname === '/api/subscriptions' && req.method === 'GET') {
    handleSubscriptions(req, res);
    return;
  }

  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    const file = path.join(__dirname, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(500); res.end('Error loading index.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`WC Subscriptions Dashboard running at http://localhost:${PORT}`);
});
