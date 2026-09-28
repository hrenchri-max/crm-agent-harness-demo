import type Anthropic from '@anthropic-ai/sdk';
import type { ContextInfo, Memo, RunState } from './types.ts';
import { REPS, TODAY } from './crm.ts';

export const MAX_RESULT_CHARS = 1600; // larger tool results are trimmed before the model sees them
export const RECENT_TURNS = 2; // assistant turns carried verbatim (as text) into a new session

export function systemPrompt(repId: string): string {
  const rep = REPS.find((r) => r.id === repId)!;
  return [
    `You are a sales assistant working inside a CRM for one sales rep, ${rep.name} (${rep.email}). Every tool runs as this rep, with this rep's permissions. Today is ${TODAY}.`,
    '',
    'How to work:',
    '- Gather facts with the read tools before proposing any change.',
    "- Write tools (send_email, create_task, update_deal_stage) never run immediately. Each call becomes a proposed action that goes through the rep's approval policy. The tool result tells you the outcome: done; done with the rep's edits (the edited version is final, do not send it again); or rejected with the rep's reason (treat the reason as an instruction).",
    '- When you are ready to act, propose all of the actions for the task in one turn so the rep can review them together.',
    '- If a tool returns a permission error, do not retry it or look for a way around it. Tell the rep if it matters.',
    `- Keep emails short, specific to the deal history, and in the rep's voice. Sign them "${rep.name.split(' ')[0]}".`,
    '- Stay within what the rep asked. Finish with a brief summary: what was sent, what was logged, and what needs the rep\'s attention.',
  ].join('\n');
}

export const approxTokens = (x: unknown) => Math.ceil(JSON.stringify(x).length / 4);

function shrink(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 240 ? `${v.slice(0, 240)} [${v.length - 240} more characters trimmed]` : v;
  if (Array.isArray(v)) {
    const kept = v.slice(0, 4).map(shrink);
    return v.length > 4 ? [...kept, `[${v.length - 4} older items omitted to save context]`] : kept;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]));
  return v;
}

/** The event log keeps the full result; the conversation gets a trimmed copy when it is large. */
export function trimForModel(value: unknown): { content: string; trimmed: boolean } {
  const full = JSON.stringify(value);
  if (full.length <= MAX_RESULT_CHARS) return { content: full, trimmed: false };
  return { content: JSON.stringify(shrink(value)), trimmed: true };
}

/** What the next model call sees. Session 1 sends its own history; later sessions start from the memo. */
export function buildContext(s: RunState): { messages: Anthropic.MessageParam[]; info: ContextInfo } {
  return {
    messages: s.messages,
    info: {
      turn: s.turn + 1, session: s.session,
      mode: s.session > 1 ? 'memo_plus_recent' : 'full_history',
      messages: s.messages.length, approxTokens: approxTokens(s.messages), fullHistoryApproxTokens: approxTokens(s.history),
    },
  };
}

function blockText(b: any): string {
  if (b.type === 'text') return `assistant: ${b.text}`;
  if (b.type === 'tool_use') return `assistant called ${b.name}(${JSON.stringify(b.input).slice(0, 160)})`;
  if (b.type === 'tool_result') return `result${b.is_error ? ' (error)' : ''}: ${String(b.content).slice(0, 200)}`;
  return '';
}

/** Plain-text excerpt of the last few turns. No raw blocks carry over, so no thinking blocks are replayed out of context. */
export function recentTurns(history: Anthropic.MessageParam[], n = RECENT_TURNS): string {
  const idx = history.map((m, i) => (m.role === 'assistant' ? i : -1)).filter((i) => i >= 0).slice(-n);
  if (!idx.length) return '(none)';
  return history.slice(idx[0]).flatMap((m) =>
    typeof m.content === 'string' ? [`${m.role === 'user' ? 'rep' : 'assistant'}: ${m.content}`] : m.content.map(blockText).filter(Boolean),
  ).join('\n');
}

export function sessionOpening(memo: Memo, history: Anthropic.MessageParam[], text: string): string {
  return [
    'This is a new working session on an earlier task. You do not have the earlier transcript. You have the task memo the harness kept and an excerpt of the last few turns.',
    `<task_memo>\n${JSON.stringify(memo, null, 2)}\n</task_memo>`,
    `<recent_turns>\n${recentTurns(history)}\n</recent_turns>`,
    `The rep now says: "${text}"`,
  ].join('\n\n');
}
