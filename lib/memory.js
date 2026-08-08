// lib/memory.js
// intentionally-sync: better-sqlite3 + first-run dir creation must be deterministic.
// Durable agent memory: episodic turns, long-term facts, goals.
// Backed by SQLite (same data dir as Store). Cross-session by design.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class AgentMemory {
  constructor(dbPath) {
    const path = dbPath || join(process.env.LLM_GATEWAY_DATA_DIR || './data', 'memory.db');
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        session_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        decision_state TEXT,
        decision_score REAL,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ep_ts ON episodes(ts);
      CREATE INDEX IF NOT EXISTS idx_ep_session ON episodes(session_id, ts);

      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        confidence REAL DEFAULT 0.7,
        source TEXT,
        UNIQUE(subject, predicate, object)
      );
      CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);

      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        priority INTEGER DEFAULT 5,
        progress REAL DEFAULT 0,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status, priority);
    `);
  }

  rememberEpisode({ sessionId, role, content, decisionState, decisionScore, meta }) {
    const id = `ep_${randomUUID().slice(0, 12)}`;
    this.db.prepare(`
      INSERT INTO episodes (id, ts, session_id, role, content, decision_state, decision_score, meta)
      VALUES (@id, @ts, @session_id, @role, @content, @decision_state, @decision_score, @meta)
    `).run({
      id,
      ts: Date.now(),
      session_id: sessionId || null,
      role: role || 'system',
      content: String(content || '').slice(0, 50_000),
      decision_state: decisionState || null,
      decision_score: decisionScore ?? null,
      meta: meta ? JSON.stringify(meta) : null,
    });
    return id;
  }

  recentEpisodes({ sessionId, limit = 20 } = {}) {
    if (sessionId) {
      return this.db.prepare(`
        SELECT * FROM episodes WHERE session_id = ? ORDER BY ts DESC LIMIT ?
      `).all(sessionId, limit);
    }
    return this.db.prepare(`SELECT * FROM episodes ORDER BY ts DESC LIMIT ?`).all(limit);
  }

  upsertFact({ subject, predicate, object, confidence = 0.7, source }) {
    const id = `fact_${randomUUID().slice(0, 12)}`;
    this.db.prepare(`
      INSERT INTO facts (id, ts, subject, predicate, object, confidence, source)
      VALUES (@id, @ts, @subject, @predicate, @object, @confidence, @source)
      ON CONFLICT(subject, predicate, object) DO UPDATE SET
        confidence = excluded.confidence,
        ts = excluded.ts,
        source = excluded.source
    `).run({
      id,
      ts: Date.now(),
      subject: String(subject).slice(0, 200),
      predicate: String(predicate).slice(0, 100),
      object: String(object).slice(0, 2000),
      confidence,
      source: source || null,
    });
    return id;
  }

  factsFor(subject, limit = 50) {
    return this.db.prepare(`
      SELECT * FROM facts WHERE subject = ? ORDER BY confidence DESC, ts DESC LIMIT ?
    `).all(subject, limit);
  }

  allFacts(limit = 100) {
    return this.db.prepare(`SELECT * FROM facts ORDER BY ts DESC LIMIT ?`).all(limit);
  }

  setGoal({ title, priority = 5, meta }) {
    const id = `goal_${randomUUID().slice(0, 12)}`;
    this.db.prepare(`
      INSERT INTO goals (id, ts, title, status, priority, progress, meta)
      VALUES (@id, @ts, @title, 'active', @priority, 0, @meta)
    `).run({
      id,
      ts: Date.now(),
      title: String(title).slice(0, 500),
      priority,
      meta: meta ? JSON.stringify(meta) : null,
    });
    return id;
  }

  updateGoal(id, { status, progress, meta }) {
    const g = this.db.prepare(`SELECT * FROM goals WHERE id = ?`).get(id);
    if (!g) return null;
    this.db.prepare(`
      UPDATE goals SET status = @status, progress = @progress, meta = @meta WHERE id = @id
    `).run({
      id,
      status: status || g.status,
      progress: progress ?? g.progress,
      meta: meta ? JSON.stringify(meta) : g.meta,
    });
    return this.db.prepare(`SELECT * FROM goals WHERE id = ?`).get(id);
  }

  activeGoals() {
    return this.db.prepare(`
      SELECT * FROM goals WHERE status = 'active' ORDER BY priority ASC, ts ASC
    `).all();
  }

  /** Context pack for injection into prompts / kernel. */
  contextPack({ sessionId, subject = 'aion', limit = 8 } = {}) {
    const episodes = this.recentEpisodes({ sessionId, limit });
    const facts = this.factsFor(subject, 20);
    const goals = this.activeGoals();
    return {
      episodes: episodes.map(e => ({ role: e.role, content: e.content.slice(0, 500), state: e.decision_state })),
      facts: facts.map(f => `${f.subject} ${f.predicate} ${f.object}`),
      goals: goals.map(g => ({ id: g.id, title: g.title, progress: g.progress })),
    };
  }

  close() { this.db.close(); }
}

export function createMemory(path) {
  return new AgentMemory(path);
}
