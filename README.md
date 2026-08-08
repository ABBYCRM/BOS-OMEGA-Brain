# llm-gateway

> Plug-and-play LLM gateway with a self-auditor built in. Drop it in front of any
> LLM call in any app. Every call is logged, every call is measured, and the
> gateway audits its own code on demand.

OpenAI-compatible at the edge. If your code already calls OpenAI's REST API,
you point it at the gateway and you're done.

---

## What it does

- **Routes** every LLM call through a provider chain (OpenAI → A2E → Anthropic → Echo)
  with circuit breaking, per-call cost/latency tracking, and a SQLite call log.
- **Self-audits** with a 5-phase algorithm:
  1. **Inventory** — sha256 every `.ts/.js/.mjs/.json` file in the repo
  2. **Baseline** — measure health latency, memory, and self-availability
  3. **Static** — run 22 rules over the source (P0 crash/security, P1 perf, P2 hygiene)
  4. **Verify** — for every claimed fix in `CHANGELOG.md`, confirm the symbol still exists
  5. **Report** — return `VERIFIED_COMPLETE` / `PARTIAL` / `BLOCKED` / `FAILED`
- **Exposes** the audit on HTTP so any app (or cron) can hit it.

---

## Plug it into any app (3 lines)

```js
import { GatewayClient } from 'llm-gateway/client';
const gw = new GatewayClient({ baseUrl: 'https://your-gateway', apiKey: process.env.OPENAI_API_KEY });
const r = await gw.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
```

Or, with the **raw OpenAI SDK** (no import needed — just change baseURL):
```js
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: 'https://your-gateway/v1' });
```

For **Express apps**:
```js
import { gateway } from 'llm-gateway/middleware';
app.use('/llm', gateway({ baseUrl: 'https://your-gateway' }));
```

For **anything else** (Python, Go, Zapier, cURL): hit the HTTP endpoint directly.
It's OpenAI-compatible.

---

## Endpoints

| Method | Path                          | Purpose                                            |
|--------|-------------------------------|----------------------------------------------------|
| GET    | `/healthz`                    | Liveness                                           |
| POST   | `/v1/chat/completions`        | OpenAI-compatible chat                             |
| POST   | `/v1/images/generations`      | OpenAI-compatible image gen                        |
| POST   | `/v1/images/edits`            | OpenAI-compatible image edit                       |
| POST   | `/v1/videos`                  | OpenAI-compatible video create                     |
| POST   | `/v1/messages`                | Anthropic Messages API passthrough                  |
| GET    | `/audit`                      | Last audit report (JSON)                           |
| POST   | `/audit/run`                  | Run a fresh 5-phase audit (slow, ~1s)              |
| GET    | `/audit/quick`                | Quick health + drift (fast, ~50ms)                 |
| GET    | `/calls/recent?n=50`          | Recent call log                                    |
| GET    | `/stats`                      | Aggregated provider/operation stats                |

### AION API (kernel + 7-law decision + SSE chat)

Same contract as the AION v2.x FastAPI backend. Drop-in compatible.

| Method | Path                          | Auth         | Purpose                                |
|--------|-------------------------------|--------------|----------------------------------------|
| GET    | `/api/continuity-pack`        | public       | 7 laws + 3 decision states + identity  |
| GET    | `/api/models`                 | AION key     | Provider chain + probes                |
| GET    | `/api/audit/recent`           | AION admin   | Last audit report                      |
| POST   | `/api/decision`                | AION key     | 7-law kernel decision for a prompt     |
| POST   | `/api/chat`                   | AION key     | SSE chat with decision + attempt + open + delta + done |

Auth header: `X-AION-Key: <key>` or `Authorization: Bearer <key>`. The CORS
preflight response advertises `x-aion-key` in `access-control-allow-headers`
so browser clients sending the header don't get rejected.

SSE event names (exact match with AION v2 backend):
```
data: {"type":"decision","decision":{"state":"COMMIT","score":0.75,"checks":[...]}}
data: {"type":"attempt","provider":"openai","model":"gpt-4o-mini","index":1}
data: {"type":"open","provider":"openai","model":"gpt-4o-mini"}
data: {"type":"delta","text":"..."}
data: {"type":"done","streaming":"simulated","provider":"openai","model":"gpt-4o-mini","latency_ms":1203,"finish_reason":"stop"}
data: [DONE]
```

