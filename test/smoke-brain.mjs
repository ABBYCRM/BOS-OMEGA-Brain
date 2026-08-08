// test/smoke-brain.mjs
// Real OpenAI + BOS-OMEGA Brain layer end-to-end.

import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.log('SKIP: OPENAI_API_KEY not set');
  process.exit(0);
}

const PORT = 12999 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = join(process.cwd(), 'data-brain-' + Date.now());
mkdirSync(DATA_DIR, { recursive: true });

const env = {
  ...process.env,
  PORT: String(PORT),
  LLM_GATEWAY_DATA_DIR: DATA_DIR,
  // v0.1.8 fail-closed startup: production requires AION keys; tests supply them.
  AION_API_KEYS: 'smoke-brain-user-key',
  AION_ADMIN_KEYS: 'smoke-brain-admin-key',
};
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

  // healthz shows v0.1.11
  {
    const r = await fetch(`${BASE}/healthz`);
    const j = await r.json();
    check('healthz v0.1.11', r.ok && j.version === '0.1.11', `version=${j.version}`);
  }

  // brain status
  {
    const r = await fetch(`${BASE}/brain/status`);
    const j = await r.json();
    check('GET /brain/status', r.ok && j.name === 'BOS-OMEGA Brain' && j.version === '0.1.11',
      `name=${j.name} policy=${j.policy?.slice(0, 50)}...`);
  }

  // real chat
  {
    const t = Date.now();
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Reply with the single word BRAIN' }],
        max_tokens: 5,
      }),
    });
    const j = await r.json();
    const content = j.choices?.[0]?.message?.content || '';
    check('real chat', r.ok && /BRAIN/i.test(content),
      `latency=${Date.now()-t}ms content=${JSON.stringify(content).slice(0,40)}`);
  }

  // brain cycle: propose_only
  {
    const t = Date.now();
    const r = await fetch(`${BASE}/brain/audit-and-fix`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apply: false, severities: ['P0', 'P1'] }),
    });
    const j = await r.json();
    check('brain audit-and-fix (propose)',
      r.ok && j.mode === 'propose_only' && Array.isArray(j.proposals),
      `latency=${Date.now()-t}ms proposals=${j.proposals?.length} pre_audit=${j.pre_audit?.status}`);
  }

  // brain cycle: apply
  {
    const r = await fetch(`${BASE}/brain/audit-and-fix`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apply: true, severities: ['P0', 'P1'] }),
    });
    const j = await r.json();
    check('brain audit-and-fix (apply)',
      r.ok && j.mode === 'apply' && Array.isArray(j.applied),
      `applied=${j.applied?.length} post_audit=${j.post_audit?.status}`);
    // every applied patch should be already_applied:true (no hallucination)
    const allVerified = (j.proposals || []).every(p => !p.safe_to_apply || p.patch?.already_applied);
    check('all applied patches are pre-verified (no hallucination)', allVerified,
      `proposals=${j.proposals?.length}`);
  }

  // persist last brain report
  const r = await fetch(`${BASE}/audit`);
  const j = await r.json();
  await writeFile(join(DATA_DIR, 'last-brain-report.json'), JSON.stringify(j, null, 2));
  console.log(`\nlast report saved to ${join(DATA_DIR, 'last-brain-report.json')}`);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed) {
    console.log('--- server log tail ---');
    console.log(serverLog.split('\n').slice(-15).join('\n'));
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
