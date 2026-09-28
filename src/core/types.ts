import type Anthropic from '@anthropic-ai/sdk';

export type RunStatus = 'created' | 'running' | 'awaiting_approval' | 'executing' | 'completed' | 'failed' | 'cancelled';
export type Risk = 'low' | 'medium' | 'high';
export type ErrorKind = 'permission' | 'validation' | 'not_found' | 'transient' | 'fatal';

export type Decision =
  | { type: 'approve' }
  | { type: 'edit'; input: Record<string, unknown> }
  | { type: 'reject'; reason: string };

export interface ProposedAction {
  id: string; // same as the tool_use id that proposed it
  tool: string;
  input: Record<string, unknown>;
  risk: Risk;
  needsApproval: boolean;
  idempotencyKey: string;
  turn: number;
}

export type ActionStatus = 'pending_approval' | 'approved' | 'rejected' | 'executed' | 'failed';

export interface ActionState extends ProposedAction {
  status: ActionStatus;
  decision?: Decision;
  decidedBy?: string;
  finalInput: Record<string, unknown>;
  attempts: number;
  result?: unknown;
  error?: string;
  resolved: boolean; // a tool_result has been produced for it
}

export interface ContextInfo {
  turn: number;
  session: number;
  mode: 'full_history' | 'memo_plus_recent';
  messages: number;
  approxTokens: number;
  fullHistoryApproxTokens: number;
}

/** Every change to a run is one of these. The log is append-only; state is a fold over it. */
export type EventBody =
  | { type: 'run_created'; repId: string; request: string }
  | { type: 'state_changed'; from: RunStatus; to: RunStatus; reason?: string }
  | ({ type: 'model_request' } & ContextInfo)
  | { type: 'model_response'; turn: number; message: Anthropic.Message }
  | { type: 'model_error'; turn: number; kind: ErrorKind; message: string }
  | { type: 'tool_called'; toolUseId: string; tool: string; input: unknown; kind: 'read' | 'write' | 'unknown' }
  | { type: 'validation_failed'; toolUseId: string; tool: string; errors: string[] }
  | { type: 'permission_denied'; toolUseId: string; tool: string; reason: string }
  | { type: 'action_proposed'; action: ProposedAction }
  | { type: 'approval_decided'; actionId: string; decision: Decision; by: string }
  | { type: 'action_attempt'; actionId: string; attempt: number; idempotencyKey: string }
  | { type: 'action_retry_scheduled'; actionId: string; attempt: number; delayMs: number; error: string }
  | { type: 'action_executed'; actionId: string; attempts: number; result: unknown }
  | { type: 'action_failed'; actionId: string; kind: ErrorKind; error: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean; facts?: string[]; trimmed?: boolean; full?: unknown }
  | { type: 'session_started'; session: number; text: string }
  | { type: 'recovered'; replayed: number; status: RunStatus; digestBefore: string; digestAfter: string };

export type RunEvent = EventBody & { seq: number; at: string; actor: string; runId: string };

export interface Memo {
  goal: string;
  facts: string[];
  decisions: string[];
  pending: string[];
}

export interface RunState {
  runId: string;
  repId: string;
  request: string;
  status: RunStatus;
  session: number;
  turn: number;
  continuations: number;
  messages: Anthropic.MessageParam[]; // the current session's conversation
  history: Anthropic.MessageParam[]; // every session, for recent-turn excerpts and size comparison
  openToolUses: string[]; // tool_use ids from the last assistant turn still waiting for a result
  results: Record<string, Anthropic.ToolResultBlockParam>;
  actions: Record<string, ActionState>;
  actionOrder: string[];
  facts: string[];
  decisions: string[];
  lastContext?: ContextInfo;
  finalText?: string;
  failure?: string;
}

export class ToolError extends Error {
  kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}
