/**
 * check-stripe-data.js
 *
 * One-off diagnostic to verify whether Stripe customer/payment-method IDs are
 * exposed via the WooCommerce REST API for active subscriptions.
 *
 * Usage:  node check-stripe-data.js
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
const SEP_DOUBLE = '═'.repeat(78);
const SEP_SINGLE = '─'.repeat(78);

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

function printField(label, value) {
  const labelPadded = (label + ':').padEnd(28);
  console.log('  ' + labelPadded + (value === undefined || value === null || value === '' ? '(empty)' : value));
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  header('WooCommerce Subscriptions — Stripe Data Diagnostic');
  console.log('  Site: ' + WC_URL);
  console.log('  Fetching first 3 active subscriptions for inspection...');

  const url = `${WC_URL}/wp-json/wc/v3/subscriptions?status=active&per_page=3&consumer_key=${WC_KEY}&consumer_secret=${WC_SECRET}`;

  let res;
  try {
    res = await httpsGet(url);
  } catch (err) {
    console.error('\nNetwork error: ' + err.message);
    process.exit(1);
  }

  if (res.status === 401) {
    console.error('\nAuthentication failed (HTTP 401). Check WC_KEY and WC_SECRET in .env.');
    process.exit(1);
  }
  if (res.status === 404) {
    console.error('\nEndpoint not found (HTTP 404). Is the WooCommerce Subscriptions plugin REST API active?');
    process.exit(1);
  }
  if (res.status !== 200) {
    console.error(`\nAPI returned status ${res.status}`);
    console.error('Response body:', res.body);
    process.exit(1);
  }

  const subs = res.body;
  if (!Array.isArray(subs)) {
    console.error('\nUnexpected response — expected array, got:');
    console.error(subs);
    process.exit(1);
  }

  console.log(`\n  Received ${subs.length} subscription(s) from API.`);

  // Filter to Stripe-only, exclude PayPal
  const stripeSubs = subs.filter(s => {
    if (isPaypal(s.payment_method, s.payment_method_title)) return false;
    return isStripe(s.payment_method, s.payment_method_title);
  });

  console.log(`  After Stripe-only filter: ${stripeSubs.length} subscription(s).`);

  if (stripeSubs.length === 0) {
    console.log('\n  No Stripe subscriptions in the first page of results.');
    console.log('  Payment methods seen:');
    for (const s of subs) {
      console.log(`    - sub #${s.id}: payment_method="${s.payment_method}", payment_method_title="${s.payment_method_title}"`);
    }
    console.log('\n  Try increasing per_page or filtering server-side. Exiting.');
    process.exit(0);
  }

  if (stripeSubs.length < 3) {
    console.log(`  Note: Fewer than 3 Stripe subs returned in first page — inspecting what we have.`);
  }

  // ── Per-subscription dump ────────────────────────────────────────────────
  for (const s of stripeSubs) {
    subheader(`Subscription #${s.id}`);
    printField('ID', s.id);
    printField('Customer email', s.billing && s.billing.email);
    printField('payment_method', s.payment_method);
    printField('payment_method_title', s.payment_method_title);
    printField('next_payment_date_gmt', s.next_payment_date_gmt);
    printField('total', s.total);
    printField('currency', s.currency);
    printField('billing_period', s.billing_period);
    printField('billing_interval', s.billing_interval);

    console.log('\n  meta_data (full dump):');
    if (!Array.isArray(s.meta_data) || s.meta_data.length === 0) {
      console.log('    (no meta_data returned)');
    } else {
      console.log(`    ${s.meta_data.length} entries:`);
      for (const meta of s.meta_data) {
        let valStr;
        if (typeof meta.value === 'object' && meta.value !== null) {
          valStr = JSON.stringify(meta.value);
        } else {
          valStr = String(meta.value === undefined || meta.value === null ? '' : meta.value);
        }
        // Truncate very long values for readability, but keep IDs intact
        if (valStr.length > 200) valStr = valStr.slice(0, 200) + '... [truncated]';
        const keyPadded = String(meta.key).padEnd(40);
        console.log(`      ${keyPadded} = ${valStr}`);
      }
    }
  }

  // ── Summary: matching meta keys ──────────────────────────────────────────
  header('Summary — Stripe-related meta keys found across all 3 subs');

  const matchTerms = ['stripe', 'customer', 'payment_method', 'source', 'intent', 'card'];
  const matches = [];

  for (const s of stripeSubs) {
    if (!Array.isArray(s.meta_data)) continue;
    for (const meta of s.meta_data) {
      const keyLower = String(meta.key).toLowerCase();
      const matched = matchTerms.find(term => keyLower.includes(term));
      if (matched) {
        matches.push({ subId: s.id, key: meta.key, value: meta.value, matchedTerm: matched });
      }
    }
  }

  if (matches.length === 0) {
    console.log('\n  ⚠  NO matching meta keys found.');
    console.log('  This means Stripe IDs are NOT exposed via the REST API on this install.');
    console.log('  You will likely need direct DB access or a small WP plugin to expose them.');
  } else {
    console.log(`\n  Found ${matches.length} matching meta entries:\n`);
    // Group by sub for readability
    const bySub = {};
    for (const m of matches) {
      if (!bySub[m.subId]) bySub[m.subId] = [];
      bySub[m.subId].push(m);
    }
    for (const subId of Object.keys(bySub)) {
      console.log(`  Sub #${subId}:`);
      for (const m of bySub[subId]) {
        let valStr = typeof m.value === 'object' ? JSON.stringify(m.value) : String(m.value);
        if (valStr.length > 120) valStr = valStr.slice(0, 120) + '... [truncated]';
        console.log(`    [${m.matchedTerm.padEnd(15)}] ${m.key} = ${valStr}`);
      }
      console.log('');
    }

    // Distinct keys summary
    const distinctKeys = [...new Set(matches.map(m => m.key))].sort();
    console.log('  Distinct matching keys (across all subs):');
    for (const k of distinctKeys) {
      console.log(`    - ${k}`);
    }
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
