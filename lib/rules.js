// lib/rules.js
// Static analysis rules. Each rule returns an array of findings:
//   { rule, severity: 'P0'|'P1'|'P2', file, line, snippet, message, fix }
// P0 = crash, security, or correctness
// P1 = performance or leak
// P2 = style / hygiene

import { readFileSync } from 'node:fs';

const SEV = { P0: 3, P1: 2, P2: 1 };

export const RULES = [
  // ---- P0: crash / correctness ----
  {
    id: 'P0-sync-fs-in-async',
    severity: 'P0',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'Sync fs call on a hot path. Blocks event loop.',
    check(lines) {
      // Whole-file opt-out: /* intentionally-sync */ or paths in audit/*
      const fileHeader = lines.slice(0, 3).join('\n');
      if (/intentionally-sync|intentionally sync/i.test(fileHeader)) return [];
      const findings = [];
      const re = /\b(readFileSync|writeFileSync|existsSync|statSync|readdirSync)\s*\(/;
      lines.forEach((ln, i) => {
        if (re.test(ln)) findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Use async fs/promises API.' });
      });
      return findings;
    },
  },
  {
    id: 'P0-unhandled-promise',
    severity: 'P0',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'Floating promise (no await / no .catch).',
    check(lines) {
      const findings = [];
      // Heuristic: a line that starts with a Promise-returning call and is not awaited/catch'd
      const fp = /^\s*(fetch\s*\(|axios\s*\(|db\.\w+\s*\([^)]*\)\s*$|someAsync\s*\()/;
      lines.forEach((ln, i) => {
        if (fp.test(ln) && !/await\s/.test(ln) && !/\.then\s*\(/.test(ln) && !/\.catch\s*\(/.test(ln)) {
          findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Add await or .catch to prevent unhandled rejection.' });
        }
      });
      return findings;
    },
  },
  {
    id: 'P0-innerHTML-xss',
    severity: 'P0',
    exts: ['.js', '.mjs', '.cjs', '.ts', '.html'],
    message: 'innerHTML / outerHTML / insertAdjacentHTML can introduce XSS.',
    check(lines) {
      const findings = [];
      const re = /\.(innerHTML|outerHTML|insertAdjacentHTML)\s*=/;
      lines.forEach((ln, i) => {
        if (re.test(ln)) findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Use textContent or DOMPurify.sanitize().' });
      });
      return findings;
    },
  },
  {
    id: 'P0-eval',
    severity: 'P0',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'eval / new Function is unsafe.',
    check(lines) {
      const findings = [];
      const re = /\b(eval|new\s+Function)\s*\(/;
      lines.forEach((ln, i) => {
        if (re.test(ln)) findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Remove eval; use a safe parser.' });
      });
      return findings;
    },
  },
  {
    id: 'P0-secret-in-source',
    severity: 'P0',
    exts: ['.js', '.mjs', '.cjs', '.ts', '.json', '.env'],
    message: 'Looks like a hardcoded secret (sk-..., ghp_..., AKIA...).',
    check(lines) {
      const findings = [];
      const re = /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]+)\b/;
      lines.forEach((ln, i) => {
        if (re.test(ln)) findings.push({ line: i + 1, snippet: ln.trim().slice(0, 80) + '…', fix: 'Move to env var or secret manager.' });
      });
      return findings;
    },
  },
  {
    id: 'P0-sql-injection',
    severity: 'P0',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'String-concatenated SQL — use parameterized queries.',
    check(lines) {
      const findings = [];
      const re = /(SELECT|INSERT|UPDATE|DELETE).*\+.*['"]\s*(FROM|INTO|SET|WHERE)/i;
      lines.forEach((ln, i) => {
        if (re.test(ln)) findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Use ? placeholders with prepared statements.' });
      });
      return findings;
    },
  },
  {
    id: 'P0-no-timeout',
    severity: 'P0',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'fetch/axios without timeout. Hung calls leak resources.',
    check(lines, filePath) {
      // Test runners and CLIs are allowed short-deadline fetches.
      if (/^test\//.test(filePath) || /^bin\//.test(filePath)) return [];
      const findings = [];
      lines.forEach((ln, i) => {
        // Skip whole-line comments
        if (/^\s*(\/\/|\*|<!--|#)/.test(ln)) return;
        // Strip trailing comments: remove //... from end of line
        const code = ln.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
        if (/\bfetch\s*\(/.test(code)) {
          const window = lines.slice(i, i + 4).join(' ');
          if (!/AbortSignal|signal:|timeout/i.test(window)) {
            findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Pass AbortSignal with a timeout (e.g. AbortSignal.timeout(30_000)).' });
          }
        }
      });
      return findings;
    },
  },

  // ---- P1: performance / leak ----
  {
    id: 'P1-regex-no-anchor',
    severity: 'P1',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'User-input regex without anchor can backtrack catastrophically.',
    check(lines) {
      const findings = [];
      const re = /new\s+RegExp\s*\(\s*[a-zA-Z_$][^)]*\)/;
      lines.forEach((ln, i) => {
        if (re.test(ln)) findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Validate input length and escape; prefer literal regex.' });
      });
      return findings;
    },
  },
  {
    id: 'P1-nested-loop',
    severity: 'P1',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'Nested for/forEach with no break — likely O(n^2).',
    check(lines) {
      const findings = [];
      const forRe = /^\s*for\s*\(/;
      const forEachRe = /\.forEach\s*\(/;
      lines.forEach((ln, i) => {
        if (forRe.test(ln) || forEachRe.test(ln)) {
          // Look ahead up to 12 lines for another for/foreach
          const win = lines.slice(i + 1, i + 13).join('\n');
          if (forRe.test(win) || forEachRe.test(win)) {
            findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Consider a Map/Set keyed lookup.' });
          }
        }
      });
      return findings;
    },
  },
  {
    id: 'P1-setinterval-no-clear',
    severity: 'P1',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'setInterval declared; check that clearInterval is paired.',
    check(lines) {
      const findings = [];
      const sets = [];
      lines.forEach((ln, i) => {
        const m = ln.match(/setInterval\s*\(/);
        if (m) sets.push(i + 1);
      });
      if (sets.length === 0) return findings;
      const clears = lines.some(ln => /clearInterval\s*\(/.test(ln));
      if (!clears) {
        sets.forEach(line => findings.push({ line, snippet: '', fix: 'Ensure clearInterval is called on shutdown.' }));
      }
      return findings;
    },
  },
  {
    id: 'P1-large-string-concat',
    severity: 'P1',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'String built with += in a loop. Use array.join().',
    check(lines) {
      const findings = [];
      lines.forEach((ln, i) => {
        if (/=\s*[a-zA-Z_$][\w.]*\s*\+\s*['"`]/.test(ln) || /=\s*['"`]\s*\+\s*[a-zA-Z_$]/.test(ln)) {
          // Simple heuristic
          const win = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
          if (/for\s*\(/.test(win) || /\.forEach\s*\(/.test(win) || /\.map\s*\(/.test(win)) {
            findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Push to an array and join at the end.' });
          }
        }
      });
      return findings;
    },
  },
  {
    id: 'P1-await-in-loop',
    severity: 'P1',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'await inside a for/forEach. Use Promise.all for parallelism.',
    check(lines) {
      const findings = [];
      lines.forEach((ln, i) => {
        if (/^\s*(for|while)\s*\(/.test(ln) || /\.forEach\s*\(/.test(ln)) {
          const win = lines.slice(i + 1, i + 8).join('\n');
          if (/\bawait\s+/.test(win)) {
            findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Collect promises and await Promise.all.' });
          }
        }
      });
      return findings;
    },
  },
  {
    id: 'P1-json-parse-no-try',
    severity: 'P1',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'JSON.parse without try/catch. Throws on malformed input.',
    check(lines) {
      const findings = [];
      lines.forEach((ln, i) => {
        if (/JSON\.parse\s*\(/.test(ln)) {
          // Look back 5 lines for try
          const win = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
          if (!/\btry\s*\{/.test(win)) {
            findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Wrap in try/catch; return a typed error.' });
          }
        }
      });
      return findings;
    },
  },
  {
    id: 'P1-no-cache-control',
    severity: 'P2',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'Static asset served without Cache-Control. Browser will re-download.',
    check(lines) {
      const findings = [];
      // Heuristic only — flagged on server.js style files
      lines.forEach((ln, i) => {
        if (/express\.static\s*\(/.test(ln) || /res\.sendFile\s*\(/.test(ln)) {
          const win = lines.slice(i, i + 6).join('\n');
          if (!/Cache-Control|maxAge/i.test(win)) {
            findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Set maxAge via express.static or a middleware.' });
          }
        }
      });
      return findings;
    },
  },
  {
    id: 'P2-todo',
    severity: 'P2',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'TODO marker — unfinished work in production code.',
    check(lines) {
      const findings = [];
      const re = /\b(TODO|FIXME|XXX)\b/;
      lines.forEach((ln, i) => {
        if (re.test(ln)) findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Resolve or move to issue tracker.' });
      });
      return findings;
    },
  },
  {
    id: 'P2-console-log',
    severity: 'P2',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'console.log in production code path.',
    check(lines) {
      const findings = [];
      const re = /\bconsole\.(log|debug)\s*\(/;
      lines.forEach((ln, i) => {
        if (re.test(ln)) findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Use a logger with levels; gate debug logs.' });
      });
      return findings;
    },
  },
  {
    id: 'P2-magic-number',
    severity: 'P2',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'Magic number in condition. Name it.',
    check(lines) {
      const findings = [];
      // Skip — kept lightweight to avoid noise
      return findings;
    },
  },
  {
    id: 'P1-cors-wide-open',
    severity: 'P1',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'CORS origin: "*" with credentials is a misconfig.',
    check(lines) {
      const findings = [];
      lines.forEach((ln, i) => {
        if (/origin\s*:\s*['"]\*['"]/.test(ln) && /credentials\s*:\s*true/.test(lines.slice(i, i + 3).join(' '))) {
          findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Specify an allowlist; do not combine * with credentials.' });
        }
      });
      return findings;
    },
  },
  {
    id: 'P1-no-body-limit',
    severity: 'P1',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'JSON body parser has no explicit limit. DoS risk.',
    check(lines) {
      const findings = [];
      lines.forEach((ln, i) => {
        if (/express\.json\s*\(/.test(ln) && !/limit\s*:/.test(ln)) {
          findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Add limit option (e.g. "1mb").' });
        }
      });
      return findings;
    },
  },
  {
    id: 'P1-process-exit',
    severity: 'P1',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'process.exit in request handler kills the server.',
    check(lines, filePath) {
      // CLI binaries, test runners, and intentional graceful shutdown are allowed.
      if (/^bin\//.test(filePath) || /^test\//.test(filePath)) return [];
      const findings = [];
      lines.forEach((ln, i) => {
        if (/process\.exit\s*\(/.test(ln)) {
          // Allow if surrounding context mentions shutdown / SIGTERM / SIGINT
          const win = lines.slice(Math.max(0, i - 6), i + 2).join('\n');
          if (/shutdown|SIGTERM|SIGINT|graceful/i.test(win)) return;
          findings.push({ line: i + 1, snippet: ln.trim().slice(0, 160), fix: 'Return an error response instead.' });
        }
      });
      return findings;
    },
  },
  {
    id: 'P1-no-graceful-shutdown',
    severity: 'P1',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'No SIGTERM/SIGINT handlers — in-flight requests will be killed.',
    check(lines) {
      const findings = [];
      const hasSigterm = lines.some(ln => /SIGTERM|SIGINT/.test(ln));
      const hasListen = lines.some(ln => /\.listen\s*\(/.test(ln));
      if (hasListen && !hasSigterm) {
        findings.push({ line: 1, snippet: '', fix: 'Add process.on("SIGTERM", ...) to drain in-flight requests.' });
      }
      return findings;
    },
  },
  {
    id: 'P1-no-request-id',
    severity: 'P1',
    exts: ['.js', '.mjs', '.cjs', '.ts'],
    message: 'No request-ID propagation. Hard to trace failures across services.',
    check(lines) {
      const findings = [];
      const hasListen = lines.some(ln => /\.listen\s*\(/.test(ln));
      const hasReqId = lines.some(ln => /x-request-id|req\.id/.test(ln));
      if (hasListen && !hasReqId) {
        findings.push({ line: 1, snippet: '', fix: 'Assign req.id from x-request-id header; log it on every error.' });
      }
      return findings;
    },
  },
];

export function auditFile({ filePath, content }) {
  const fileExt = ext(filePath);
  if (!fileExt) return [];
  const applicable = RULES.filter(r => r.exts.includes(fileExt));
  const lines = content.split('\n');
  const findings = [];
  for (const rule of applicable) {
    try {
      const hits = rule.check(lines, filePath);
      for (const h of hits) {
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          file: filePath,
          line: h.line,
          message: rule.message,
          snippet: h.snippet,
          fix: h.fix,
        });
      }
    } catch (e) {
      findings.push({ rule: rule.id, severity: 'P2', file: filePath, line: 0, message: `rule error: ${e.message}`, snippet: '', fix: '' });
    }
  }
  return findings;
}

function ext(p) {
  const i = p.lastIndexOf('.');
  if (i < 0 || i < p.length - 6) return null;
  return p.slice(i).toLowerCase();
}

export function severityRank(s) { return SEV[s] || 0; }
