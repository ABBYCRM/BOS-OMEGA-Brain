// lib/brain.js
// BOS-OMEGA brain layer: autonomous audit → research → propose → validate.
// Fact-rooted. No hallucination of fixes. External research required for patches.
// intentionally-sync for deterministic inventory walk when needed.

import { Auditor } from './auditor.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const RESEARCH_TIMEOUT_MS = 12_000;

/**
 * Brain: closed-loop self-improvement runtime.
 * 1. Run full Auditor
 * 2. For each P0/P1 finding, attempt external research (caller supplies researchFn)
 * 3. Produce structured proposals only (never auto-apply by default)
 * 4. Re-audit after optional apply
 */
export class Brain {
  constructor({ root, store, researchFn, tools, memory } = {}) {
    this.root = root || process.cwd();
    this.store = store || null;
    this.researchFn = researchFn || defaultResearch;
    this.tools = tools || null;
    this.memory = memory || null;
  }

  /**
   * Full cycle: audit → research → proposals
   * @param {object} opts
   * @param {boolean} opts.apply  if true, write accepted patches (default false)
   * @param {string[]} opts.severities  which severities to act on (default ['P0','P1'])
   */
  async runCycle({ apply = false, severities = ['P0', 'P1'] } = {}) {
    const start = Date.now();
    const auditor = new Auditor({ root: this.root, mode: 'full' });
    const report = await auditor.run();

    const findings = (report.phases?.phase2_static?.findings || [])
      .filter(f => severities.includes(f.severity));

    const proposals = [];
    for (const finding of findings.slice(0, 12)) { // hard cap to stay safe
      const research = await this._researchFinding(finding);
      const proposal = this._buildProposal(finding, research);
      proposals.push(proposal);
    }

    let applied = [];
    if (apply) {
      for (const p of proposals) {
        if (p.safe_to_apply && p.patch) {
          try {
            this._applyPatch(p);
            applied.push({ file: p.file, rule: p.rule, status: 'applied' });
          } catch (e) {
            applied.push({ file: p.file, rule: p.rule, status: 'failed', error: e.message });
          }
        }
      }
    }

    // Re-audit if anything was applied
    let postReport = null;
    if (applied.length > 0) {
      const postAuditor = new Auditor({ root: this.root, mode: 'full' });
      postReport = await postAuditor.run();
    }

    const result = {
      ts: Date.now(),
      duration_ms: Date.now() - start,
      pre_audit: {
        status: report.status,
        p0: report.p0_count,
        p1: report.p1_count,
        p2: report.p2_count,
      },
      findings_examined: findings.length,
      proposals,
      applied,
      post_audit: postReport ? {
        status: postReport.status,
        p0: postReport.p0_count,
        p1: postReport.p1_count,
      } : null,
      mode: apply ? 'apply' : 'propose_only',
    };

    // Persist if store available
    if (this.store?.recordAudit) {
      try {
        this.store.recordAudit({
          ...result,
          mode: 'brain_cycle',
          status: result.post_audit?.status || result.pre_audit.status,
          inventory_files: report.inventory_files,
          p0_count: result.post_audit?.p0 ?? result.pre_audit.p0,
          p1_count: result.post_audit?.p1 ?? result.pre_audit.p1,
          p2_count: report.p2_count,
          verified_fixes: report.verified_fixes,
          unverified_fixes: report.unverified_fixes,
          duration_ms: result.duration_ms,
        });
      } catch { /* non-fatal */ }
    }

    return result;
  }

  async _researchFinding(finding) {
    const query = `${finding.rule} ${finding.message} node.js express fix site:github.com OR site:stackoverflow.com`;
    try {
      const results = await this.researchFn(query, { timeout: RESEARCH_TIMEOUT_MS });
      return {
        query,
        hits: Array.isArray(results) ? results.slice(0, 5) : [],
        researched_at: Date.now(),
      };
    } catch (e) {
      return { query, error: e.message, hits: [] };
    }
  }

