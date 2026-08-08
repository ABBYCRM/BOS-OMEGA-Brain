// test/contract-aion-modules.mjs
// Verifies the new AION modules are importable and the kernel decision
// shape matches the AION v2 FastAPI backend contract.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AION_CONTINUITY_PACK, MissionContext, buildSystemPrompt, resolveDecision, DecisionState } from '../lib/aion_kernel.js';
import { AionChain } from '../lib/aion_chain.js';
import { aionSettings } from '../lib/aion_settings.js';

// Live brain URL for integration tests. Set BRAIN_URL to point at a different host.
const BRAIN = process.env.BRAIN_URL || 'http://localhost:10001';
const BRAIN_KEY = process.env.BRAIN_KEY || 'test-brain-key';

test('AION continuity pack has 7 laws + 3 decision states', () => {
  assert.equal(AION_CONTINUITY_PACK.system_name, 'AION');
  assert.equal(AION_CONTINUITY_PACK.core_laws.length, 7);
  assert.deepEqual(AION_CONTINUITY_PACK.decision_states, ['COMMIT', 'DEFER', 'REJECT']);
  assert.ok(AION_CONTINUITY_PACK.core_laws.includes('Reality'));
  assert.ok(AION_CONTINUITY_PACK.core_laws.includes('Decision'));
});

test('DecisionState enum matches the AION v2 backend', () => {
  assert.equal(DecisionState.COMMIT, 'COMMIT');
  assert.equal(DecisionState.DEFER, 'DEFER');
  assert.equal(DecisionState.REJECT, 'REJECT');
});

test('resolveDecision returns 7 checks + score + state', () => {
  const ctx = new MissionContext({ userInput: 'hello' });
  const d = resolveDecision(ctx);
  assert.equal(d.state, 'COMMIT');
  assert.equal(d.checks.length, 7);
  assert.ok(d.score >= 0 && d.score <= 1);
  assert.match(d.id, /^dec_/);
  assert.equal(typeof d.protocol, 'object');
  assert.equal(d.protocol.reversibility_check, true);
});

test('resolveDecision DEFERs when tool requested but no evidence', () => {
  const ctx = new MissionContext({ userInput: 'x', metadata: { webSearch: true } });
  const d = resolveDecision(ctx);
  assert.equal(d.state, 'DEFER');
  assert.equal(d.score, 0.25);
});

test('buildSystemPrompt injects law checks + tool/notes contexts', () => {
  const ctx = new MissionContext({ userInput: 'x' });
  const d = resolveDecision(ctx);
  const prompt = buildSystemPrompt(d, {
    toolContext: '<tool_results type="web_search">fake</tool_results>',
    notesContext: '<operator_notes>fake</operator_notes>',
  });
  assert.match(prompt, /AION/);
  assert.match(prompt, /REALITY/);
  assert.match(prompt, /tool_results/);
  assert.match(prompt, /operator_notes/);
  assert.match(prompt, /never.*higher-priority/i);
});

test('MissionContext.fingerprint is stable for same input', () => {
  const a = new MissionContext({ userInput: 'hello', history: [{ role: 'user', content: 'hi' }] });
  const b = new MissionContext({ userInput: 'hello', history: [{ role: 'user', content: 'hi' }] });
  assert.equal(a.fingerprint(), b.fingerprint());
});

test('AionChain.fromEnv honors AION_ECHO_ONLY', () => {
  const prev = process.env.AION_ECHO_ONLY;
  process.env.AION_ECHO_ONLY = '1';
  const chain = AionChain.fromEnv({ appId: 'test' });
  assert.equal(chain.providers.length, 1);
  assert.equal(chain.providers[0].name, 'echo');
  process.env.AION_ECHO_ONLY = prev;
});

test('aionSettings is frozen-ish and exposes AION keys', () => {
  assert.ok(Array.isArray(aionSettings.apiKeys));
  assert.ok(Array.isArray(aionSettings.adminKeys));
  assert.match(aionSettings.primaryModel, /^[a-z0-9./-]+$/);
});

test('Aion-Brain exposes /api/state for AION integration', async () => {
  const r = await fetch(`${BRAIN}/api/state`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.app, 'aion-brain');
  assert.ok(Array.isArray(body.providers));
  assert.equal(body.continuity_pack.laws.length, 7);
  assert.deepEqual(body.continuity_pack.states, ['COMMIT', 'DEFER', 'REJECT']);
});

test('Aion-Brain exposes /api/tools catalog', async () => {
  const r = await fetch(`${BRAIN}/api/tools`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  const names = body.tools.map(t => t.name);
  assert.ok(names.includes('echo'));
  assert.ok(names.includes('datetime'));
  assert.ok(names.includes('free_energy'));
});

test('Aion-Brain runs tools via POST /api/tools/:name', async () => {
  // echo
  let r = await fetch(`${BRAIN}/api/tools/echo`, {
    method: 'POST',
    headers: { 'X-AION-Key': BRAIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hello from aion' }),
  });
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.evidence.text, 'hello from aion');
  // datetime
  r = await fetch(`${BRAIN}/api/tools/datetime`, { method: 'POST', headers: { 'X-AION-Key': BRAIN_KEY } });
  body = await r.json();
  assert.equal(body.ok, true);
  assert.match(body.evidence.iso, /^\d{4}-\d{2}-\d{2}T/);
  // unknown tool
  r = await fetch(`${BRAIN}/api/tools/nope`, { method: 'POST', headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(r.status, 404);
});

test('Aion-Brain /api/tools requires auth', async () => {
  const r = await fetch(`${BRAIN}/api/tools`);
  assert.equal(r.status, 401);
});

test('Aion-Brain /api/state requires auth', async () => {
  const r = await fetch(`${BRAIN}/api/state`);
  assert.equal(r.status, 401);
});
