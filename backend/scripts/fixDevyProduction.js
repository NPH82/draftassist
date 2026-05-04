/**
 * fixDevyProduction.js
 *
 * Logs into the production backend using your Sleeper username, then:
 *   1. Directly restores wrongly-cleared 2026-class players (no NFL team in DB)
 *   2. POST /api/admin/fix-devy-flags  — clears past-class and team-confirmed graduates
 *   3. POST /api/admin/refresh/devy-rankings/sync — re-imports and sweeps
 *
 * Usage:
 *   node scripts/fixDevyProduction.js <sleeper-username>
 */

const https = require('https');
const mongoose = require('mongoose');

const BASE_URL = 'https://draftassist.onrender.com';
const username = process.argv[2];

if (!username) {
  console.error('Usage: node scripts/fixDevyProduction.js <sleeper-username>');
  process.exit(1);
}

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 120000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  // ── Step 0: Restore wrongly-cleared 2026-class players directly in MongoDB ─
  console.log('\n[0/3] Restoring wrongly-cleared devyClass=2026 players (no NFL team) ...');
  require('dotenv').config();
  const connectDB = require('../src/config/db');
  const Player = require('../src/models/Player');
  await connectDB();

  // These were cleared with isDevy=false but have devyClass=2026 and no team —
  // they are still college players, not NFL draftees.
  const restoreResult = await Player.updateMany(
    {
      isDevy: false,
      devyClass: 2026,
      $or: [{ team: null }, { team: '' }, { team: { $exists: false } }],
    },
    { $set: { isDevy: true, lastUpdated: new Date() } }
  );
  console.log(`      ✓ Restored isDevy=true for ${restoreResult.modifiedCount} undrafted 2026-class players`);
  await mongoose.disconnect();

  // ── Step 1: Login ─────────────────────────────────────────────────────────
  console.log(`\n[1/3] Logging in as "${username}" ...`);
  const loginRes = await request('POST', '/api/auth/login', { username });
  if (loginRes.status !== 200) {
    console.error('Login failed:', loginRes.status, loginRes.body);
    process.exit(1);
  }
  const token = loginRes.body.token;
  console.log(`      ✓ Authenticated as ${loginRes.body.user?.displayName || username}`);

  // ── Step 2: fix-devy-flags ────────────────────────────────────────────────
  console.log('\n[2/3] Running fix-devy-flags ...');
  const flagsRes = await request('POST', '/api/admin/fix-devy-flags', null, token);
  if (flagsRes.status !== 200) {
    console.error('fix-devy-flags failed:', flagsRes.status, flagsRes.body);
    process.exit(1);
  }
  const { kept, cleared, sample } = flagsRes.body;
  console.log(`      ✓ ${kept} kept, ${cleared} cleared`);
  if (cleared > 0) console.log('      Cleared:', sample?.join(', ') || '(none listed)');

  // ── Step 3: refresh/devy-rankings/sync ───────────────────────────────────
  console.log('\n[3/3] Running devy rankings refresh + graduation sweep (may take ~90s) ...');
  const refreshRes = await request('POST', '/api/admin/refresh/devy-rankings/sync', null, token);
  if (refreshRes.status !== 200) {
    console.error('refresh/devy-rankings/sync failed:', refreshRes.status, refreshRes.body);
    process.exit(1);
  }
  const r = refreshRes.body;
  console.log(`      ✓ created=${r.created} updated=${r.updated} deduped=${r.deduped} graduated=${r.graduated}`);
  console.log('      Sources:', JSON.stringify(r.sources, null, 2).replace(/\n/g, '\n      '));

  console.log('\n✅ Done. Devy pool is clean.\n');
})().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
