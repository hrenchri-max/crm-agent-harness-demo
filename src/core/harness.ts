import type Anthropic from '@anthropic-ai/sdk';
import { ToolError, type ActionState, type Decision, type ErrorKind, type EventBody, type RunEvent, type RunState, type RunStatus } from './types.ts';
import { apply, digest, hash, replay } from './state.ts';
import { TOOLS, toApiTools, type ToolContext, type ToolDef } from './tools.ts';
import { buildContext, systemPrompt, trimForModel } from './context.ts';
import { validate } from './validate.ts';
import { REPS, type Crm, type EmailProvider } from './crm.ts';

export interface ModelRequest { system: string; tools: Anthropic.Tool[]; messages: Anthropic.MessageParam[] }
export interface ModelPort { readonly label: string; create(req: ModelRequest): Promise<Anthropic.Message> }

/** Append-only event log. In production this is the agent_events table (see sql/schema.sql). */
export class EventStore {
  private log: RunEvent[] = [];
  private listeners = new Set<(e: RunEvent) => void>();
  get events(): readonly RunEvent[] { return this.log; }
  append(e: RunEvent): void {
    this.log.push(Object.freeze(JSON.parse(JSON.stringify(e))));
    for (const l of this.listeners) l(e);
  }
  subscribe(fn: (e: RunEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  serialize(): string { return JSON.stringify(this.log); }
  static load(json: string): EventStore {
    const s = new EventStore();
    s.log = JSON.parse(json);
    return s;
  }
}

export interface HarnessDeps {
  store: EventStore;
  model: ModelPort;
  crm: Crm;
  email: EmailProvider;
  tools?: ToolDef[];
  retryDelaysMs?: number[];
  maxAttempts?: number;
  maxTurns?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => string;
}

/** Thrown inside a harness that has been discarded (simulated crash) or cancelled. */
export class Halted extends Error {}

export function classify(err: unknown): ErrorKind {
  return err instanceof ToolError ? err.kind : 'fatal';
}
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Harness {
  state: RunState;
  private deps: Required<HarnessDeps>;
  private tools: Record<string, ToolDef>;
  private dead = false;
  private busy = false;

  constructor(deps: HarnessDeps) {
    this.deps = {
      tools: TOOLS, retryDelaysMs: [800, 1600], maxAttempts: 3, maxTurns: 16,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)), clock: () => new Date().toISOString(), ...deps,
    };
    this.tools = Object.fromEntries(this.deps.tools.map((t) => [t.name, t]));
    this.state = replay(deps.store.events); // the ONLY way state is built: fold the log
  }

  static start(deps: HarnessDeps, runId: string, repId: string, request: string): Harness {
    const h = new Harness(deps);
    h.state.runId = runId;
    h.emit(h.repName(repId), { type: 'run_created', repId, request });
    h.transition('running');
    return h;
  }

  /** Rebuild a run from its log after a crash. digestBefore is the lost process's state digest, for the demo's proof. */
  static recover(deps: HarnessDeps, digestBefore = ''): Harness {
    const h = new Harness(deps);
    const after = digest(h.state);
    h.emit('system', { type: 'recovered', replayed: deps.store.events.length, status: h.state.status, digestBefore, digestAfter: after });
    return h;
  }

  crash(): void { this.dead = true; }

  private repName(repId = this.state.repId) { return REPS.find((r) => r.id === repId)?.name ?? repId; }

  private emit(actor: string, body: EventBody): void {
    if (this.dead) throw new Halted('harness discarded');
    const e = { ...body, seq: this.deps.store.events.length + 1, at: this.deps.clock(), actor, runId: this.state.runId } as RunEvent;
    apply(this.state, e); // validate first (illegal transitions throw), then persist
    this.deps.store.append(e);
  }

  private transition(to: RunStatus, reason?: string): void {
    this.emit('harness', { type: 'state_changed', from: this.state.status, to, ...(reason ? { reason } : {}) });
  }

  private checkAlive(): void {
    if (this.dead || this.state.status === 'cancelled') throw new Halted('stopped');
  }

  private ctx(key: string): ToolContext {
    return { crm: this.deps.crm.forRep(this.state.repId), email: this.deps.email, idempotencyKey: key };
  }

  private delay(attempt: number) {
    const d = this.deps.retryDelaysMs;
    return d[Math.min(attempt - 1, d.length - 1)];
  }

  /** Drive the run until it parks (approval gate) or ends. Safe to call again after any interruption. */
  async advance(): Promise<void> {
    if (this.busy || this.dead) return;
    this.busy = true;
    try {
      while (!this.dead) {
        if (this.state.status === 'executing') await this.executeApproved();
        else if (this.state.status === 'running') await this.modelTurn();
        else return;
      }
    } catch (err) {
      if (!(err instanceof Halted)) throw err;
    } finally {
      this.busy = false;
    }
  }

