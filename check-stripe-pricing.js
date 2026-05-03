/**
 * check-stripe-pricing.js
 *
 * Diagnostic to map every distinct (currency, amount, billing_period, billing_interval)
 * combination across all Stripe-paid subscriptions. Each unique combination requires
 * its own Stripe Price object before migrating to Stripe Billing.
 *
 * Usage:  node check-stripe-pricing.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ── Load .env (same pattern as server.js) ──────────────────────────────────
const envPath = path.join(__dirname, '.env');
const env = {};
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const match = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
  if (match) env[match[1]] = match[2];
});

const WC_URL = env.WC_URL;
const WC_KEY = env.WC_KEY;
const WC_SECRET = env.WC_SECRET;

if (!WC_URL || !WC_KEY || !WC_SECRET) {
  console.error('Missing WC_URL, WC_KEY, or WC_SECRET in .env file');
  process.exit(1);
}

// ── httpsGet with redirect-following (same as server.js) ───────────────────
function httpsGet(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    function doRequest(reqUrl, redirectsLeft) {
      const mod = reqUrl.startsWith('https') ? https : require('http');
      mod.get(reqUrl, { headers: { 'User-Agent': 'WC-Diagnostic/1.0' } }, res => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectsLeft <= 0) {
            resolve({ status: res.statusCode, headers: res.headers, body: 'Too many redirects' });
            return;
          }
          const redirectUrl = new URL(res.headers.location, reqUrl).href;
          res.resume();
          doRequest(redirectUrl, redirectsLeft - 1);
          return;
        }
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
    }
    doRequest(url, maxRedirects);
  });
}

// ── Payment normalization (same as dashboard) ──────────────────────────────
function isStripe(method, title) {
  const m = (method || '').toLowerCase();
  const t = (title || '').toLowerCase();
  return m === 'stripe' || t.includes('stripe') || t.includes('crédito') || t.includes('débito');
}

function isPaypal(method, title) {
  const m = (method || '').toLowerCase();
  const t = (title || '').toLowerCase();
  return m === 'paypal' || m.includes('ppcp') || t.includes('paypal');
}

// ── Pretty-printing helpers ────────────────────────────────────────────────
const SEP_DOUBLE = '═'.repeat(82);
const SEP_SINGLE = '─'.repeat(82);

function header(text) {
  console.log('\n' + SEP_DOUBLE);
  console.log('  ' + text);
  console.log(SEP_DOUBLE);
}

function subheader(text) {
  console.log('\n' + SEP_SINGLE);
  console.log('  ' + text);
  console.log(SEP_SINGLE);
}

// ── Fetch all subscriptions for one status ─────────────────────────────────
async function fetchAllSubscriptions(status) {
  const all = [];
  let page = 1;
  while (true) {
    const url = `${WC_URL}/wp-json/wc/v3/subscriptions?status=${status}&per_page=100&page=${page}&consumer_key=${WC_KEY}&consumer_secret=${WC_SECRET}`;
    const res = await httpsGet(url);

    if (res.status === 401) {
      throw new Error('Authentication failed (401). Check WC_KEY and WC_SECRET in .env.');
    }
    if (res.status === 404) {
      throw new Error('Endpoint 404. WC Subscriptions REST API may not be active.');
    }
    if (res.status !== 200) {
      throw new Error(`API status ${res.status}: ${typeof res.body === 'string' ? res.body.slice(0, 200) : JSON.stringify(res.body).slice(0, 200)}`);
    }

    const items = res.body;
    if (!Array.isArray(items)) {
      throw new Error('Unexpected response shape — expected array.');
    }

    all.push(...items);

    const totalPages = parseInt(res.headers['x-wp-totalpages'] || '1', 10);
    process.stdout.write(`    [${status}] page ${page}/${totalPages} → ${items.length} subs (running total: ${all.length})\n`);
    if (page >= totalPages) break;
    page++;
  }
  return all;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  header('WooCommerce Subscriptions — Stripe Pricing Diagnostic');
  console.log('  Site: ' + WC_URL);
  console.log('  Fetching all active + pending-cancel subscriptions...\n');

  let active, pendingCancel;
  try {
    [active, pendingCancel] = await Promise.all([
      fetchAllSubscriptions('active'),
      fetchAllSubscriptions('pending-cancel')
    ]);
  } catch (err) {
    console.error('\nFetch failed: ' + err.message);
    process.exit(1);
  }

  // Merge + deduplicate by ID (same as server.js does)
  const seen = new Set();
  const allSubs = [];
  for (const sub of [...pendingCancel, ...active]) {
    if (!seen.has(sub.id)) {
      seen.add(sub.id);
      allSubs.push(sub);
    }
  }

  console.log(`\n  Total active + pending-cancel subscriptions: ${allSubs.length}`);

  // Filter to Stripe-only
  const stripeSubs = allSubs.filter(s => {
    if (isPaypal(s.payment_method, s.payment_method_title)) return false;
    return isStripe(s.payment_method, s.payment_method_title);
  });

  console.log(`  After Stripe-only filter: ${stripeSubs.length} subscription(s).`);

  if (stripeSubs.length === 0) {
    console.log('\n  No Stripe subscriptions found. Exiting.');
    process.exit(0);
  }

  // ── Group by pricing tuple ───────────────────────────────────────────────
  const groups = {};
  for (const s of stripeSubs) {
    const currency = (s.currency || 'UNKNOWN').toUpperCase();
    const total = parseFloat(s.total || 0).toFixed(2);
    const period = s.billing_period || 'UNKNOWN';
    const interval = s.billing_interval || 'UNKNOWN';
    const status = s.status || 'unknown';

    const key = `${currency}|${total}|${period}|${interval}`;

    if (!groups[key]) {
      groups[key] = {
        currency, total, period, interval,
        count: 0,
        active: 0,
        pendingCancel: 0,
        examples: []
      };
    }

    groups[key].count++;
    if (status === 'pending-cancel') groups[key].pendingCancel++;
    else if (status === 'active') groups[key].active++;

    if (groups[key].examples.length < 3) {
      groups[key].examples.push(s.id);
    }
  }

  // Sort by count descending
  const sortedGroups = Object.values(groups).sort((a, b) => b.count - a.count);

  // ── Print pricing tier table ─────────────────────────────────────────────
  header('Distinct Stripe Pricing Tiers (sorted by count)');
  console.log(`\n  ${sortedGroups.length} unique (currency, amount, period, interval) combinations found.`);
  console.log(`  → You will need ${sortedGroups.length} Stripe Price object(s) in Stripe Billing.\n`);

  for (let i = 0; i < sortedGroups.length; i++) {
    const g = sortedGroups[i];
    console.log(SEP_SINGLE);
    console.log(`  Tier #${i + 1}: ${g.currency} ${g.total} / ${g.period} × ${g.interval}`);
    console.log(`    Total subs:        ${g.count}`);
    console.log(`    Active:            ${g.active}`);
    console.log(`    Pending-cancel:    ${g.pendingCancel}`);
    console.log(`    Example sub IDs:   ${g.examples.join(', ')}`);
  }

  // ── Total Stripe subs ────────────────────────────────────────────────────
  header('Stripe Subs Total');
  console.log(`\n  Stripe subs found (active + pending-cancel): ${stripeSubs.length}`);
  console.log(`  Expected (per dashboard, ~216 annual + ~15 monthly): ~231`);
  const stripeActive = stripeSubs.filter(s => s.status === 'active').length;
  const stripePC = stripeSubs.filter(s => s.status === 'pending-cancel').length;
  console.log(`    Active:           ${stripeActive}`);
  console.log(`    Pending-cancel:   ${stripePC}`);

  // ── Distinct currencies ──────────────────────────────────────────────────
  header('Distinct Currencies');
  const byCurrency = {};
  for (const s of stripeSubs) {
    const c = (s.currency || 'UNKNOWN').toUpperCase();
    byCurrency[c] = (byCurrency[c] || 0) + 1;
  }
  const currencyList = Object.entries(byCurrency).sort((a, b) => b[1] - a[1]);
  console.log('');
  for (const [cur, count] of currencyList) {
    console.log(`    ${cur.padEnd(8)} → ${count} sub(s)`);
  }

  // ── Anomalies ────────────────────────────────────────────────────────────
  header('Anomalies (need manual review)');

  const zeroTotal = stripeSubs.filter(s => parseFloat(s.total || 0) === 0);
  const missingPeriod = stripeSubs.filter(s => !s.billing_period);
  const oddInterval = stripeSubs.filter(s => {
    const i = s.billing_interval;
    return i !== undefined && i !== null && String(i) !== '1';
  });

  console.log(`\n  Subs with total = 0:                 ${zeroTotal.length}`);
  if (zeroTotal.length > 0) {
    for (const s of zeroTotal.slice(0, 10)) {
      const email = (s.billing && s.billing.email) || '(no email)';
      console.log(`    - sub #${s.id}: ${s.currency} ${s.total} / ${s.billing_period} × ${s.billing_interval}  [${email}]`);
    }
    if (zeroTotal.length > 10) console.log(`    ... and ${zeroTotal.length - 10} more`);
  }

  console.log(`\n  Subs with missing billing_period:    ${missingPeriod.length}`);
  if (missingPeriod.length > 0) {
    for (const s of missingPeriod.slice(0, 10)) {
      const email = (s.billing && s.billing.email) || '(no email)';
      console.log(`    - sub #${s.id}: ${s.currency} ${s.total}  [${email}]`);
    }
    if (missingPeriod.length > 10) console.log(`    ... and ${missingPeriod.length - 10} more`);
  }

  console.log(`\n  Subs with billing_interval != 1:     ${oddInterval.length}`);
  if (oddInterval.length > 0) {
    for (const s of oddInterval.slice(0, 10)) {
      const email = (s.billing && s.billing.email) || '(no email)';
      console.log(`    - sub #${s.id}: ${s.currency} ${s.total} / ${s.billing_period} × ${s.billing_interval}  [${email}]`);
    }
    if (oddInterval.length > 10) console.log(`    ... and ${oddInterval.length - 10} more`);
  }

  if (zeroTotal.length === 0 && missingPeriod.length === 0 && oddInterval.length === 0) {
    console.log('\n  ✓ No anomalies — every Stripe sub has a clean (currency, amount, period, interval=1).');
  }

  console.log('\n' + SEP_DOUBLE);
  console.log('  Diagnostic complete.');
  console.log(SEP_DOUBLE + '\n');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
