import type Anthropic from '@anthropic-ai/sdk';
import type { Memo, RunEvent, RunState, RunStatus } from './types.ts';
import { actionLabel } from './tools.ts';
import { sessionOpening } from './context.ts';

/** The run state machine. Anything not listed here is an illegal transition and throws. */
export const TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  created: ['running', 'cancelled'],
  running: ['awaiting_approval', 'executing', 'completed', 'failed', 'cancelled'],
  awaiting_approval: ['executing', 'cancelled'],
  executing: ['running', 'failed', 'cancelled'],
  completed: ['running'], // a later session picks the run back up
  failed: [],
  cancelled: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function initialState(): RunState {
  return {
    runId: '', repId: '', request: '', status: 'created', session: 1, turn: 0, continuations: 0,
    messages: [], history: [], openToolUses: [], results: {}, actions: {}, actionOrder: [], facts: [], decisions: [],
  };
}

function push(s: RunState, m: Anthropic.MessageParam) {
  s.messages.push(m);
  s.history.push(m);
}

function addUnique(list: string[], items: string[] = []) {
  for (const i of items) if (!list.includes(i)) list.push(i);
}

/** Apply one event. Deterministic: the same log always produces the same state. */
export function apply(s: RunState, e: RunEvent): void {
  switch (e.type) {
    case 'run_created':
      Object.assign(s, { runId: e.runId, repId: e.repId, request: e.request });
      push(s, { role: 'user', content: e.request });
      break;
    case 'state_changed':
      if (e.from !== s.status || !canTransition(e.from, e.to)) {
        throw new Error(`Illegal transition ${e.from} -> ${e.to} (current: ${s.status}, seq ${e.seq})`);
      }
      s.status = e.to;
      if (e.to === 'failed') s.failure = e.reason;
      break;
    case 'model_request': {
      const { type: _t, seq: _s, at: _a, actor: _c, runId: _r, ...info } = e;
      s.lastContext = info;
      break;
    }
    case 'model_response': {
      const m = e.message;
      s.turn = e.turn;
      push(s, { role: 'assistant', content: m.content });
      s.continuations = m.stop_reason === 'pause_turn' ? s.continuations + 1 : 0;
      if (m.stop_reason === 'tool_use') {
        s.openToolUses = m.content.filter((b) => b.type === 'tool_use').map((b) => (b as Anthropic.ToolUseBlock).id);
        s.results = {};
      }
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.TextBlock).text).join('\n');
      if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence') s.finalText = text;
      break;
    }
    case 'tool_result': {
      s.results[e.toolUseId] = {
        type: 'tool_result', tool_use_id: e.toolUseId, content: e.content, ...(e.isError ? { is_error: true } : {}),
      };
      addUnique(s.facts, e.facts);
      const a = s.actions[e.toolUseId];
      if (a) a.resolved = true;
      // All results for one assistant turn go back together, in tool_use order, as ONE user message.
      if (s.openToolUses.length && s.openToolUses.every((id) => s.results[id])) {
        push(s, { role: 'user', content: s.openToolUses.map((id) => s.results[id]) });
        s.openToolUses = [];
      }
      break;
    }
    case 'permission_denied':
      addUnique(s.facts, [`No access: ${e.reason}`]);
      break;
    case 'action_proposed':
      s.actions[e.action.id] = {
        ...e.action, status: e.action.needsApproval ? 'pending_approval' : 'approved',
        finalInput: e.action.input, attempts: 0, resolved: false,
      };
      s.actionOrder.push(e.action.id);
      break;
    case 'approval_decided': {
      const a = s.actions[e.actionId];
      a.decision = e.decision;
      a.decidedBy = e.by;
      a.status = e.decision.type === 'reject' ? 'rejected' : 'approved';
      if (e.decision.type === 'edit') a.finalInput = { ...a.input, ...e.decision.input };
      const verb = { approve: 'approved', edit: 'edited, then approved', reject: 'rejected' }[e.decision.type];
      const why = e.decision.type === 'reject' ? ` (reason: ${e.decision.reason})` : '';
      if (e.actor !== 'policy') s.decisions.push(`${e.by} ${verb} ${actionLabel(a.tool, a.finalInput)}${why}`);
      break;
    }
    case 'action_attempt':
      s.actions[e.actionId].attempts = e.attempt;
      break;
    case 'action_executed': {
      const a = s.actions[e.actionId];
      a.status = 'executed';
      a.result = e.result;
      addUnique(s.facts, [`Done: ${actionLabel(a.tool, a.finalInput)}`]);
      break;
    }
    case 'action_failed':
      Object.assign(s.actions[e.actionId], { status: 'failed', error: e.error });
      break;
    case 'session_started':
      s.session = e.session;
      s.finalText = undefined;
      s.messages = [{ role: 'user', content: sessionOpening(memoOf(s), s.history, e.text) }];
      s.history.push({ role: 'user', content: e.text });
      break;
    default:
      break; // audit-only events: tool_called, validation_failed, retries, model_error, recovered
  }
}

export function replay(events: readonly RunEvent[]): RunState {
  const s = initialState();
  for (const e of events) apply(s, e);
  return s;
}

/** The compact task memo: what a later session gets instead of the full transcript. */
export function memoOf(s: RunState): Memo {
  const pending: string[] = [];
  for (const id of s.actionOrder) {
    const a = s.actions[id];
    const label = actionLabel(a.tool, a.finalInput);
    if (a.status === 'pending_approval') pending.push(`Waiting for rep approval: ${label}`);
    if (a.status === 'rejected' && a.decision?.type === 'reject') pending.push(`Held by the rep: ${label}. Reason: "${a.decision.reason}"`);
    if (a.status === 'failed') pending.push(`Failed, needs a retry: ${label}`);
    if (a.status === 'executed' && a.tool === 'create_task') pending.push(`Open task on ${a.finalInput.deal_id}: ${a.finalInput.title} (due ${a.finalInput.due_date})`);
  }
  return { goal: s.request, facts: [...s.facts], decisions: [...s.decisions], pending };
}

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );
}

/** 64-bit FNV-1a, hex. Used for state digests (crash/resume proof) and idempotency keys. */
export function hash(text: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 + 2) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export const digest = (s: RunState) => hash(canonical(s));
