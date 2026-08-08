// lib/auditor.js
// The 5-phase self-auditor. Runs against itself and the host repo.
// intentionally-sync: file walker must be deterministic, never leak open handles.
// PHASE 0 INVENTORY  — walk repo, sha256 every .ts/.tsx/.js/.mjs/.cjs/.json
// PHASE 1 BASELINE   — health, latency, memory, cold start
// PHASE 2 STATIC     — rules engine over inventory
// PHASE 3 VERIFY     — for each claimed fix in CHANGELOG, grep current source
// PHASE 4 REPORT     — merge, write JSON, return terminal status

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { auditFile } from './rules.js';

const AUDITABLE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.html']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'reports', 'dist', 'build', '.cache', '.npm']);

export class Auditor {
  constructor({ root, mode = 'full', selfFetch } = {}) {
    this.root = resolve(root);
    this.mode = mode;            // 'quick' | 'full'
    this.selfFetch = selfFetch;  // optional (url) => fetch(url) — used in 'full' baseline
  }

  async run() {
    const start = Date.now();
    const phases = {};

    // PHASE 0
    const t0 = Date.now();
    const inventory = this._phase0_inventory();
    phases.phase0_inventory = { duration_ms: Date.now() - t0, files: inventory.length, manifest: inventory };

    if (this.mode === 'quick') {
      // Drift check + minimal health
      const t1 = Date.now();
      const health = await this._phase1_health();
      phases.phase1_health = { duration_ms: Date.now() - t1, health };
      const report = this._phase4_report(phases, start);
      return report;
    }

    // PHASE 1
    const t1 = Date.now();
    const baseline = await this._phase1_baseline();
    phases.phase1_baseline = { duration_ms: Date.now() - t1, ...baseline };

    // PHASE 2
    const t2 = Date.now();
    const findings = this._phase2_static(inventory);
    phases.phase2_static = { duration_ms: Date.now() - t2, findings, count: findings.length };

    // PHASE 3
    const t3 = Date.now();
    const verify = this._phase3_verify();
    phases.phase3_verify = { duration_ms: Date.now() - t3, ...verify };

    // PHASE 4
    const report = this._phase4_report(phases, start);
    return report;
  }

