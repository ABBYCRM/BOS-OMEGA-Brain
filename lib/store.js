// lib/store.js
// SQLite-backed persistence for call logs + audit history.
// intentionally-sync: better-sqlite3 requires synchronous init; mkdir on first run only.
// Zero-config: file lives at $LLM_GATEWAY_DATA_DIR/gateway.db (default ./data/gateway.db).

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class Store {
  constructor(dbPath) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        app_id TEXT,
        provider TEXT NOT NULL,
        model TEXT,
        operation TEXT NOT NULL,
        status INTEGER,
        latency_ms INTEGER,
        tokens_in INTEGER,
        tokens_out INTEGER,
        cost_usd REAL,
        request_id TEXT,
        error_code TEXT,
        error_message TEXT,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts);
      CREATE INDEX IF NOT EXISTS idx_calls_app ON calls(app_id, ts);
      CREATE INDEX IF NOT EXISTS idx_calls_provider ON calls(provider, ts);

      CREATE TABLE IF NOT EXISTS audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        mode TEXT NOT NULL,           -- 'quick' | 'full'
        status TEXT NOT NULL,         -- 'VERIFIED_COMPLETE' | 'PARTIAL' | 'BLOCKED' | 'FAILED'
        inventory_files INTEGER,
        p0_count INTEGER,
        p1_count INTEGER,
        p2_count INTEGER,
        verified_fixes INTEGER,
        unverified_fixes INTEGER,
        duration_ms INTEGER,
        report_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audits_ts ON audits(ts);
    `);
  }

  recordCall(call) {
    const stmt = this.db.prepare(`
      INSERT INTO calls
        (ts, app_id, provider, model, operation, status, latency_ms,
         tokens_in, tokens_out, cost_usd, request_id, error_code, error_message, meta)
      VALUES
        (@ts, @app_id, @provider, @model, @operation, @status, @latency_ms,
         @tokens_in, @tokens_out, @cost_usd, @request_id, @error_code, @error_message, @meta)
    `);
    const row = {
      ts: call.ts ?? Date.now(),
      app_id: call.app_id ?? null,
      provider: call.provider,
      model: call.model ?? null,
      operation: call.operation,
      status: call.status ?? null,
      latency_ms: call.latency_ms ?? null,
      tokens_in: call.tokens_in ?? null,
      tokens_out: call.tokens_out ?? null,
      cost_usd: call.cost_usd ?? null,
      request_id: call.request_id ?? null,
      error_code: call.error_code ?? null,
      error_message: call.error_message ?? null,
      meta: call.meta ? JSON.stringify(call.meta) : null,
    };
    return stmt.run(row);
  }

  recordAudit(audit) {
    const stmt = this.db.prepare(`
      INSERT INTO audits
        (ts, mode, status, inventory_files, p0_count, p1_count, p2_count,
         verified_fixes, unverified_fixes, duration_ms, report_json)
      VALUES
        (@ts, @mode, @status, @inventory_files, @p0_count, @p1_count, @p2_count,
         @verified_fixes, @unverified_fixes, @duration_ms, @report_json)
    `);
    return stmt.run({
      ts: audit.ts ?? Date.now(),
      mode: audit.mode,
      status: audit.status,
      inventory_files: audit.inventory_files ?? 0,
      p0_count: audit.p0_count ?? 0,
      p1_count: audit.p1_count ?? 0,
      p2_count: audit.p2_count ?? 0,
      verified_fixes: audit.verified_fixes ?? 0,
      unverified_fixes: audit.unverified_fixes ?? 0,
      duration_ms: audit.duration_ms ?? 0,
      report_json: JSON.stringify(audit),
    });
  }

  lastAudit() {
    const row = this.db.prepare(`SELECT * FROM audits ORDER BY ts DESC LIMIT 1`).get();
    if (!row) return null;
    let report = null;
    try { report = JSON.parse(row.report_json); }
    catch { report = { status: 'CORRUPT', error: 'invalid report_json' }; }
    return { ...row, report };
  }

  recentCalls(limit = 50) {
    return this.db.prepare(`SELECT * FROM calls ORDER BY ts DESC LIMIT ?`).all(limit);
  }

  callStats(sinceMs = 24 * 3600 * 1000) {
    const since = Date.now() - sinceMs;
    return this.db.prepare(`
      SELECT
        provider,
        operation,
        COUNT(*) as n,
        AVG(latency_ms) as avg_latency,
        MIN(latency_ms) as min_latency,
        MAX(latency_ms) as max_latency,
        SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) as ok,
        SUM(CASE WHEN status >= 400 OR error_code IS NOT NULL THEN 1 ELSE 0 END) as err,
        SUM(COALESCE(tokens_in, 0)) as sum_in,
        SUM(COALESCE(tokens_out, 0)) as sum_out,
        SUM(COALESCE(cost_usd, 0)) as sum_cost
      FROM calls
      WHERE ts >= ?
      GROUP BY provider, operation
      ORDER BY n DESC
    `).all(since);
  }

  close() { this.db.close(); }
}

export function defaultStorePath() {
  const dir = process.env.LLM_GATEWAY_DATA_DIR || './data';
  return join(dir, 'gateway.db');
}
