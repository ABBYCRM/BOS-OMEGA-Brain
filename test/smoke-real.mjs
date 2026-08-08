// test/smoke-real.mjs
// Real OpenAI smoke. Requires OPENAI_API_KEY env. Skipped if not set.

import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.log('SKIP: OPENAI_API_KEY not set. Run with: OPENAI_API_KEY=sk-... node test/smoke-real.mjs');
  process.exit(0);
}

const PORT = 11999 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = join(process.cwd(), 'data-real-' + Date.now());
mkdirSync(DATA_DIR, { recursive: true });

const env = { ...process.env, PORT: String(PORT), LLM_GATEWAY_DATA_DIR: DATA_DIR };
const server = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => serverLog += d.toString());
server.stderr.on('data', d => serverLog += d.toString());

async function ping() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) return; } catch {}
    await wait(200);
  }
  throw new Error('server did not start');
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`PASS  ${name}  — ${detail || ''}`); passed++; }
  else { console.log(`FAIL  ${name}  — ${detail || ''}`); failed++; }
}

try {
  await ping();

  // /healthz
  {
    const r = await fetch(`${BASE}/healthz`);
    const j = await r.json();
    check('healthz', r.ok && j.ok, `uptime=${j.uptime_s}s`);
  }

  // real chat
  {
    const t = Date.now();
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }],
        max_tokens: 10,
      }),
    });
    const dt = Date.now() - t;
    const j = await r.json();
    if (!r.ok) console.log('chat error body:', JSON.stringify(j).slice(0, 500));
    const content = j.choices?.[0]?.message?.content || '';
    check('real chat', r.ok && /PONG/i.test(content),
      `latency=${dt}ms provider=${j._meta?.provider} model=${j.model} content=${JSON.stringify(content).slice(0,80)}`);
  }

  // audit run with real self-ping
  {
    const t = Date.now();
    const r = await fetch(`${BASE}/audit/run`, { method: 'POST' });
    const dt = Date.now() - t;
    const j = await r.json();
    check('audit run', r.ok, `latency=${dt}ms status=${j.status} p0=${j.p0_count} p1=${j.p1_count} verified=${j.verified_fixes}`);
    check('audit health baseline populated', (j.phases?.phase1_baseline?.health_p50 || 0) > 0,
      `p50=${j.phases?.phase1_baseline?.health_p50}ms p95=${j.phases?.phase1_baseline?.health_p95}ms`);
  }

  // calls/recent
  {
    const r = await fetch(`${BASE}/calls/recent?n=5`);
    const j = await r.json();
    const real = (j.calls || []).filter(c => c.provider === 'openai' && c.operation === 'chat' && c.status === 200);
    check('call log shows real call', real.length > 0, `count=${real.length} latency=${real[0]?.latency_ms}ms`);
  }

  // stats
  {
    const r = await fetch(`${BASE}/stats`);
    const j = await r.json();
    const openaiChat = (j.stats || []).find(s => s.provider === 'openai' && s.operation === 'chat');
    check('stats aggregate', openaiChat && openaiChat.n > 0,
      `n=${openaiChat?.n} avg=${openaiChat?.avg_latency?.toFixed(0)}ms`);
  }

  // save report
  const reportFile = join(DATA_DIR, 'last-real-report.json');
  const lastR = await fetch(`${BASE}/audit`);
  const last = await lastR.json();
  writeFile(reportFile, JSON.stringify(last, null, 2));
  console.log(`\nlast audit report saved to ${reportFile}`);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed) {
    console.log('--- server log tail ---');
    console.log(serverLog.split('\n').slice(-10).join('\n'));
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
