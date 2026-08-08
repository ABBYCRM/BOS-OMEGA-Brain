// lib/lattice.js
// Multi-agent lattice: parallel roles (researcher, critic, executor) with
// structured debate and a consensus gate before COMMIT.
// Does not call external LLMs for role text in hermetic mode — uses
// deterministic role functions so the lattice is testable offline.

import { randomUUID } from 'node:crypto';

export const Role = Object.freeze({
  RESEARCHER: 'researcher',
  CRITIC: 'critic',
  EXECUTOR: 'executor',
});

/**
 * Lattice: run parallel role analyses, then merge.
 * @param {object} opts
 * @param {object} opts.ctx  MissionContext-like { userInput, history, metadata }
 * @param {object} opts.decision  kernel decision
 * @param {object} opts.toolEvidence  optional tool results
 * @param {object} opts.activeState  ActiveState snapshot
 * @param {object} opts.memoryPack  memory.contextPack()
 */
export async function runLattice({ ctx, decision, toolEvidence, activeState, memoryPack, tools } = {}) {
  const id = `lat_${randomUUID().slice(0, 10)}`;
  const input = String(ctx?.userInput || '');

  // Parallel role execution
  const [researcher, critic, executor] = await Promise.all([
    roleResearcher({ input, toolEvidence, tools }),
    roleCritic({ input, decision, activeState, memoryPack }),
    roleExecutor({ input, decision, toolEvidence }),
  ]);

  const votes = {
    researcher: researcher.vote,
    critic: critic.vote,
    executor: executor.vote,
  };

  // Consensus: majority, but critic REJECT vetoes COMMIT
  let consensus = majority(Object.values(votes));
  if (critic.vote === 'REJECT' && consensus === 'COMMIT') {
    consensus = 'DEFER';
  }
  // High free-energy bias
  if (activeState?.preferDefer && consensus === 'COMMIT') {
    consensus = 'DEFER';
  }

  return {
    id,
    consensus,
    votes,
    roles: { researcher, critic, executor },
    rationale: buildRationale(votes, consensus, critic, activeState),
  };
}

async function roleResearcher({ input, toolEvidence, tools }) {
  const notes = [];
  let evidenceCount = 0;
  if (toolEvidence?.ok && toolEvidence.result) {
    evidenceCount = Array.isArray(toolEvidence.result.hits)
      ? toolEvidence.result.hits.length
      : 1;
    notes.push(`tool_evidence:${toolEvidence.tool}:${evidenceCount}`);
  } else if (tools && looksLikeSearch(input)) {
    // Live research if tools available and query looks searchable
    try {
      const r = await tools.run('web_search', { query: input.slice(0, 180), limit: 3 });
      if (r.ok) {
        evidenceCount = r.result?.hits?.length || 0;
        notes.push(`live_search_hits:${evidenceCount}`);
      } else {
        notes.push(`live_search_failed:${r.error}`);
      }
    } catch (e) {
      notes.push(`live_search_error:${e.message}`);
    }
  } else {
    notes.push('no_external_evidence');
  }
  const vote = evidenceCount > 0 ? 'COMMIT' : (looksLikeSearch(input) ? 'DEFER' : 'COMMIT');
  return { role: Role.RESEARCHER, vote, evidence_count: evidenceCount, notes };
}

async function roleCritic({ input, decision, activeState, memoryPack }) {
  const notes = [];
  let vote = 'COMMIT';
  if (!input || input.trim().length < 2) {
    vote = 'REJECT';
    notes.push('empty_input');
  }
  if (decision?.state === 'DEFER') {
    vote = 'DEFER';
    notes.push('kernel_deferred');
  }
  if (activeState?.free_energy >= 0.65) {
    vote = 'DEFER';
    notes.push('high_free_energy');
  }
  if (memoryPack?.goals?.length > 0) {
    notes.push(`active_goals:${memoryPack.goals.length}`);
  }
  // Soft check: very long inputs raise uncertainty
  if (input.length > 8000) {
    notes.push('input_very_long');
    if (vote === 'COMMIT') vote = 'DEFER';
  }
  return { role: Role.CRITIC, vote, notes };
}

async function roleExecutor({ input, decision, toolEvidence }) {
  const notes = [];
  let vote = decision?.state === 'REJECT' ? 'REJECT' : 'COMMIT';
  if (toolEvidence && toolEvidence.ok === false) {
    notes.push(`tool_failed:${toolEvidence.error}`);
    vote = 'DEFER';
  }
  if (decision?.state === 'COMMIT') notes.push('kernel_commit');
  notes.push(`input_len:${input.length}`);
  return { role: Role.EXECUTOR, vote, notes };
}

function majority(votes) {
  const counts = { COMMIT: 0, DEFER: 0, REJECT: 0 };
  for (const v of votes) counts[v] = (counts[v] || 0) + 1;
  if (counts.REJECT >= 2) return 'REJECT';
  if (counts.COMMIT >= 2) return 'COMMIT';
  if (counts.DEFER >= 2) return 'DEFER';
  // tie → DEFER (safer)
  return 'DEFER';
}

function buildRationale(votes, consensus, critic, activeState) {
  return `lattice consensus=${consensus}; votes=${JSON.stringify(votes)}; critic=${(critic.notes || []).join(',')}; F=${activeState?.free_energy ?? 'n/a'}`;
}

function looksLikeSearch(text) {
  return /\b(search|find|look up|what is|who is|latest|news|how to)\b/i.test(text) || text.includes('/search');
}

export function createLattice() {
  return { runLattice };
}
