// lib/client.js
// Drop-in client. Use this INSTEAD of the OpenAI SDK to route through llm-gateway.
// Or set OPENAI_BASE_URL=https://your-gateway/v1 to use the raw OpenAI SDK.

export class GatewayClient {
  constructor({ baseUrl, apiKey, appId, fetchImpl } = {}) {
    if (!baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.appId = appId || 'unknown-app';
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  _headers(extra = {}) {
    const h = { 'content-type': 'application/json', 'x-app-id': this.appId, ...extra };
    if (this.apiKey) h['x-openai-key'] = this.apiKey;
    return h;
  }

  async _postJSON(path, body) {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); }
    catch (e) { throw new Error(`${path} returned invalid JSON: ${e.message}`); }
  }

  async chat({ model, messages, ...rest }) {
    return this._postJSON('/v1/chat/completions', { model, messages, ...rest });
  }

  async image({ model = 'gpt-image-2', prompt, n = 1, size = '1024x1024' } = {}) {
    return this._postJSON('/v1/images/generations', { model, prompt, n, size });
  }

  async video({ model = 'sora-2', prompt, ...rest } = {}) {
    return this._postJSON('/v1/videos', { model, prompt, ...rest });
  }
}

// Quick factory: read baseUrl from LLM_GATEWAY_URL env.
export function fromEnv() {
  const baseUrl = process.env.LLM_GATEWAY_URL || 'http://localhost:10000';
  return new GatewayClient({
    baseUrl,
    apiKey: process.env.OPENAI_API_KEY,
    appId: process.env.LLM_GATEWAY_APP_ID || 'env-app',
  });
}