  private async modelTurn(): Promise<void> {
    if (this.state.turn >= this.deps.maxTurns) return this.transition('failed', 'turn limit reached');
    const { messages, info } = buildContext(this.state);
    this.emit('harness', { type: 'model_request', ...info });
    const req = { system: systemPrompt(this.state.repId), tools: toApiTools(this.deps.tools), messages: [...messages] };
    let message: Anthropic.Message | undefined;
    for (let attempt = 1; !message; attempt++) {
      try {
        message = await this.deps.model.create(req);
        this.checkAlive();
      } catch (err) {
        if (err instanceof Halted) throw err;
        this.checkAlive();
        const kind = classify(err);
        this.emit('harness', { type: 'model_error', turn: info.turn, kind, message: messageOf(err) });
        if (kind !== 'transient' || attempt >= this.deps.maxAttempts) return this.transition('failed', `model call failed: ${messageOf(err)}`);
        await this.deps.sleep(this.delay(attempt));
      }
    }
    this.emit('agent', { type: 'model_response', turn: info.turn, message });
    switch (message.stop_reason) {
      case 'end_turn':
      case 'stop_sequence':
        return this.transition('completed');
      case 'tool_use':
        return this.handleToolUses(message);
      case 'pause_turn': // the paused turn is already in the conversation; the next call resumes it
        if (this.state.continuations > 3) return this.transition('failed', 'too many pause_turn continuations');
        return;
      case 'refusal':
        return this.transition('failed', `the model declined (refusal${message.stop_details?.category ? `: ${message.stop_details.category}` : ''})`);
      case 'max_tokens':
        return this.transition('failed', 'output hit max_tokens; tool calls from a truncated turn are never run');
      default:
        return this.transition('failed', `unhandled stop_reason: ${message.stop_reason}`);
    }
  }

