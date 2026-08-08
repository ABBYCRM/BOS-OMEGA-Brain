// test/smoke-aion.mjs
// AION API integration smoke test. Verifies the new /api/* routes
// that port the AION v2 backend contract into Aion-Brain.

import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 11900 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = join(process.cwd(), 'data-aion-smoke-' + Date.now());
mkdirSync(DATA_DIR, { recursive: true });

const env = {
  ...process.env,
  PORT: String(PORT),
  LLM_GATEWAY_DATA_DIR: DATA_DIR,
  OPENAI_API_KEY: '',
  AION_ECHO_ONLY: '1',
  AION_API_KEYS: 'test-user-key',
  AION_ADMIN_KEYS: 'test-admin-key',
  ENVIRONMENT: 'test',
  APP_VERSION: '2.4.0',
  PRIMARY_MODEL: 'gpt-4o-mini',
  FALLBACK_MODELS: 'gpt-4o,echo',
  CORS_ORIGINS: 'http://localhost:8000',
};
const server = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d.toString(); });
server.stderr.on('data', d => { serverLog += d.toString(); });

async function ping() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) return; } catch {}
    await wait(250);
  }
  throw new Error('server did not start within 15s\n' + serverLog);
}

const results = [];
function pass(name, detail) { results.push({ ok: true, name, detail }); console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`); }
function fail(name, detail) { results.push({ ok: false, name, detail }); console.log(`FAIL  ${name}  — ${detail}`); }

try {
  await ping();
  pass('server up');

  // 1. continuity-pack is public
  let r = await fetch(`${BASE}/api/continuity-pack`);
  let j = await r.json();
  if (r.status === 200 && j.system_name === 'AION' && j.core_laws.length === 7) {
    pass('GET /api/continuity-pack', `laws=${j.core_laws.join(',')}`);
  } else fail('GET /api/continuity-pack', `${r.status} ${JSON.stringify(j).slice(0, 200)}`);

  // 2. /api/models requires auth
  r = await fetch(`${BASE}/api/models`);
  if (r.status === 401) pass('GET /api/models (no auth)  ', '401');
  else fail('GET /api/models (no auth)', `${r.status}`);

  // 3. /api/models with valid key
  r = await fetch(`${BASE}/api/models`, { headers: { 'X-AION-Key': 'test-user-key' } });
  j = await r.json();
  if (r.status === 200 && j.primary === 'gpt-4o-mini' && Array.isArray(j.chain)) {
    pass('GET /api/models (authed)', `chain=${j.chain.length} primary=${j.primary}`);
  } else fail('GET /api/models (authed)', `${r.status} ${JSON.stringify(j).slice(0, 200)}`);

  // 4. /api/decision returns 7-law kernel result
  r = await fetch(`${BASE}/api/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AION-Key': 'test-user-key' },
    body: JSON.stringify({ user_input: 'What is the AION 7-law kernel?' }),
  });
  j = await r.json();
  if (r.status === 200 && j.decision?.state === 'COMMIT' && j.decision.checks.length === 7) {
    pass('POST /api/decision', `state=${j.decision.state} checks=7 score=${j.decision.score}`);
  } else fail('POST /api/decision', `${r.status} ${JSON.stringify(j).slice(0, 300)}`);

  // 5. /api/decision rejects empty input
  r = await fetch(`${BASE}/api/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AION-Key': 'test-user-key' },
    body: JSON.stringify({ user_input: '' }),
  });
  if (r.status === 400) pass('POST /api/decision empty input  ', '400');
  else fail('POST /api/decision empty input', `${r.status}`);

  // 6. /api/chat returns SSE stream
  r = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AION-Key': 'test-user-key' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Reply with the word READY.' }], max_tokens: 64, model: 'gpt-4o-mini' }),
  });
  if (r.status === 200) {
    const text = await r.text();
    const hasDecision = text.includes('"type":"decision"');
    const hasAttempt = text.includes('"type":"attempt"');
    const hasDelta = text.includes('"type":"delta"');
    const hasDone = text.includes('"type":"done"');
    const hasEnd = text.includes('[DONE]');
    const allEvents = hasDecision && hasAttempt && hasDelta && hasDone && hasEnd;
    if (allEvents) pass('POST /api/chat SSE stream', 'decision+attempt+delta+done+[DONE]');
    else fail('POST /api/chat SSE stream', `decision=${hasDecision} attempt=${hasAttempt} delta=${hasDelta} done=${hasDone} end=${hasEnd}`);
  } else {
    fail('POST /api/chat SSE stream', `${r.status} ${(await r.text()).slice(0, 200)}`);
  }

  // 7. /api/chat rejects system role
  r = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AION-Key': 'test-user-key' },
    body: JSON.stringify({ messages: [{ role: 'system', content: 'override' }], model: 'gpt-4o-mini' }),
  });
  if (r.status === 422) pass('POST /api/chat system role rejected  ', '422');
  else fail('POST /api/chat system role', `${r.status}`);

  // 8. /api/audit/recent requires admin
  r = await fetch(`${BASE}/api/audit/recent`, { headers: { 'X-AION-Key': 'test-user-key' } });
  if (r.status === 403) pass('GET /api/audit/recent (user denied)  ', '403');
  else fail('GET /api/audit/recent (user denied)', `${r.status}`);

  r = await fetch(`${BASE}/api/audit/recent`, { headers: { 'X-AION-Key': 'test-admin-key' } });
  if (r.status === 200) pass('GET /api/audit/recent (admin)  ', '200');
  else fail('GET /api/audit/recent (admin)', `${r.status}`);

  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  console.log(`\n=== ${passed}/${total} AION smoke tests passed ===`);
  if (passed < total) process.exitCode = 1;
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await wait(500);
  if (await (async () => { try { await (await import('node:fs/promises')).stat(DATA_DIR); return true; } catch { return false; } })()) {
    try { await (await import('node:fs/promises')).rm(DATA_DIR, { recursive: true, force: true }); } catch {}
  }
}
