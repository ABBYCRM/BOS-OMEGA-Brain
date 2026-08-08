// lib/aion_chain.js
// AION-style streaming LLM chain. Emits SSE events:
//   data: {"type":"decision","decision":{...}}
//   data: {"type":"attempt","provider":"...","model":"...","index":N}
//   data: {"type":"open","provider":"...","model":"..."}
//   data: {"type":"delta","text":"..."}
//   data: {"type":"done","provider":"...","model":"...","latency_ms":N,"finish_reason":"..."}
//   data: {"type":"error","kind":"...","message":"..."}
//   data: [DONE]
//
// Provider chain: OpenAI (primary) -> NVIDIA NIM (fallback) -> Anthropic (fallback).
// Each provider uses the existing OpenAI/Anthropic client classes from lib/router.js.
// Circuit breaker integration via lib/router.js CircuitBreaker.

import { OpenAIProvider, AnthropicProvider, EchoProvider, CircuitBreaker } from './router.js';

export class AionChain {
  constructor({ providers, breaker, store, appId = 'aion', requestId = null } = {}) {
    this.providers = providers;
    this.breaker = breaker || new CircuitBreaker();
    this.store = store;
    this.appId = appId;
    this.requestId = requestId;
  }

  /**
   * Build the default chain from env vars, mirroring the AION v2 backend:
   *   1. OPENAI_API_KEY
   *   2. NVIDIA_API_KEY  (treated as OpenAI-compatible; uses NVIDIA_BASE_URL)
   *   3. ANTHROPIC_API_KEY
   *   4. EchoProvider (offline dev only)
   */
  static fromEnv({ breaker, store, appId, requestId } = {}) {
    // AION_ECHO_ONLY=1 forces EchoProvider (hermetic tests / offline dev).
    // Otherwise: OpenAI -> NVIDIA NIM -> Anthropic -> Echo.
    const chain = [];
    if (process.env.AION_ECHO_ONLY === '1') {
      // Dynamic import for EchoProvider to keep the static one available too
      chain.push(new EchoProvider({ name: 'echo', latencyMs: 5 }));
      return new AionChain({ providers: chain, breaker, store, appId, requestId });
    }
    if (process.env.OPENAI_API_KEY) {
      chain.push(new OpenAIProvider({
        name: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      }));
    }
    if (process.env.NVIDIA_API_KEY) {
      // Distinct name so byName selection can resolve "nvidia" vs "openai".
      chain.push(new OpenAIProvider({
        name: 'nvidia',
        apiKey: process.env.NVIDIA_API_KEY,
        baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      }));
    }
    if (process.env.ANTHROPIC_API_KEY) {
      chain.push(new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }));
    }
    if (chain.length === 0) {
      chain.push(new EchoProvider({ name: 'echo', latencyMs: 5 }));
    }
    return new AionChain({ providers: chain, breaker, store, appId, requestId });
  }

  /**
   * Stream a chat completion. Yields SSE event strings (already
   * newline-terminated so the caller can pipe them straight to the client).
   *
   * @param {object} args
   * @param {Array<{provider?: string, model?: string}>} args.chain
   *   Ordered chain. First = primary. If empty, OpenAI gpt-4o-mini is used.
   * @param {Array} args.messages  OpenAI-shaped messages.
   * @param {number} args.temperature
   * @param {number} args.maxTokens
   */
  async *stream({ chain = [], messages, temperature = 0.7, maxTokens = 1024 }) {
    // Prefer true token streaming when the provider implements streamChat.
    // Falls back to simulated (full completion → chunked deltas) otherwise.
    const order = (chain && chain.length > 0)
      ? chain
      : (this.providers[0] ? [{ provider: this.providers[0].name, model: 'gpt-4o-mini' }] : []);

    let emittedOutput = false;
    let lastError = 'no_attempt';

    // Name-based provider selection
    const byName = new Map(this.providers.map(p => [p.name, p]));
    const requestedOrder = order.length > 0 ? order : (this.providers[0] ? [{ provider: this.providers[0].name, model: 'gpt-4o-mini' }] : []);

    for (let i = 0; i < requestedOrder.length; i++) {
      const want = requestedOrder[i] || {};
      const provider = byName.get(want.provider) || this.providers[i];
      if (!provider) {
        yield sseEvent('error', { kind: 'unknown_provider', requested: want.provider, index: i + 1, message: `provider '${want.provider}' not in chain` });
        this._record({ kind: 'attempt_skipped', provider: want.provider, reason: 'unknown_provider' });
        continue;
      }
      const ref = { provider: provider.name, model: want.model || 'gpt-4o-mini' };

      yield sseEvent('attempt', { provider: ref.provider, model: ref.model, index: i + 1 });
      this._record({ kind: 'attempt_start', provider: ref.provider, model: ref.model });

      if (this.breaker.isOpen(provider.name)) {
        yield sseEvent('error', { kind: 'circuit_open', provider: ref.provider, model: ref.model, message: 'circuit breaker open' });
        this._record({ kind: 'attempt_skipped', provider: ref.provider, reason: 'circuit_open' });
        continue;
      }

      const started = Date.now();
      const payload = { model: ref.model, messages, temperature, max_tokens: maxTokens };

      try {
        // ---- True streaming path ----
        if (typeof provider.streamChat === 'function') {
          let opened = false;
          let completionChars = 0;
          let finishReason = 'stop';
          let model = ref.model;

          for await (const ev of provider.streamChat({ payload })) {
            if (ev.type === 'delta' && ev.text) {
              if (!opened) {
                opened = true;
                yield sseEvent('open', { provider: ref.provider, model: ref.model, streaming: 'true' });
              }
              completionChars += ev.text.length;
              emittedOutput = true;
              yield sseEvent('delta', { text: ev.text });
            } else if (ev.type === 'done') {
              finishReason = ev.finish_reason || finishReason;
              model = ev.model || model;
              const latency = Date.now() - started;
              if (!opened) {
                yield sseEvent('open', { provider: ref.provider, model: ref.model, streaming: 'true' });
              }
              yield sseEvent('done', {
                streaming: 'true',
                provider: ref.provider,
                model,
                latency_ms: latency,
                completion_chars: completionChars,
                finish_reason: finishReason,
                usage: ev.usage || null,
              });
              this.breaker.recordSuccess(provider.name);
              this._record({ kind: 'attempt_ok', provider: ref.provider, model, latency_ms: latency, completion_chars: completionChars, streaming: 'true' });
              return;
            }
          }
          // Stream ended without explicit done event
          const latency = Date.now() - started;
          if (!opened) yield sseEvent('open', { provider: ref.provider, model: ref.model, streaming: 'true' });
          yield sseEvent('done', {
            streaming: 'true',
            provider: ref.provider,
            model: ref.model,
            latency_ms: latency,
            completion_chars: completionChars,
            finish_reason: finishReason,
          });
          this.breaker.recordSuccess(provider.name);
          this._record({ kind: 'attempt_ok', provider: ref.provider, model: ref.model, latency_ms: latency, completion_chars: completionChars, streaming: 'true' });
          return;
        }

        // ---- Simulated fallback (providers without streamChat) ----
        const result = await provider.invoke({ operation: 'chat', payload });
        const content = result.content || '';
        const finishReason = result.finish_reason || 'stop';
        const latency = Date.now() - started;

        yield sseEvent('open', { provider: ref.provider, model: ref.model, streaming: 'simulated' });
        const chunkSize = 12;
        for (let c = 0; c < content.length; c += chunkSize) {
          const text = content.slice(c, c + chunkSize);
          yield sseEvent('delta', { text });
          emittedOutput = true;
        }
        yield sseEvent('done', {
          streaming: 'simulated',
          provider: ref.provider,
          model: ref.model,
          latency_ms: latency,
          completion_chars: content.length,
          finish_reason: finishReason,
        });
        this.breaker.recordSuccess(provider.name);
        this._record({ kind: 'attempt_ok', provider: ref.provider, model: ref.model, latency_ms: latency, completion_chars: content.length, streaming: 'simulated' });
        return;
      } catch (e) {
        const latency = Date.now() - started;
        this.breaker.recordFailure(provider.name);
        lastError = e.message || 'provider_error';
        this._record({ kind: 'attempt_failed', provider: ref.provider, model: ref.model, error_code: e.code, error_message: lastError, latency_ms: latency });
        yield sseEvent('error', { kind: e.code || 'provider_error', provider: ref.provider, model: ref.model, message: lastError });
        if (emittedOutput) {
          yield sseEvent('error', { kind: 'partial_stream_failure', provider: ref.provider, model: ref.model, message: 'partial response preserved' });
          return;
        }
        if (e.status === 401 || e.status === 403 || e.status === 400) return;
      }
    }

    yield sseEvent('error', { kind: 'all_providers_failed', message: lastError });
  }

  _record({ kind, ...rest }) {
    if (!this.store?.recordCall) return;
    try {
      this.store.recordCall({
        ts: Date.now(),
        app_id: this.appId,
        provider: rest.provider || 'unknown',
        model: rest.model || null,
        operation: `aion.${kind}`,
        status: rest.latency_ms ? 200 : null,
        latency_ms: rest.latency_ms || null,
        request_id: this.requestId,
        error_code: rest.error_code || null,
        error_message: rest.error_message || null,
        meta: rest,
      });
    } catch { /* non-fatal */ }
  }
}

function sseEvent(type, payload) {
  return `data: ${JSON.stringify({ type, ...payload })}\n\n`;
}