> **Note on streaming:** as of v0.1.9 OpenAI-compatible providers (OpenAI, NVIDIA NIM, etc.)
> use **true token streaming** via `streamChat()`. The `done` / `open` events carry
> `"streaming": "true"`. Providers without a stream implementation (Echo, Anthropic
> until added) still fall back to simulated chunking and report `"streaming": "simulated"`.

### Per-request credentials

The gateway accepts credentials via headers on every request, so a single
deployment can serve multiple apps without leaking keys:

```
x-openai-key:    sk-...
x-a2e-key:       ...
x-anthropic-key: ...
x-app-id:        my-app-name          (for call-log attribution)
x-request-id:    uuid-v4              (echoed back, logged on errors)
```

If no header is provided, the gateway falls back to its own env-var config.

---

## Self-auditor

```bash
# From the CLI
node bin/audit.mjs                 # full 5-phase audit
node bin/audit.mjs --quick         # health + drift only
node bin/audit.mjs --json          # raw JSON to stdout

# From HTTP
curl https://your-gateway/audit           # last report
curl -X POST https://your-gateway/audit/run   # run fresh
curl https://your-gateway/audit/quick
```

Example output:
```
=== llm-gateway self-audit (full) ===
status:           VERIFIED_COMPLETE
duration:         72ms
files inventoried:10
findings:         P0=0  P1=16  P2=26
verified fixes:   4   unverified: 0
```

The auditor catches its own bugs. If you write a "fix" in the changelog and
the symbol isn't in the source, the audit will report it as `unverified`.

---

## Provider chain (env-driven)

The default chain is built from env vars, in order:
1. `OPENAI_API_KEY` → OpenAIProvider
2. `A2E_API_KEY` → A2EProvider
3. `ANTHROPIC_API_KEY` → AnthropicProvider
4. (none) → EchoProvider (offline dev / tests)

Each provider auto-fails over to the next on retriable errors (5xx, 429, network).
Non-retriable errors (401, 403, 400) stop the chain. Circuit breaker opens
after 3 consecutive failures and recovers after 30s.

---

## Run locally

```bash
npm install
node server.js
# → llm-gateway listening on :10000
```

```bash
node test/smoke.mjs
# → 14/14 passed
```

---

## Deploy

```bash
# Render: link the repo, set start command to `node server.js`
# Or run anywhere Node 18+ is available.
```

The gateway is stateless except for the SQLite file in `LLM_GATEWAY_DATA_DIR`.
Mount a persistent disk if you want to survive restarts.

---

## File map

```
llm-gateway/
├── server.js              Express app, LLM + AION + audit routes
├── lib/
│   ├── aion_kernel.js     7-law kernel (REALITY / CONTINUITY / FIDELITY / LATTICE / EPISTEMIC / PERPETUITY / DECISION)
│   ├── aion_settings.js   Frozen Settings; fail-closed startup validation
│   ├── aion_chain.js      Provider chain with name-based selection + SSE stream
│   ├── brain.js           BOS-OMEGA Brain (audit → research → propose, propose-only)
│   ├── router.js          LLM provider chain + circuit breaker
│   ├── rules.js           22 static analysis rules
│   ├── auditor.js         5-phase self-auditor
│   ├── store.js           SQLite persistence (calls + audits)
│   └── client.js          Drop-in GatewayClient
├── bin/
│   └── audit.mjs          CLI: node bin/audit.mjs
├── test/
│   ├── smoke.mjs          14-check base smoke
│   ├── smoke-aion.mjs     10-check AION API smoke
│   ├── smoke-brain.mjs    6-check Brain layer + real OpenAI
│   ├── smoke-real.mjs     Real OpenAI smoke
│   └── contract-aion-modules.mjs   8 unit/contract tests
├── CHANGELOG.md           Claimed fixes the auditor verifies
└── reports/               Audit reports (one JSON per run)
```

---

## Why "gateway + auditor in one"?

Because that's the only way the auditor is honest. If the audit code lives
in a separate repo, the gateway can lie about its own health. If it lives
inside the same process and runs against the same `node_modules`, then a
green `/audit` is real proof the build is sound.

This is the principle: **the system performs its own duties within itself.**
