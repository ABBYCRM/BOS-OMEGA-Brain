// lib/tools.js
// Tool-use ownership for the Node brain: web search + GitHub read tools.
// Evidence is returned structured for EPISTEMIC injection. No hallucinated results.

import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT = 12_000;

export class ToolRegistry {
  constructor({ vault, fetchImpl } = {}) {
    this.vault = vault || null;
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  /** Resolve a secret: vault first, then process.env. */
  _secret(name) {
    if (this.vault?.enabled) {
      try {
        const v = this.vault.get(name);
        if (v) return v;
      } catch { /* fall through */ }
    }
    return process.env[name] || '';
  }

  list() {
    return [
      { name: 'web_search', description: 'Search the web (DuckDuckGo HTML). Returns title/url/snippet hits.' },
      { name: 'github_repo', description: 'Fetch GitHub repository metadata. Requires GITHUB_TOKEN.' },
      { name: 'github_file', description: 'Read a file from an allowlisted GitHub repo. Requires GITHUB_TOKEN.' },
      { name: 'github_search', description: 'Search code in a GitHub repo. Requires GITHUB_TOKEN.' },
    ];
  }

  async run(name, args = {}) {
    const id = `tool_${randomUUID().slice(0, 10)}`;
    const started = Date.now();
    try {
      let result;
      switch (name) {
        case 'web_search':
          result = await this.webSearch(args.query || args.q || '', args.limit || 5);
          break;
        case 'github_repo':
          result = await this.githubRepo(args.repository || args.repo);
          break;
        case 'github_file':
          result = await this.githubFile(args.repository || args.repo, args.path);
          break;
        case 'github_search':
          result = await this.githubSearch(args.repository || args.repo, args.query || args.q, args.limit || 10);
          break;
        default:
          return { id, ok: false, tool: name, error: 'unknown_tool', latency_ms: Date.now() - started };
      }
      return { id, ok: true, tool: name, result, latency_ms: Date.now() - started };
    } catch (e) {
      return {
        id,
        ok: false,
        tool: name,
        error: e.message || 'tool_error',
        latency_ms: Date.now() - started,
      };
    }
  }

  async webSearch(query, limit = 5) {
    const q = encodeURIComponent(String(query || '').slice(0, 200));
    if (!q) return { hits: [], query: '' };
    const url = `https://html.duckduckgo.com/html/?q=${q}`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
      headers: {
        'user-agent': 'AionBrain/0.1.11 (+tool web_search)',
        'accept': 'text/html',
      },
    });
    if (!res.ok) throw new Error(`web_search_http_${res.status}`);
    const html = await res.text();
    const hits = [];
    const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>|)/gi;
    let m;
    while ((m = blockRe.exec(html)) !== null && hits.length < limit) {
      let finalUrl = m[1] || '';
      try {
        const u = new URL(finalUrl, 'https://duckduckgo.com');
        if (u.searchParams.has('uddg')) finalUrl = decodeURIComponent(u.searchParams.get('uddg'));
      } catch { /* keep */ }
      hits.push({
        title: stripHtml(m[2]).slice(0, 200),
        url: finalUrl,
        snippet: stripHtml(m[3]).slice(0, 300),
      });
    }
    return { query: String(query || ''), hits };
  }

  async githubRepo(repository) {
    const token = this._secret('GITHUB_TOKEN');
    if (!token) throw new Error('github_not_configured');
    if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error('invalid_repository');
    }
    this._assertAllowlisted(repository);
    const res = await this.fetchImpl(`https://api.github.com/repos/${repository}`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `github_http_${res.status}`);
    return {
      full_name: body.full_name,
      description: body.description,
      default_branch: body.default_branch,
      stars: body.stargazers_count,
      open_issues: body.open_issues_count,
      html_url: body.html_url,
    };
  }

  async githubFile(repository, path) {
    const token = this._secret('GITHUB_TOKEN');
    if (!token) throw new Error('github_not_configured');
    if (!repository || !path) throw new Error('repository_and_path_required');
    this._assertAllowlisted(repository);
    const res = await this.fetchImpl(
      `https://api.github.com/repos/${repository}/contents/${encodeURI(path)}`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(DEFAULT_TIMEOUT) }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `github_http_${res.status}`);
    if (body.encoding === 'base64' && body.content) {
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      return { path: body.path, sha: body.sha, size: body.size, content: text.slice(0, 100_000) };
    }
    return { path: body.path, type: body.type, message: 'not_a_file' };
  }

  async githubSearch(repository, query, limit = 10) {
    const token = this._secret('GITHUB_TOKEN');
    if (!token) throw new Error('github_not_configured');
    if (!repository || !query) throw new Error('repository_and_query_required');
    this._assertAllowlisted(repository);
    const q = encodeURIComponent(`repo:${repository} ${query}`);
    const res = await this.fetchImpl(
      `https://api.github.com/search/code?q=${q}&per_page=${Math.min(limit, 20)}`,
      { headers: { ...githubHeaders(token), Accept: 'application/vnd.github.text-match+json' }, signal: AbortSignal.timeout(DEFAULT_TIMEOUT) }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `github_http_${res.status}`);
    return {
      total: body.total_count || 0,
      items: (body.items || []).map(i => ({
        path: i.path,
        url: i.html_url,
        name: i.name,
      })),
    };
  }

  _assertAllowlisted(repository) {
    const raw = process.env.GITHUB_ALLOWED_REPOSITORIES || '';
    if (!raw.trim()) return; // open if unset (dev)
    const allowed = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(repository.toLowerCase())) {
      throw new Error(`repository_not_allowlisted:${repository}`);
    }
  }
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'AionBrain/0.1.11',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

export function createTools(opts) {
  return new ToolRegistry(opts);
}