  private async handleToolUses(message: Anthropic.Message): Promise<void> {
    const calls = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!calls.length) return this.transition('failed', 'stop_reason tool_use without any tool_use block');
    for (const call of calls) {
      const tool = this.tools[call.name];
      this.emit('agent', { type: 'tool_called', toolUseId: call.id, tool: call.name, input: call.input, kind: tool?.kind ?? 'unknown' });
      const errors = tool ? validate(tool.input_schema, call.input) : [`unknown tool: ${call.name}`];
      if (errors.length) {
        this.emit('harness', { type: 'validation_failed', toolUseId: call.id, tool: call.name, errors });
        this.emit('harness', { type: 'tool_result', toolUseId: call.id, isError: true, content: JSON.stringify({ error: 'invalid_input', details: errors, hint: 'Nothing ran. Fix the input and call the tool again.' }) });
        continue;
      }
      const input = call.input as Record<string, unknown>;
      const key = `idem_${hash(`${this.state.runId}:${call.id}`)}`;
      if (tool.kind === 'read') {
        await this.runRead(tool, call.id, input, key);
        continue;
      }
      try {
        tool.authorize?.(input, this.ctx(key));
      } catch (err) {
        this.toolFailure(call.id, tool.name, err);
        continue;
      }
      const needsApproval = tool.risk !== 'low';
      this.emit('agent', { type: 'action_proposed', action: { id: call.id, tool: tool.name, input, risk: tool.risk, needsApproval, idempotencyKey: key, turn: this.state.turn } });
      if (!needsApproval) this.emit('policy', { type: 'approval_decided', actionId: call.id, decision: { type: 'approve' }, by: 'Policy (low risk, auto-approved)' });
    }
    const open = Object.values(this.state.actions).filter((a) => !a.resolved);
    if (open.some((a) => a.status === 'pending_approval')) this.transition('awaiting_approval');
    else if (open.length) this.transition('executing');
    // otherwise every result is in, the user message is assembled, and the loop calls the model again
  }

  private async runRead(tool: ToolDef, id: string, input: Record<string, unknown>, key: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await tool.handler(input, this.ctx(key));
        this.checkAlive();
        const { content, trimmed } = trimForModel(result);
        this.emit('harness', { type: 'tool_result', toolUseId: id, content, isError: false, trimmed, ...(trimmed ? { full: result } : {}), facts: tool.facts?.(input, result) });
        return;
      } catch (err) {
        if (err instanceof Halted) throw err;
        if (classify(err) === 'transient' && attempt < this.deps.maxAttempts) {
          await this.deps.sleep(this.delay(attempt));
          continue;
        }
        return this.toolFailure(id, tool.name, err);
      }
    }
  }

  /** Permission and validation errors go back to the model as is_error results. They are never retried. */
  private toolFailure(id: string, tool: string, err: unknown): void {
    const kind = classify(err);
    if (kind === 'permission') this.emit('harness', { type: 'permission_denied', toolUseId: id, tool, reason: messageOf(err) });
    if (kind === 'validation') this.emit('harness', { type: 'validation_failed', toolUseId: id, tool, errors: [messageOf(err)] });
    const code = kind === 'permission' ? 'permission_denied' : kind;
    this.emit('harness', { type: 'tool_result', toolUseId: id, isError: true, content: JSON.stringify({ error: code, message: messageOf(err) }) });
  }

  /** The rep's decision on one proposed write. Edited input is re-validated; a rejection needs a reason. */
  async decide(actionId: string, decision: Decision, by = this.repName()): Promise<void> {
    const a = this.state.actions[actionId];
    if (this.state.status !== 'awaiting_approval' || a?.status !== 'pending_approval') throw new Error(`No pending approval for ${actionId}`);
    if (decision.type === 'edit') {
      const tool = this.tools[a.tool];
      const errors = [
        ...Object.keys(decision.input).filter((k) => !tool.editable?.includes(k)).map((k) => `${k} cannot be edited`),
        ...validate(tool.input_schema, { ...a.input, ...decision.input }),
      ];
      if (errors.length) throw new ToolError('validation', errors.join('; '));
    }
    if (decision.type === 'reject' && !decision.reason.trim()) throw new ToolError('validation', 'A rejection needs a reason. It goes back to the model.');
    this.emit(by, { type: 'approval_decided', actionId, decision, by });
    if (!Object.values(this.state.actions).some((x) => x.status === 'pending_approval')) {
      this.transition('executing');
      await this.advance();
    }
  }

  private async executeApproved(): Promise<void> {
    for (const id of this.state.actionOrder) {
      const a = this.state.actions[id];
      if (a.resolved) continue;
      if (a.status === 'approved') await this.execute(a);
      else if (a.status === 'executed') this.writeResult(a); // crashed between execution and result
      else if (a.status === 'rejected' && a.decision?.type === 'reject') {
        this.emit('harness', { type: 'tool_result', toolUseId: id, isError: true, content: JSON.stringify({ status: 'rejected_by_rep', rep: a.decidedBy, reason: a.decision.reason, note: 'Nothing was executed.' }) });
      } else if (a.status === 'failed') {
        this.emit('harness', { type: 'tool_result', toolUseId: id, isError: true, content: JSON.stringify({ error: 'failed', message: a.error }) });
      }
    }
    this.transition('running');
  }

  /** Transient errors retry with backoff and the SAME idempotency key, so a retry never double-applies. */
  private async execute(a: ActionState): Promise<void> {
    const tool = this.tools[a.tool];
    for (let attempt = a.attempts + 1; ; attempt++) {
      this.emit('harness', { type: 'action_attempt', actionId: a.id, attempt, idempotencyKey: a.idempotencyKey });
      try {
        const result = await tool.handler(a.finalInput, this.ctx(a.idempotencyKey));
        this.checkAlive();
        this.emit('harness', { type: 'action_executed', actionId: a.id, attempts: attempt, result });
        return this.writeResult(this.state.actions[a.id]);
      } catch (err) {
        if (err instanceof Halted) throw err;
        this.checkAlive();
        const kind = classify(err);
        if (kind === 'transient' && attempt < this.deps.maxAttempts) {
          const delayMs = this.delay(attempt);
          this.emit('harness', { type: 'action_retry_scheduled', actionId: a.id, attempt, delayMs, error: messageOf(err) });
          await this.deps.sleep(delayMs);
          this.checkAlive();
          continue;
        }
        if (kind === 'permission') this.emit('harness', { type: 'permission_denied', toolUseId: a.id, tool: a.tool, reason: messageOf(err) });
        this.emit('harness', { type: 'action_failed', actionId: a.id, kind, error: messageOf(err) });
        this.emit('harness', { type: 'tool_result', toolUseId: a.id, isError: true, content: JSON.stringify({ error: kind, message: messageOf(err), attempts: attempt }) });
        return;
      }
    }
  }

  private writeResult(a: ActionState): void {
    const edited = a.decision?.type === 'edit';
    const content = JSON.stringify({
      status: edited ? 'done_with_rep_edits' : 'done',
      ...(edited ? { note: 'The rep edited this before it ran. This is the final version; do not send it again.', final_input: a.finalInput } : {}),
      result: a.result,
    });
    this.emit('harness', { type: 'tool_result', toolUseId: a.id, isError: false, content });
  }

  /** A later session on the same run: the model gets the memo plus recent turns, not the transcript. */
  async startSession(text: string): Promise<void> {
    if (this.state.status !== 'completed') throw new Error('A new session can start only after the run completes');
    this.emit(this.repName(), { type: 'session_started', session: this.state.session + 1, text });
    this.transition('running');
    await this.advance();
  }

  cancel(by = this.repName()): void {
    if (['completed', 'failed', 'cancelled'].includes(this.state.status)) return;
    this.transition('cancelled', `cancelled by ${by}`);
  }
}