  _buildProposal(finding, research) {
    // Never invent a patch body. Evidence-backed proposal only.
    // safe_to_apply stays false unless a concrete, previously verified local patch exists.
    const knownSafe = this._knownSafePatch(finding);
    const evidence = (research?.hits || []).filter(h => h.url || h.snippet);
    const evidence_strength = evidence.length >= 3 ? 'strong' : evidence.length >= 1 ? 'weak' : 'none';

    // Verified-patch loop step: structured proposal with citations, still propose-only.
    const proposal = {
      rule: finding.rule,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      message: finding.message,
      snippet: finding.snippet || '',
      suggested_fix: finding.fix || '',
      research,
      evidence_strength,
      citations: evidence.slice(0, 5).map((h, i) => ({
        n: i + 1,
        title: h.title || '',
        url: h.url || '',
        snippet: (h.snippet || '').slice(0, 200),
      })),
      safe_to_apply: !!knownSafe,
      patch: knownSafe || null,
      rationale: knownSafe
        ? 'Patch derived from previously verified local improvement (0.1.5 hardening).'
        : evidence_strength === 'none'
          ? 'No verified local patch and no external evidence. Human review required.'
          : `Evidence-backed proposal (${evidence_strength}). Patch body not auto-generated; citations provided for human or downstream agent to implement.`,
      loop: 'audit→research→propose',
      verified: false, // becomes true only after human/agent confirms and re-audit passes
    };

    // Persist proposal episode if memory available
    if (this.memory?.rememberEpisode) {
      try {
        this.memory.rememberEpisode({
          sessionId: 'brain-cycle',
          role: 'brain',
          content: `proposal ${finding.rule} @ ${finding.file}:${finding.line} evidence=${evidence_strength}`,
          meta: { rule: finding.rule, file: finding.file, evidence_strength },
        });
      } catch { /* non-fatal */ }
    }

    return proposal;
  }

  _knownSafePatch(finding) {
    // Only return patches that were already implemented and verified in 0.1.5.
    // This prevents hallucination of new code.
    if (finding.rule === 'P1-json-parse-no-try' && finding.file === 'lib/router.js') {
      return {
        description: 'Wrap JSON.parse in try/catch → typed invalid_json error',
        // Actual patch already present in local 0.1.5; this is a no-op marker
        already_applied: true,
      };
    }
    if (finding.rule === 'P1-json-parse-no-try' && finding.file === 'lib/store.js') {
      return {
        description: 'Guard lastAudit JSON.parse against corrupt report_json',
        already_applied: true,
      };
    }
    if (finding.rule === 'P1-process-exit') {
      return {
        description: 'Rule updated to ignore bin/, test/, and graceful shutdown contexts',
        already_applied: true,
      };
    }
    return null;
  }

  _applyPatch(proposal) {
    // Intentionally minimal: only allow re-application of already-verified local patches.
    // Full auto-edit of arbitrary files is disabled to prevent hallucinated code.
    if (!proposal.patch?.already_applied) {
      throw new Error('Refusing to apply unverified patch');
    }
    // Nothing to write — already present in the tree.
  }
}

/**
 * Default research: keyless DuckDuckGo HTML search.
 * Returns up to 5 { title, url, snippet } hits. No API key required.
 * Callers can still inject a richer researchFn (Brave, Tavily, etc.).
 */
async function defaultResearch(query, { timeout = RESEARCH_TIMEOUT_MS } = {}) {
  const q = encodeURIComponent(String(query || '').slice(0, 200));
  if (!q) return [];
  const url = `https://html.duckduckgo.com/html/?q=${q}`;
  try {
    // signal + AbortSignal.timeout must sit inside the static rule's 4-line window.
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeout), headers: {
      'user-agent': 'AionBrain/0.1.10 (+self-audit research; +https://github.com/ABBYCRM)',
      'accept': 'text/html',
    }});
    if (!res.ok) return [{ title: `research_http_${res.status}`, url: '', snippet: `DuckDuckGo returned ${res.status}` }];
    const html = await res.text();
    const hits = [];
    // Parse result blocks: <a class="result__a" href="...">title</a> + snippet in result__snippet
    const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>|)/gi;
    let m;
    while ((m = blockRe.exec(html)) !== null && hits.length < 5) {
      const rawUrl = m[1] || '';
      // DDG wraps outbound links; unwrap uddg= if present
      let finalUrl = rawUrl;
      try {
        const u = new URL(rawUrl, 'https://duckduckgo.com');
        if (u.searchParams.has('uddg')) finalUrl = decodeURIComponent(u.searchParams.get('uddg'));
      } catch { /* keep raw */ }
      const title = stripHtml(m[2] || '').trim().slice(0, 200);
      const snippet = stripHtml(m[3] || '').trim().slice(0, 300);
      if (title || finalUrl) hits.push({ title: title || finalUrl, url: finalUrl, snippet });
    }
    if (hits.length === 0) {
      return [{ title: 'no_results', url: '', snippet: 'DuckDuckGo returned no parseable results for this query.' }];
    }
    return hits;
  } catch (e) {
    return [{ title: 'research_error', url: '', snippet: String(e.message || e).slice(0, 200) }];
  }
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
}

export function createBrain(opts) {
  return new Brain(opts);
}
