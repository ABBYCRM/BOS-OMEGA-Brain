// test/test-streaming.mjs
// Regression: true token-level streaming, not simulated.
// 1. Offline: feed a fake SSE response to OpenAIProvider.streamChat and assert
//    that the deltas arrive in the order the upstream produced them, with the
//    real text content, and a `done` event at the end with usage.
// 2. Offline: same for AnthropicProvider.streamChat (Anthropic event format).
// 3. Live: if OPENAI_API_KEY is set, hit real OpenAI and assert
//    `done.streaming === 'true'` (proves the chain used the true path).

import { OpenAIProvider, AnthropicProvider } from '../lib/router.js';
import { AionChain } from '../lib/aion_chain.js';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); pass++; },
    (e) => { console.log(`FAIL  ${name}  — ${e.message}`); fail++; }
  );
}

// Fake SSE body built from a list of events
function makeSseBody(events) {
  // OpenAI format: "data: {...}\n\n"
  return events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function makeAnthropicBody(events) {
  // Anthropic format: "event: <type>\ndata: {...}\n\n"
  return events.map(({event, data}) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

class FakeReader {
  constructor(chunks) { this.chunks = chunks; this.i = 0; }
  async read() {
    if (this.i >= this.chunks.length) return { done: true, value: undefined };
    const v = this.chunks[this.i++];
    return { done: false, value: new TextEncoder().encode(v) };
  }
}

// Build a body that exposes getReader() the way fetch() does in Node 18+.
function fakeBody(chunks) {
  const reader = new FakeReader(chunks);
  return { getReader: () => reader };
}

function fakeFetchWithSse(body) {
  return async () => ({
    ok: true,
    status: 200,
    body: fakeBody([body]),
  });
}

// ---- OpenAI ----

await t('OpenAIProvider.streamChat: yields deltas in order from SSE', async () => {
  const provider = new OpenAIProvider({ apiKey: 'sk-test' });
  const body = makeSseBody([
    { id: '1', object: 'chat.completion.chunk', model: 'gpt-4o-mini', choices: [{ delta: { content: 'Hello' }, index: 0 }] },
    { id: '2', object: 'chat.completion.chunk', model: 'gpt-4o-mini', choices: [{ delta: { content: ' world' }, index: 0 }] },
    { id: '3', object: 'chat.completion.chunk', model: 'gpt-4o-mini', choices: [{ delta: {} , index: 0 }] },
    { id: '4', object: 'chat.completion.chunk', model: 'gpt-4o-mini', choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    { model: 'gpt-4o-mini', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
  ]);
  const events = [];
  for await (const ev of provider.streamChat({ payload: { model: 'gpt-4o-mini', messages: [{role:'user', content:'hi'}] }, fetchImpl: fakeFetchWithSse(body) })) {
    events.push(ev);
  }
  const deltas = events.filter(e => e.type === 'delta').map(e => e.text);
  assert.deepEqual(deltas, ['Hello', ' world']);
  const done = events.find(e => e.type === 'done');
  assert.ok(done, 'has done');
  assert.equal(done.finish_reason, 'stop');
  assert.equal(done.model, 'gpt-4o-mini');
  assert.equal(done.usage.completion_tokens, 2);
});

await t('OpenAIProvider.streamChat: keeps partial line in buffer until next chunk', async () => {
  const provider = new OpenAIProvider({ apiKey: 'sk-test' });
  const fullBody = makeSseBody([
    { choices: [{ delta: { content: 'token-1' }, index: 0 }] },
    { choices: [{ delta: { content: 'token-2' }, index: 0 }] },
  ]);
  const half = Math.floor(fullBody.length / 2);
  const fetchImpl = async () => ({ ok: true, status: 200, body: fakeBody([fullBody.slice(0, half), fullBody.slice(half)]) });
  const deltas = [];
  for await (const ev of provider.streamChat({ payload: { model: 'm', messages: [] }, fetchImpl })) {
    if (ev.type === 'delta') deltas.push(ev.text);
  }
  assert.deepEqual(deltas, ['token-1', 'token-2']);
});

await t('OpenAIProvider.streamChat: error on non-2xx response', async () => {
  const provider = new OpenAIProvider({ apiKey: 'sk-test' });
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  let caught = null;
  try {
    for await (const ev of provider.streamChat({ payload: { model: 'm', messages: [] }, fetchImpl })) { /* */ }
  } catch (e) { caught = e; }
  assert.ok(caught, 'threw');
  assert.equal(caught.status, 401);
  assert.equal(caught.code, 'http_401');
});

// ---- Anthropic ----

await t('AnthropicProvider.streamChat: parses message_start / content_block_delta / message_stop', async () => {
  const provider = new AnthropicProvider({ apiKey: 'sk-ant-test' });
  const body = makeAnthropicBody([
    { event: 'message_start', data: { type: 'message_start', message: { model: 'claude-3-5-sonnet-latest', usage: { input_tokens: 10, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'ping', data: { type: 'ping' } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
  const fetchImpl = async () => ({ ok: true, status: 200, body: fakeBody([body]) });
  const events = [];
  for await (const ev of provider.streamChat({ payload: { model: 'claude-3-5-sonnet-latest', messages: [{role:'user', content:'hi'}] }, fetchImpl })) {
    events.push(ev);
  }
  const deltas = events.filter(e => e.type === 'delta').map(e => e.text);
  assert.deepEqual(deltas, ['Hi', ' there']);
  const done = events.find(e => e.type === 'done');
  assert.ok(done, 'has done');
  assert.equal(done.finish_reason, 'end_turn');
  assert.equal(done.model, 'claude-3-5-sonnet-latest');
  assert.equal(done.usage.input_tokens, 10);
  assert.equal(done.usage.output_tokens, 2);
});

await t('AnthropicProvider.streamChat: error on non-2xx', async () => {
  const provider = new AnthropicProvider({ apiKey: 'sk-ant-test' });
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  let caught = null;
  try {
    for await (const ev of provider.streamChat({ payload: { model: 'm', messages: [] }, fetchImpl })) { /* */ }
  } catch (e) { caught = e; }
  assert.ok(caught, 'threw');
  assert.equal(caught.status, 401);
});

// ---- AionChain integration ----
// Helper: aionChain.stream() yields SSE-formatted strings ("data: {...}\n\n"),
// not plain event objects. Parse them so the tests can assert on the payload.
function parseSseStream(sseStrings) {
  const out = [];
  for (const s of sseStrings) {
    for (const line of s.split('\n')) {
      const m = line.match(/^data: (.+)$/);
      if (!m) continue;
      const data = m[1].trim();
      if (data === '[DONE]') continue;
      try { out.push(JSON.parse(data)); } catch { /* ignore non-JSON */ }
    }
  }
  return out;
}

await t('AionChain.stream picks true-streaming when provider has streamChat', async () => {
  const body = makeSseBody([
    { choices: [{ delta: { content: 'A' }, index: 0 }] },
    { choices: [{ delta: { content: 'B' }, index: 0 }] },
    { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    { model: 'gpt-4o-mini', choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
  ]);
  // Inject fetchImpl into the provider by replacing streamChat with a bound copy.
  const fresh = new OpenAIProvider({ apiKey: 'sk-test' });
  fresh.streamChat = ({ payload: p }) => new OpenAIProvider({ apiKey: 'sk-test' }).streamChat({
    payload: p,
    fetchImpl: async () => ({ ok: true, status: 200, body: fakeBody([body]) })
  });
  const chain = new AionChain({ providers: [fresh], store: { record: () => {} } });
  const sseOut = [];
  for await (const ev of chain.stream({ messages: [{role:'user', content:'x'}] })) sseOut.push(ev);
  const events = parseSseStream(sseOut);
  const deltas = events.filter(e => e.type === 'delta').map(e => e.text);
  const opens = events.filter(e => e.type === 'open');
  const done = events.find(e => e.type === 'done');
  assert.deepEqual(deltas, ['A', 'B']);
  assert.equal(opens[0]?.streaming, 'true', 'open event should be true');
  assert.equal(done?.streaming, 'true', 'done event should be true');
});

await t('AionChain.stream falls back to simulated when no streamChat', async () => {
  const { EchoProvider } = await import('../lib/router.js');
  const echo = new EchoProvider({ name: 'echo' });
  const chain = new AionChain({ providers: [echo], store: { record: () => {} } });
  const sseOut = [];
  for await (const ev of chain.stream({ messages: [{role:'user', content:'hi'}] })) sseOut.push(ev);
  const events = parseSseStream(sseOut);
  const done = events.find(e => e.type === 'done');
  assert.equal(done?.streaming, 'simulated', 'echo must be simulated');
});

// ---- Live (skipped without key) ----

if (process.env.SKIP_LIVE === '1' || !process.env.OPENAI_API_KEY) {
  console.log('SKIP  live OpenAI stream (no key or SKIP_LIVE=1)');
} else {
  await t('AionChain.stream against REAL OpenAI emits streaming:true', async () => {
    const chain = AionChain.fromEnv();
    const sseOut = [];
    for await (const ev of chain.stream({
      messages: [{role:'user', content:'Say only: OK'}],
      temperature: 0, maxTokens: 10,
    })) sseOut.push(ev);
    const events = parseSseStream(sseOut);
    const openEv = events.find(e => e.type === 'open');
    const done = events.find(e => e.type === 'done');
    assert.equal(openEv?.streaming, 'true', `open.streaming=${openEv?.streaming}`);
    assert.equal(done?.streaming, 'true', `done.streaming=${done?.streaming}`);
    assert.ok(done?.latency_ms > 0, 'latency recorded');
  }, 30_000);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
