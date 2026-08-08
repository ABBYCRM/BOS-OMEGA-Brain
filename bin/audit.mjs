#!/usr/bin/env node
// bin/audit.mjs
// Run a self-audit from the CLI.
// Usage:
//   node bin/audit.mjs              # full audit (5 phases)
//   node bin/audit.mjs --quick      # quick health + drift
//   node bin/audit.mjs --json       # raw JSON to stdout

import { Auditor } from '../lib/auditor.js';
import { resolve } from 'node:path';

const args = new Set(process.argv.slice(2));
const mode = args.has('--quick') ? 'quick' : 'full';
const json = args.has('--json');
const root = resolve(process.env.LLM_GATEWAY_ROOT || process.cwd());

const auditor = new Auditor({ root, mode });
const report = await auditor.run();

if (json) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  const p0 = report.p0_count || 0;
  const p1 = report.p1_count || 0;
  const p2 = report.p2_count || 0;
  const unv = report.unverified_fixes || 0;
  console.log(`\n=== llm-gateway self-audit (${report.mode}) ===`);
  console.log(`status:           ${report.status}`);
  console.log(`duration:         ${report.duration_ms}ms`);
  console.log(`files inventoried:${report.inventory_files}`);
  console.log(`findings:         P0=${p0}  P1=${p1}  P2=${p2}`);
  console.log(`verified fixes:   ${report.verified_fixes}   unverified: ${unv}`);
  if (p0 > 0) {
    console.log('\n--- P0 findings (must fix) ---');
    for (const f of (report.phases.phase2_static.findings || []).filter(x => x.severity === 'P0').slice(0, 20)) {
      console.log(`  ${f.file}:${f.line}  [${f.rule}]  ${f.message}`);
      if (f.snippet) console.log(`    > ${f.snippet}`);
      if (f.fix) console.log(`    fix: ${f.fix}`);
    }
  }
  if (p1 > 0) {
    console.log('\n--- P1 findings (top 20) ---');
    for (const f of (report.phases.phase2_static.findings || []).filter(x => x.severity === 'P1').slice(0, 20)) {
      console.log(`  ${f.file}:${f.line}  [${f.rule}]  ${f.message}`);
    }
  }
  if (unv > 0) {
    console.log('\n--- UNVERIFIED claimed fixes (possible hallucinations) ---');
    for (const u of (report.phases.phase3_verify.unverified || []).slice(0, 20)) {
      console.log(`  identifier not found in source: ${u.id}`);
    }
  }
  console.log('');
}

process.exit(report.status === 'VERIFIED_COMPLETE' ? 0 : 1);
