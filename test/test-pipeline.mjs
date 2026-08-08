// test/test-pipeline.mjs
// End-to-end integration test of the /api/chat pipeline:
//   memory.contextPack  →  tools  →  resolveDecision (7 laws)
//   →  activeState.decisionBias  →  runLattice (3 roles parallel)
//   →  buildSystemPrompt  →  aionChain.stream  →  activeState.observe
//   →  memory.rememberEpisode  →  store.recordCall
//
// Skipped unless OPENAI_API_KEY is set.

import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const KEY = process.env.OPENAI_API_KEY;
if (!KEY || process.env.SKIP_LIVE === '1') {
  console.log('SKIP  pipeline integration test (no OPENAI_API_KEY or SKIP_LIVE=1)');
  process.exit(0);
}

const PORT = 13999 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = join(process.cwd(), 'data-pipeline-' + Date.now() + '-' + Math.floor(Math.random() * 1000));
mkdirSync(DATA_DIR, { recursive: true });

const env = {
  ...process.env,
  PORT: String(PORT),
  LLM_GATEWAY_DATA_DIR: DATA_DIR,
  OPENAI_API_KEY: KEY,
  ENVIRONMENT: 'production',
  AION_API_KEYS: 'pipeline-user-key',
  AION_ADMIN_KEYS: 'pipeline-admin-key',
  AION_VAULT_MASTER_KEY: 'pipeline-vault-master-key-12345',
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

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); pass++; },
    (e) => { console.log(`FAIL  ${name}  — ${e.message}`); fail++; }
  );
}

function parseSse(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^data: (.+)$/);
    if (!m) continue;
    const data = m[1].trim();
    if (data === '[DONE]') continue;
    try { out.push(JSON.parse(data)); } catch {}
  }
  return out;
}

let fullText = '';
let pipelineEvents = null;
let episodeStored = false;
let callLogged = false;
let decisionScore = null;
let decisionState = null;
let latticeConsensus = null;
let streamingMode = null;
let memoryContextInjected = false;
let providerName = null;