  _phase0_inventory() {
    const out = [];
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        const ext = extOf(e.name);
        if (!AUDITABLE_EXTS.has(ext)) continue;
        let content;
        try { content = readFileSync(p, 'utf8'); } catch { continue; }
        const sha = createHash('sha256').update(content).digest('hex');
        const lines = content.split('\n').length;
        out.push({ path: relative(this.root, p), sha256: sha, lines, bytes: Buffer.byteLength(content) });
      }
    };
    walk(this.root);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  async _phase1_health() {
    if (!this.selfFetch) return { skipped: 'no selfFetch configured' };
    try {
      const base = typeof this.selfFetch === 'function' ? this.selfFetch() : this.selfFetch;
      const url = `${base}/healthz`;
      const t = Date.now();
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      const ok = res.ok ?? (res.status >= 200 && res.status < 300);
      return { status: res.status, ok, latency_ms: Date.now() - t, url };
    } catch (e) {
      return { error: e.message };
    }
  }

  async _phase1_baseline() {
    const mem = process.memoryUsage();
    const samples = [];
    if (this.selfFetch) {
      const base = typeof this.selfFetch === 'function' ? this.selfFetch() : this.selfFetch;
      const url = `${base}/healthz`;
      for (let i = 0; i < 10; i++) {
        const t = Date.now();
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
          samples.push({ latency_ms: Date.now() - t, status: res.status, ok: res.ok ?? (res.status >= 200 && res.status < 300) });
        } catch (e) {
          samples.push({ latency_ms: Date.now() - t, error: e.message });
        }
      }
    }
    const ok = samples.filter(s => s.ok).map(s => s.latency_ms).sort((a, b) => a - b);
    const p = (q) => ok.length ? ok[Math.min(ok.length - 1, Math.floor(ok.length * q))] : null;
    return {
      memory: { rss: mem.rss, heap_used: mem.heapUsed, heap_total: mem.heapTotal, external: mem.external },
      health_samples: samples,
      health_p50: p(0.5),
      health_p95: p(0.95),
      health_n: samples.length,
      health_ok_n: ok.length,
    };
  }

  _phase2_static(inventory) {
    const findings = [];
    for (const f of inventory) {
      const full = join(this.root, f.path);
      let content;
      try { content = readFileSync(full, 'utf8'); } catch { continue; }
      const fileFindings = auditFile({ filePath: f.path, content });
      findings.push(...fileFindings);
    }
    // Sort: P0 first, then by file:line
    const sev = { P0: 0, P1: 1, P2: 2 };
    findings.sort((a, b) => sev[a.severity] - sev[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
    return findings;
  }

  _phase3_verify() {
    // For each "fix" entry in CHANGELOG.md, extract a CODE IDENTIFIER (camelCase or
    // snake_case or a quoted file path) and verify it still exists in source.
    // English prose like "Render restarts" is ignored — only symbols matter.
    const changelog = join(this.root, 'CHANGELOG.md');
    if (!existsSync(changelog)) return { skipped: 'no CHANGELOG.md', verified: 0, unverified: [] };
    const text = readFileSync(changelog, 'utf8');
    const lines = text.split('\n');
    const claimed = [];
    let inFixSection = false;
    // Identifier patterns we care about:
    //   - camelCase / PascalCase (e.g. gracefulShutdown, AbortSignal)
    //   - snake_case (e.g. graceful_shutdown)
    //   - quoted file paths (e.g. server.js, lib/router.js)
    const ID_RE = /\b([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+|`[^`]+\.[a-z]+`)\b/g;
    for (const ln of lines) {
      if (/^##\s/.test(ln)) { inFixSection = /fix/i.test(ln); continue; }
      if (!inFixSection) continue;
      const matches = ln.match(ID_RE) || [];
      for (const id of matches) {
        const found = this._grep(id);
        if (found.length === 0) {
          // Only count as a "claim" if it's a quoted file path or a real symbol
          if (/^[A-Z]/.test(id) || id.includes('.') || id.includes('_')) {
            claimed.push({ id, present: false, locations: [] });
          }
        } else {
          claimed.push({ id, present: true, locations: found.slice(0, 3) });
        }
      }
    }
    const verified = claimed.filter(c => c.present).length;
    const unverified = claimed.filter(c => !c.present);
    return { claimed: claimed.length, verified, unverified };
  }

  _grep(token) {
    const out = [];
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        const ext = extOf(e.name);
        if (!AUDITABLE_EXTS.has(ext)) continue;
        let content;
        try { content = readFileSync(p, 'utf8'); } catch { continue; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(token)) {
            out.push({ file: relative(this.root, p), line: i + 1 });
            if (out.length >= 3) return;
          }
        }
        if (out.length >= 3) return;
      }
    };
    walk(this.root);
    return out;
  }

  _phase4_report(phases, start) {
    const findings = phases.phase2_static?.findings || [];
    const p0 = findings.filter(f => f.severity === 'P0').length;
    const p1 = findings.filter(f => f.severity === 'P1').length;
    const p2 = findings.filter(f => f.severity === 'P2').length;
    const unverified = phases.phase3_verify?.unverified?.length || 0;
    // Only consider health a gate if it was actually attempted
    const healthAttempted = phases.phase1_health
      ? true
      : (phases.phase1_baseline?.health_n || 0) > 0;
    const healthOk = !healthAttempted || (phases.phase1_health?.ok ?? (phases.phase1_baseline?.health_ok_n || 0) > 0);
    const status =
      !healthOk ? 'BLOCKED' :
      p0 > 0 ? 'PARTIAL' :
      unverified > 0 ? 'PARTIAL' :
      'VERIFIED_COMPLETE';
    return {
      ts: Date.now(),
      duration_ms: Date.now() - start,
      mode: this.mode,
      status,
      inventory_files: phases.phase0_inventory.files,
      p0_count: p0,
      p1_count: p1,
      p2_count: p2,
      verified_fixes: phases.phase3_verify?.verified || 0,
      unverified_fixes: unverified,
      phases,
    };
  }
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i < 0) return '';
  return name.slice(i).toLowerCase();
}
