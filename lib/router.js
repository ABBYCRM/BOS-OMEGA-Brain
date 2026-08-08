// lib/router.js
// Provider chain with circuit breaker, fallback, and per-call accounting.
// Supports: openai (chat/image/video/edits), a2e (text2image/image2video), anthropic (chat), echo (test).

async function fetchWithTimeout(fetchImpl, url, init, ms) {
  const f = fetchImpl || globalThis.fetch;
  // Use AbortSignal.timeout if available; otherwise build a controller.
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return f(url, { ...init, signal: AbortSignal.timeout(ms) });
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await f(url, { ...init, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

export class CircuitBreaker {
  constructor({ threshold = 3, cooldownMs = 30_000 } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = new Map(); // provider -> { count, openedAt }
  }
  isOpen(provider) {
    const f = this.failures.get(provider);
    if (!f) return false;
    if (Date.now() - f.openedAt > this.cooldownMs) {
      this.failures.delete(provider);
      return false;
    }
    return true;
  }
  recordSuccess(provider) { this.failures.delete(provider); }
  recordFailure(provider) {
    const f = this.failures.get(provider) || { count: 0, openedAt: 0 };
    f.count += 1;
    if (f.count >= this.threshold) f.openedAt = Date.now();
    this.failures.set(provider, f);
  }
  state(provider) {
    const f = this.failures.get(provider);
    if (!f) return { open: false, count: 0 };
    const stillOpen = Date.now() - f.openedAt < this.cooldownMs;
    return { open: stillOpen, count: f.count, openedAt: f.openedAt };
  }
}

export class Router {
  constructor({ providers, breaker, store, fetchImpl } = {}) {
    this.providers = providers; // ordered chain, first = primary
    this.breaker = breaker || new CircuitBreaker();
    this.store = store; // optional Store instance
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  async call({ operation, payload, appId, requestId }) {
    const start = Date.now();
    const errors = [];
    for (const provider of this.providers) {
      if (this.breaker.isOpen(provider.name)) {
        errors.push({ provider: provider.name, code: 'circuit_open', message: 'circuit breaker open' });
        continue;
      }
      try {
        const result = await provider.invoke({ operation, payload, fetchImpl: this.fetchImpl });
        const latency = Date.now() - start;
        this.breaker.recordSuccess(provider.name);
        this.store?.recordCall({
          ts: start,
          app_id: appId,
          provider: provider.name,
          model: result.model || payload?.model || null,
          operation,
          status: 200,
          latency_ms: latency,
          tokens_in: result.usage?.input_tokens ?? result.usage?.prompt_tokens ?? null,
          tokens_out: result.usage?.output_tokens ?? result.usage?.completion_tokens ?? null,
          cost_usd: result.cost_usd ?? null,
          request_id: requestId,
          meta: { providers_tried: this.providers.slice(0, this.providers.indexOf(provider) + 1).map(p => p.name) },
        });
        return { ok: true, provider: provider.name, latency_ms: latency, ...result };
      } catch (e) {
        const latency = Date.now() - start;
        this.breaker.recordFailure(provider.name);
        const err = { provider: provider.name, code: e.code || 'provider_error', message: e.message, status: e.status };
        errors.push(err);
        this.store?.recordCall({
          ts: start,
          app_id: appId,
          provider: provider.name,
          model: payload?.model || null,
          operation,
          status: e.status || null,
          latency_ms: latency,
          request_id: requestId,
          error_code: err.code,
          error_message: err.message,
          meta: { providers_tried: this.providers.slice(0, this.providers.indexOf(provider) + 1).map(p => p.name) },
        });
        // Only continue to next provider on retriable errors
        if (!isRetriable(e)) break;
      }
    }
    return { ok: false, errors, latency_ms: Date.now() - start };
  }
}

function isRetriable(e) {
  if (!e.status) return true; // network error
  if (e.status === 401 || e.status === 403) return false; // auth is fatal
  if (e.status === 400) return false; // bad request is fatal
  if (e.status === 429) return true; // rate limit
  if (e.status >= 500) return true;
  return false;
}

// ---------- Provider implementations ----------

export class OpenAIProvider {
  constructor({ apiKey, baseUrl = 'https://api.openai.com/v1', name = 'openai' } = {}) {
    if (!apiKey) throw new Error('OpenAIProvider requires apiKey');
    // name is configurable so NVIDIA NIM (and other OpenAI-compatible endpoints)
    // do not collide with the primary openai entry in AionChain's byName Map.
    this.name = name || 'openai';
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /** Non-streaming call (used by Router and as fallback). */
  async invoke({ operation, payload, fetchImpl }) {
    const path = openaiPath(operation);
    if (!path) throw { code: 'unsupported_operation', message: `openai: ${operation} not supported`, status: 400 };
    const url = `${this.baseUrl}${path}`;
    const init = openaiInit(operation, payload, this.apiKey);
    const res = await fetchWithTimeout(fetchImpl, url, init, 30_000);
    const text = await res.text();
    if (!res.ok) throw { code: `http_${res.status}`, message: text.slice(0, 500), status: res.status };
    let json = {};
    if (text) {
      try { json = JSON.parse(text); }
      catch (e) { throw { code: 'invalid_json', message: `provider returned non-JSON: ${e.message}`, status: 502 }; }
    }
    return normalizeOpenAI(operation, json);
  }

  /**
   * True token streaming for chat. Yields objects:
   *   { type: 'delta', text: string }
   *   { type: 'done', finish_reason, model, usage? }
   * Throws the same shaped errors as invoke on failure.
   */
  async *streamChat({ payload, fetchImpl } = {}) {
    const f = fetchImpl || globalThis.fetch;
    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      ...payload,
      stream: true,
      stream_options: { include_usage: true },
    };
    const res = await f(url, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        'accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw { code: `http_${res.status}`, message: text.slice(0, 500), status: res.status };
    }
    if (!res.body) {
      throw { code: 'no_stream_body', message: 'provider returned no readable body', status: 502 };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let model = payload?.model || null;
    let finishReason = 'stop';
    let usage = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop() || '';
        for (const raw of parts) {
          const line = raw.trim();
          if (!line || line.startsWith(':')) continue; // SSE comment / keep-alive
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            yield { type: 'done', finish_reason: finishReason, model, usage };
            return;
          }
          let json;
          try { json = JSON.parse(data); } catch { continue; }
          if (json.model) model = json.model;
          if (json.usage) usage = json.usage;
          const choice = json.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            yield { type: 'delta', text: delta };
          }
        }
      }
      // Stream ended without explicit [DONE]
      yield { type: 'done', finish_reason: finishReason, model, usage };
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }
}

function openaiPath(op) {
  switch (op) {
    case 'chat': return '/chat/completions';
    case 'image.generate': return '/images/generations';
    case 'image.edit': return '/images/edits';
    case 'video.create': return '/videos';
    default: return null;
  }
}

function openaiInit(op, payload, apiKey) {
  const headers = { 'authorization': `Bearer ${apiKey}` };
  if (op === 'image.edit') {
    const fd = new FormData();
    if (payload.image) fd.append('image', payload.image); // Blob
    if (payload.mask) fd.append('mask', payload.mask);
    if (payload.prompt) fd.append('prompt', payload.prompt);
    if (payload.model) fd.append('model', payload.model);
    if (payload.n) fd.append('n', String(payload.n));
    if (payload.size) fd.append('size', payload.size);
    return { method: 'POST', headers, body: fd };
  }
  headers['content-type'] = 'application/json';
  return { method: 'POST', headers, body: JSON.stringify(payload) };
}

function normalizeOpenAI(op, json) {
  if (op === 'chat') {
    const choice = json.choices?.[0];
    return {
      model: json.model,
      content: choice?.message?.content ?? null,
      finish_reason: choice?.finish_reason,
      usage: json.usage,
    };
  }
  if (op === 'image.generate') {
    return {
      model: json.model || 'gpt-image-2',
      images: (json.data || []).map(d => ({ url: d.url, b64: d.b64_json })),
      usage: json.usage,
    };
  }
  if (op === 'image.edit') {
    return {
      model: json.model || 'gpt-image-2',
      images: (json.data || []).map(d => ({ url: d.url, b64: d.b64_json })),
      usage: json.usage,
    };
  }
  if (op === 'video.create') {
    return { id: json.id, status: json.status, model: json.model };
  }
  return json;
}

export class A2EProvider {
  constructor({ apiKey, baseUrl = 'https://api.a2e.ai/v1' } = {}) {
    this.name = 'a2e';
    this.apiKey = apiKey || '';
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }
  async invoke({ operation, payload, fetchImpl }) {
    const map = {
      'chat': { path: '/chat/completions', method: 'POST' },
      'image.generate': { path: '/text2image', method: 'POST' },
      'image.edit': { path: '/image2image', method: 'POST' },
      'video.create': { path: '/userImage2Video', method: 'POST' },
    };
    const route = map[operation];
    if (!route) throw { code: 'unsupported_operation', message: `a2e: ${operation} not supported`, status: 400 };
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
    const res = await fetchWithTimeout(fetchImpl, `${this.baseUrl}${route.path}`, {
      method: route.method, headers, body: JSON.stringify(payload),
    }, 30_000);
    const text = await res.text();
    if (!res.ok) throw { code: `http_${res.status}`, message: text.slice(0, 500), status: res.status };
    let raw = {};
    if (text) {
      try { raw = JSON.parse(text); }
      catch (e) { throw { code: 'invalid_json', message: `a2e returned non-JSON: ${e.message}`, status: 502 }; }
    }
    return { raw };
  }
}

export class AnthropicProvider {
  constructor({ apiKey, baseUrl = 'https://api.anthropic.com/v1' } = {}) {
    if (!apiKey) throw new Error('AnthropicProvider requires apiKey');
    this.name = 'anthropic';
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }
  async invoke({ operation, payload, fetchImpl }) {
    if (operation !== 'chat') throw { code: 'unsupported_operation', message: 'anthropic: only chat', status: 400 };
    const model = payload.model || 'claude-3-5-sonnet-latest';
    const max_tokens = payload.max_tokens || 1024;
    const system = (payload.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n');
    const messages = (payload.messages || []).filter(m => m.role !== 'system');
    const res = await fetchWithTimeout(fetchImpl, `${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, max_tokens, system, messages }),
    }, 30_000);
    const text = await res.text();
    if (!res.ok) throw { code: `http_${res.status}`, message: text.slice(0, 500), status: res.status };
    let json = {};
    try { json = text ? JSON.parse(text) : {}; }
    catch (e) { throw { code: 'invalid_json', message: `anthropic returned non-JSON: ${e.message}`, status: 502 }; }
    return {
      model: json.model,
      content: json.content?.[0]?.text ?? null,
      finish_reason: json.stop_reason,
      usage: { input_tokens: json.usage?.input_tokens, output_tokens: json.usage?.output_tokens },
    };
  }

  /**
   * True token streaming for chat (Anthropic Messages API with `stream: true`).
   * Yields: { type: 'delta', text }, { type: 'done', finish_reason, model, usage }
   *
   * Anthropic SSE event types we care about:
   *   message_start         → capture model, initial usage
   *   content_block_start   → ignore
   *   content_block_delta   → type=text → text delta
   *   content_block_stop    → ignore
   *   message_delta         → capture stop_reason + final usage
   *   message_stop          → terminal
   *   ping / other          → ignore
   */
  async *streamChat({ payload, fetchImpl } = {}) {
    const f = fetchImpl || globalThis.fetch;
    const model = payload?.model || 'claude-3-5-sonnet-latest';
    const max_tokens = payload?.max_tokens || 1024;
    const system = (payload?.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n');
    const messages = (payload?.messages || []).filter(m => m.role !== 'system');

    const res = await f(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'accept': 'text/event-stream',
      },
      body: JSON.stringify({ model, max_tokens, system, messages, stream: true }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw { code: `http_${res.status}`, message: t.slice(0, 500), status: res.status };
    }
    if (!res.body) {
      throw { code: 'no_stream_body', message: 'anthropic returned no readable body', status: 502 };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finishReason = 'stop';
    let usage = { input_tokens: null, output_tokens: null };
    let outputModel = model;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop() || '';
        let eventType = null;
        for (const raw of parts) {
          const line = raw.trim();
          if (!line) { eventType = null; continue; }
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
            continue;
          }
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }

          if (eventType === 'message_start') {
            outputModel = ev.message?.model || outputModel;
            if (ev.message?.usage) usage = { input_tokens: ev.message.usage.input_tokens, output_tokens: ev.message.usage.output_tokens };
          } else if (eventType === 'content_block_delta') {
            const t = ev.delta?.text;
            if (t) yield { type: 'delta', text: t };
          } else if (eventType === 'message_delta') {
            if (ev.delta?.stop_reason) finishReason = ev.delta.stop_reason;
            if (ev.usage?.output_tokens != null) usage = { ...usage, output_tokens: ev.usage.output_tokens };
          } else if (eventType === 'message_stop') {
            yield { type: 'done', finish_reason: finishReason, model: outputModel, usage };
            return;
          }
        }
      }
    } catch (e) {
      if (e?.code && e?.status) throw e; // already shaped
      throw { code: 'stream_read_error', message: e.message || String(e), status: 502 };
    }
    // Stream ended without message_stop (rare)
    yield { type: 'done', finish_reason: finishReason, model: outputModel, usage };
  }
}

// Echo provider for tests and offline dev. Returns the request back.
export class EchoProvider {
  constructor({ name = 'echo', latencyMs = 5 } = {}) {
    this.name = name;
    this.latencyMs = latencyMs;
  }
  async invoke({ operation, payload }) {
    await new Promise(r => setTimeout(r, this.latencyMs));
    return {
      model: payload?.model || 'echo',
      content: `[echo:${operation}] ${JSON.stringify(payload).slice(0, 200)}`,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}
