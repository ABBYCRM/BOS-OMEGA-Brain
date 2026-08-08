// test/smoke.mjs
// End-to-end smoke. Spins up the server in-process, hits every route, prints evidence.

import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 10999 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = join(process.cwd(), 'data-smoke-' + Date.now() + '-' + Math.floor(Math.random() * 1000));

mkdirSync(DATA_DIR, { recursive: true });

const env = {
  ...process.env,
  PORT: String(PORT),
  LLM_GATEWAY_DATA_DIR: DATA_DIR,
  // Hermetic: strip all real LLM keys so the server uses EchoProvider.
  OPENAI_API_KEY: '',
  OPENAI_API_KEY_NOVALUIS: '',
  ANTHROPIC_API_KEY: '',
  A2E_API_KEY: '',
  // v0.1.8 fail-closed startup: supply test AION keys so the server boots.
  AION_API_KEYS: 'smoke-user-key',
  AION_ADMIN_KEYS: 'smoke-admin-key',
};
const server = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d.toString(); });
server.stderr.on('data', d => { serverLog += d.toString(); });

async function ping() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {}
    await wait(200);
  }
  throw new Error('server did not start within 10s');
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ? '— ' + detail : ''}`);
}

try {
  await ping();
  record('server up', true);

  // 1. healthz
  {
    const r = await fetch(`${BASE}/healthz`);
    const j = await r.json();
    record('GET /healthz', r.ok && j.ok === true, `uptime=${j.uptime_s}s`);
  }

  // 2. root
  {
    const r = await fetch(`${BASE}/`);
    const j = await r.json();
    record('GET /', r.ok && j.name === 'llm-gateway', `providers=${j.providers?.join(',')}`);
  }

  // 3. chat completions (echo provider)
  {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const j = await r.json();
    record('POST /v1/chat/completions', r.ok && j.choices?.[0]?.message?.content?.startsWith('[echo:chat]'),
      `provider=${j._meta?.provider} model=${j.model}`);
  }

  // 4. image gen (echo)
  {
    const r = await fetch(`${BASE}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a cat' }),
    });
    // Echo only supports chat, so this should 502 — but the route must exist
    const j = await r.json().catch(() => ({}));
    record('POST /v1/images/generations (route exists)', r.status === 502 || r.ok, `status=${r.status}`);
  }

  // 5. video (echo)
  {
    const r = await fetch(`${BASE}/v1/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sora-2', prompt: 'a dog' }),
    });
    record('POST /v1/videos (route exists)', r.status === 502 || r.ok, `status=${r.status}`);
  }

  // 6. audit quick
  {
    const r = await fetch(`${BASE}/audit/quick`);
    const j = await r.json();
    record('GET /audit/quick', r.ok, `status=${j.status} files=${j.inventory_files}`);
  }

  // 7. audit full
  {
    const r = await fetch(`${BASE}/audit/run`, { method: 'POST' });
    const j = await r.json();
    record('POST /audit/run', r.ok && (j.status === 'VERIFIED_COMPLETE' || j.status === 'PARTIAL' || j.status === 'BLOCKED'),
      `status=${j.status} P0=${j.p0_count} P1=${j.p1_count} P2=${j.p2_count} verified=${j.verified_fixes} unverified=${j.unverified_fixes}`);
  }

  // 8. audit read-back
  {
    const r = await fetch(`${BASE}/audit`);
    const j = await r.json();
    record('GET /audit (last report)', r.ok && (j.status || j.status === null), `status=${j.status}`);
  }

  // 9. calls recent
  {
    const r = await fetch(`${BASE}/calls/recent?n=10`);
    const j = await r.json();
    record('GET /calls/recent', r.ok && Array.isArray(j.calls), `count=${j.calls?.length}`);
  }

  // 10. stats
  {
    const r = await fetch(`${BASE}/stats`);
    const j = await r.json();
    record('GET /stats', r.ok && Array.isArray(j.stats), `groups=${j.stats?.length}`);
  }

  // 11. request-id round-trip
  {
    const r = await fetch(`${BASE}/healthz`, { headers: { 'x-request-id': 'smoke-test-123' } });
    const echoed = r.headers.get('x-request-id');
    record('request-id propagated', echoed === 'smoke-test-123', `echoed=${echoed}`);
  }

  // 12. CORS preflight
  {
    const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'OPTIONS' });
    const allow = r.headers.get('access-control-allow-origin');
    record('CORS preflight', r.status === 204 && allow === '*', `allow-origin=${allow}`);
  }

  // 13. large body rejected (DoS guard)
  {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: huge }] }),
    });
    record('body size limit enforced', r.status === 413 || r.status === 400, `status=${r.status}`);
  }

  console.log('\n--- server log tail ---');
  console.log(serverLog.split('\n').slice(-15).join('\n'));

  const failed = results.filter(r => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
} catch (e) {
  console.error('SMOKE ERROR:', e.message);
  console.error(serverLog);
  process.exit(1);
} finally {
  server.kill('SIGTERM');
  await wait(200);
}