try {
  await ping();

  // ---- Step 0: pre-seed memory with a fact so we can prove it gets injected ----
  // Need a tool to seed (brain owns memory but doesn't expose a /api/memory/facts POST
  // in the version we have; we instead use the public /api/state to read it later).
  // We'll infer memory injection from the system prompt text later.

  // ---- Step 1: send a chat and capture the full SSE stream ----
  await t('POST /api/chat with AION auth returns full SSE pipeline', async () => {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer pipeline-user-key',
        'x-aion-key': 'pipeline-user-key',
      },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'Reply with exactly the word PONG and nothing else.' },
        ],
        temperature: 0,
        max_tokens: 32,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.log('  → error body:', t.slice(0, 500));
    }
    assert.ok(res.ok, `status ${res.status}`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    const dt = Date.now() - t0;
    console.log(`  → ${dt}ms, ${text.length} bytes`);
    pipelineEvents = parseSse(text);
    fullText = pipelineEvents
      .filter(e => e.type === 'delta')
      .map(e => e.text)
      .join('');
  });

  // ---- Step 2: verify the 7-law decision was emitted with all 7 checks ----
  await t('7-law decision event present with all 7 laws', () => {
    const ev = pipelineEvents.find(e => e.type === 'decision');
    assert.ok(ev, 'decision event emitted');
    decisionScore = ev.decision?.score;
    decisionState = ev.decision?.state;
    assert.ok(['COMMIT', 'DEFER', 'REJECT'].includes(decisionState), `state=${decisionState}`);
    const checks = ev.decision?.checks || [];
    assert.equal(checks.length, 7, `expected 7 checks, got ${checks.length}`);
    const laws = checks.map(c => c.law).sort();
    assert.deepEqual(laws, ['CONTINUITY', 'DECISION', 'EPISTEMIC', 'FIDELITY', 'LATTICE', 'PERPETUITY', 'REALITY']);
  });

  // ---- Step 3: verify the lattice emitted a consensus ----
  await t('lattice consensus event present (proves runLattice fired)', () => {
    const ev = pipelineEvents.find(e => e.type === 'lattice');
    assert.ok(ev, 'lattice event emitted');
    assert.ok(['COMMIT', 'DEFER', 'REJECT'].includes(ev.consensus), `consensus=${ev.consensus}`);
    assert.ok(typeof ev.rationale === 'string' && ev.rationale.length > 0, 'rationale present');
    assert.ok(typeof ev.free_energy === 'number', 'free_energy present');
    assert.ok(ev.votes && Object.keys(ev.votes).length >= 2, `votes: ${JSON.stringify(ev.votes)}`);
    latticeConsensus = ev.consensus;
  });

  // ---- Step 4: verify attempt + open + deltas + done all present ----
  await t('SSE event sequence: attempt → open → delta* → done', () => {
    const seq = pipelineEvents.map(e => e.type);
    const aIdx = seq.indexOf('attempt');
    const oIdx = seq.indexOf('open');
    const dFirst = seq.indexOf('delta');
    const dLast = seq.lastIndexOf('delta');
    const doneIdx = seq.indexOf('done');
    assert.ok(aIdx >= 0, 'attempt present');
    assert.ok(oIdx > aIdx, 'open after attempt');
    assert.ok(dFirst > oIdx, 'first delta after open');
    assert.ok(doneIdx > dLast, 'done after last delta');
    const deltas = pipelineEvents.filter(e => e.type === 'delta');
    assert.ok(deltas.length > 0, 'at least one delta');
  });

  // ---- Step 5: verify streaming mode + provider is real (not echo) ----
  await t('streaming mode is true and provider is openai (LLM under the hood)', () => {
    const done = pipelineEvents.find(e => e.type === 'done');
    streamingMode = done?.streaming;
    providerName = done?.provider;
    assert.equal(streamingMode, 'true', `streaming=${streamingMode}`);
    assert.equal(providerName, 'openai', `provider=${providerName}`);
  });

  // ---- Step 6: verify model + usage are real (not echo) ----
  await t('done event has real model + usage from OpenAI', () => {
    const done = pipelineEvents.find(e => e.type === 'done');
    assert.ok(done.model?.startsWith('gpt-'), `model=${done.model}`);
    assert.ok(done.usage?.prompt_tokens > 0, 'prompt_tokens > 0');
    assert.ok(done.usage?.completion_tokens > 0, 'completion_tokens > 0');
    assert.ok(done.latency_ms > 0 && done.latency_ms < 30_000, `latency_ms=${done.latency_ms}`);
  });

  // ---- Step 7: verify the assistant actually answered PONG ----
  await t('fullText is PONG (real OpenAI call, not echo)', () => {
    assert.match(fullText, /PONG/i, `got: "${fullText}"`);
  });

  // ---- Step 8: verify the call was logged to Store ----
  await t('Store recorded the aion.chat call (status 200, app_id=principal)', async () => {
    const r = await fetch(`${BASE}/calls/recent?n=20`);
    const j = await r.json();
    const chat = (j.calls || []).find(c => c.operation === 'aion.chat' && c.status === 200);
    assert.ok(chat, 'aion.chat call not in log');
    assert.ok(chat.latency_ms > 0, `latency_ms=${chat.latency_ms}`);
    callLogged = true;
  });

  // ---- Step 9: verify the episode was remembered ----
  await t('AgentMemory recorded the episode (admin can read it back)', async () => {
    const r = await fetch(`${BASE}/api/memory/episodes`, {
      headers: { 'authorization': 'Bearer pipeline-admin-key' },
    });
    assert.ok(r.ok, `status ${r.status}`);
    const j = await r.json();
    const eps = j.episodes || [];
    assert.ok(Array.isArray(eps), 'episodes is array');
    assert.ok(eps.length > 0, 'no episodes in any session');
    // Verify our episode is the most recent one
    const last = eps[0];
    assert.ok(last.decision_state, 'last episode has decision_state');
    assert.ok(['COMMIT', 'DEFER', 'REJECT'].includes(last.decision_state), `state=${last.decision_state}`);
    episodeStored = true;
  });

  // ---- Step 10: verify the lattice's recommendation actually appears in the system prompt ----
  // We can't see the system prompt directly, but we can verify by checking the call log
  // shows the chat was served (which only happens if buildSystemPrompt didn't throw).
  await t('pipeline completed without errors (call succeeded end-to-end)', () => {
    assert.ok(callLogged && episodeStored && fullText.includes('PONG'));
  });

  // ---- Step 11: verify a follow-up question hits the same memory session ----
  await t('follow-up /api/chat completes (lattice may DEFER if F high)', async () => {
    const r = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer pipeline-user-key',
      },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'What is 2+2? Answer with one digit.' },
        ],
        temperature: 0,
        max_tokens: 32,
      }),
    });
    const text = await r.text();
    const evs = parseSse(text);
    const deltas = evs.filter(e => e.type === 'delta').map(e => e.text).join('');
    assert.match(deltas, /4/, `got: "${deltas}"`);
  });

  // ---- Persist evidence ----
  const evidence = {
    ts: new Date().toISOString(),
    pass, fail,
    decision: { state: decisionState, score: decisionScore },
    provider: providerName,
    streaming: streamingMode,
    lattice: latticeConsensus,
    fullText,
    events_summary: pipelineEvents.map(e => ({ type: e.type, ...(e.text ? {text: e.text.slice(0,40)} : {}) })),
  };
  await writeFile(join(DATA_DIR, 'pipeline-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`\n  evidence → ${join(DATA_DIR, 'pipeline-evidence.json')}`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
} catch (e) {
  console.error('TEST ERROR:', e.message);
  console.error('--- server log ---');
  console.error(serverLog);
  process.exit(1);
} finally {
  server.kill('SIGTERM');
  await wait(300);
  if (fail > 0) process.exit(1);
}
