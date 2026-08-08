// lib/brain_tools.js
// The catalog of tools Aion-Brain can run on behalf of AION. Tools here are
// "kernel-level" — fast, deterministic, evidence-producing. Heavy tools
// (TTS, image gen, video gen, notes, gallery, GitHub writes) live in the
// Python AION backend, not here.
//
// Each tool:
//   - has a unique name
//   - accepts an `args` object
//   - returns { evidence: <string or object>, ok: boolean, error?: string }
//
// AION injects tool results as <tool_results> blocks before calling
// /api/chat on Brain.

const TOOL_CATALOG = Object.freeze([
  {
    name: 'web_search',
    description: 'Run a web search and return formatted results.',
    args_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', maxLength: 400 },
        count: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
        freshness: { type: 'string', enum: ['pd', 'pw', 'pm', 'py'] },
      },
    },
    cost_estimate: '1 HTTP call',
    side_effects: false,
  },
  {
    name: 'echo',
    description: 'Return the input back. Used for testing the tool pipeline.',
    args_schema: { type: 'object', properties: { text: { type: 'string' } } },
    cost_estimate: '0',
    side_effects: false,
  },
  {
    name: 'datetime',
    description: 'Return the current UTC timestamp + ISO string.',
    args_schema: { type: 'object', properties: {} },
    cost_estimate: '0',
    side_effects: false,
  },
  {
    name: 'free_energy',
    description: 'Return a synthetic free-energy snapshot for a topic. Useful for lattice demos.',
    args_schema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
    },
    cost_estimate: '0',
    side_effects: false,
  },
]);

class ToolRegistry {
  constructor({ searcher = null } = {}) {
    this._searcher = searcher; // optional async (query, count) => [{title,url,snippet}]
    this._tools = new Map();
    for (const t of TOOL_CATALOG) this._tools.set(t.name, t);
  }

  catalog() {
    return Array.from(this._tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      args_schema: t.args_schema,
      cost_estimate: t.cost_estimate,
      side_effects: t.side_effects,
    }));
  }

  has(name) { return this._tools.has(name); }
  get(name) { return this._tools.get(name); }

  async run(name, args = {}) {
    if (!this._tools.has(name)) {
      return { ok: false, error: `unknown_tool:${name}` };
    }
    if (name === 'echo') {
      return { ok: true, evidence: { text: String(args?.text || '') }, tool: name };
    }
    if (name === 'datetime') {
      const now = Date.now();
      return { ok: true, evidence: { iso: new Date(now).toISOString(), unix_ms: now, utc: new Date(now).toUTCString() }, tool: name };
    }
    if (name === 'free_energy') {
      // Deterministic pseudo-signal for lattice demos. No external call.
      const topic = String(args?.topic || 'unknown');
      let h = 0;
      for (let i = 0; i < topic.length; i++) h = (h * 31 + topic.charCodeAt(i)) >>> 0;
      const precision = (h % 1000) / 1000;
      const recall = ((h >> 10) % 1000) / 1000;
      const complexity = 1 - Math.abs(precision - recall);
      return {
        ok: true,
        evidence: {
          topic,
          precision_estimate: Number(precision.toFixed(3)),
          recall_estimate: Number(recall.toFixed(3)),
          complexity_estimate: Number(complexity.toFixed(3)),
          free_energy: Number((complexity * 0.7 + (1 - precision) * 0.3).toFixed(3)),
        },
        tool: name,
      };
    }
    if (name === 'web_search') {
      const query = String(args?.query || '').trim();
      if (!query) return { ok: false, error: 'query_required', tool: name };
      const count = Math.max(1, Math.min(10, Number(args?.count) || 5));
      if (!this._searcher) return { ok: false, error: 'web_search_unconfigured', tool: name };
      try {
        const results = await this._searcher(query, count);
        const lines = (results || []).map((r, i) => {
          const title = String(r.title || '').slice(0, 200);
          const url = String(r.url || '').slice(0, 500);
          const snippet = String(r.snippet || '').slice(0, 400);
          return `${i + 1}. [${title}](${url})\n   ${snippet}`;
        }).join('\n');
        return {
          ok: true,
          evidence: { query, count: results?.length || 0, results: results || [], text: lines },
          tool: name,
        };
      } catch (exc) {
        return { ok: false, error: `web_search_failed:${exc?.message || exc}`, tool: name };
      }
    }
    return { ok: false, error: `tool_not_implemented:${name}`, tool: name };
  }
}

export { TOOL_CATALOG, ToolRegistry };
