import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { Crm, EmailProvider } from '../src/core/crm.ts';
import { EventStore, Harness, type HarnessDeps, type ModelPort, type ModelRequest } from '../src/core/harness.ts';
import { DEMO_REP, DEMO_REQUEST, PrewrittenModel, SESSION_2_TEXT } from '../src/core/prewritten-model.ts';
import { apply, digest, initialState, memoOf, replay } from '../src/core/state.ts';
import { AnthropicModel, MODEL_ID, type MessagesClient } from '../src/node/anthropic-model.ts';
import type { RunEvent } from '../src/core/types.ts';

function setup(model: ModelPort = new PrewrittenModel(), extra: Partial<HarnessDeps> = {}) {
  const deps: HarnessDeps = { store: new EventStore(), model, crm: new Crm(), email: new EmailProvider(), sleep: async () => {}, clock: () => '2026-09-25T10:00:00.000Z', ...extra };
  const h = Harness.start(deps, 'run_test', DEMO_REP, DEMO_REQUEST);
  return { h, deps, ...deps };
}
const ofType = (store: EventStore, type: RunEvent['type']) => store.events.filter((e) => e.type === type) as any[];
const pending = (h: Harness) => Object.values(h.state.actions).filter((a) => a.status === 'pending_approval');
const byTool = (h: Harness, tool: string, deal: string) => Object.values(h.state.actions).find((a) => a.tool === tool && a.input.deal_id === deal)!;

function msg(content: any[], stop: Anthropic.StopReason): Anthropic.Message {
  return { id: 'msg_t', type: 'message', role: 'assistant', model: 'test', content, stop_reason: stop, stop_sequence: null, stop_details: null, container: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: 'standard' } };
}
const use = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } });
class SeqModel implements ModelPort {
  label = 'seq';
  calls: ModelRequest[] = [];
  private replies: Anthropic.Message[];
  constructor(replies: Anthropic.Message[]) { this.replies = replies; }
  async create(req: ModelRequest) { this.calls.push(structuredClone(req)); return this.replies.shift() ?? msg([{ type: 'text', text: 'done', citations: null }], 'end_turn'); }
}

test('reads run, writes wait at the gate, low-risk writes are auto-approved', async () => {
  const { h, email, crm } = setup();
  await h.advance();
  assert.equal(h.state.status, 'awaiting_approval');
  assert.deepEqual(pending(h).map((a) => a.tool).sort(), ['send_email', 'send_email', 'update_deal_stage']);
  assert.equal(Object.values(h.state.actions).filter((a) => a.tool === 'create_task' && a.status === 'approved').length, 2);
  assert.equal(email.outbox.length, 0, 'nothing is sent before the rep decides');
  assert.equal(crm.tasks.length, 0);
});

test('permission denial comes back as is_error, is logged, and is not retried', async () => {
  const { h, store } = setup();
  await h.advance();
  const calls201 = ofType(store, 'tool_called').filter((e) => e.input?.deal_id === 'D-201');
  assert.equal(calls201.length, 1);
  assert.equal(ofType(store, 'permission_denied').length, 1);
  const result = ofType(store, 'tool_result').find((e) => e.toolUseId === calls201[0].toolUseId);
  assert.equal(result.isError, true);
  assert.match(result.content, /permission_denied/);

  // A write aimed at another rep's deal is stopped at proposal time and never becomes an action.
  const m = new SeqModel([msg([use('t1', 'create_task', { deal_id: 'D-201', title: 'Ping Ingrid', due_date: '2026-10-01' })], 'tool_use')]);
  const s2 = setup(m);
  await s2.h.advance();
  assert.equal(ofType(s2.store, 'action_proposed').length, 0);
  assert.equal(ofType(s2.store, 'permission_denied').length, 1);
  const back = (m.calls[1].messages.at(-1)!.content as any[])[0];
  assert.equal(back.is_error, true);
});

test('schema validation failure is loud: logged, returned as is_error, nothing runs', async () => {
  const m = new SeqModel([msg([use('t1', 'send_email', { deal_id: 'D-101', to_contact_id: 'C-11', body: 'Hi Dana, just checking in on timing.' })], 'tool_use')]);
  const { h, store, email } = setup(m);
  await h.advance();
  assert.equal(ofType(store, 'validation_failed').length, 1);
  assert.match(ofType(store, 'validation_failed')[0].errors[0], /subject is required/);
  assert.equal(ofType(store, 'action_proposed').length, 0);
  assert.equal(email.outbox.length, 0);
  const back = (m.calls[1].messages.at(-1)!.content as any[])[0];
  assert.equal(back.is_error, true);
  assert.match(back.content, /invalid_input/);
  assert.equal(h.state.status, 'completed');
});

test('state rebuilt from the serialized log matches, and the run resumes after a crash', async () => {
  const { h, deps, store } = setup();
  await h.advance();
  assert.equal(digest(replay(store.events)), digest(h.state));
  const before = digest(h.state);
  h.crash();
  const h2 = Harness.recover({ ...deps, store: EventStore.load(store.serialize()) }, before);
  const rec = h2.state.status && (ofType((h2 as any).deps.store, 'recovered')[0]);
  assert.equal(rec.digestAfter, before);
  for (const a of pending(h2)) await h2.decide(a.id, { type: 'approve' });
  assert.equal(h2.state.status, 'completed');
  assert.match(h2.state.finalText!, /Follow-up sent to Dana Whitfield/);
});

test('a retried send executes once, including across a crash mid-retry', async () => {
  let current: Harness;
  const { h, deps, email } = setup(undefined, { sleep: async () => { current.crash(); } });
  current = h;
  await h.advance();
  for (const a of pending(h)) await h.decide(a.id, { type: 'approve' }); // first send: accepted, then 503, then crash during backoff
  assert.equal(h.state.status, 'executing');
  const first = byTool(h, 'send_email', 'D-101');
  assert.equal(email.outbox.filter((m) => m.key === first.idempotencyKey).length, 1);

  const h2 = Harness.recover({ ...deps, sleep: async () => {} });
  await h2.advance();
  assert.equal(h2.state.status, 'completed');
  assert.equal(email.outbox.length, 2, 'two emails, each sent once');
  assert.equal(email.outbox.filter((m) => m.key === first.idempotencyKey).length, 1);
  assert.equal(h2.state.actions[first.id].attempts, 2);
  assert.equal((h2.state.actions[first.id].result as any).deduplicated, true);
  assert.equal(ofType(deps.store, 'action_retry_scheduled').length, 1);
});

test('edit: the edited version is what executes, and the model is told', async () => {
  const { h, email, store } = setup();
  await h.advance();
  const a = byTool(h, 'send_email', 'D-101');
  await assert.rejects(h.decide(a.id, { type: 'edit', input: { to_contact_id: 'C-12' } }), /cannot be edited/);
  const body = `${a.input.body}\n\nP.S. Happy to include Marcus on the call.`;
  await h.decide(a.id, { type: 'edit', input: { body } });
  for (const p of pending(h)) await h.decide(p.id, { type: 'approve' });
  assert.equal(email.outbox.find((m) => m.key === a.idempotencyKey)!.body, body);
  const result = ofType(store, 'tool_result').find((e) => e.toolUseId === a.id);
  assert.match(result.content, /done_with_rep_edits/);
  assert.match(h.state.finalText!, /with your edits/);
});

test('reject: nothing runs, and the reason goes back to the model', async () => {
  const { h, email, store } = setup();
  await h.advance();
  const a = byTool(h, 'send_email', 'D-102');
  await assert.rejects(h.decide(a.id, { type: 'reject', reason: ' ' }), /needs a reason/);
  await h.decide(a.id, { type: 'reject', reason: 'Legal asked us to pause outreach until Friday' });
  for (const p of pending(h)) await h.decide(p.id, { type: 'approve' });
  assert.equal(email.outbox.some((m) => m.key === a.idempotencyKey), false);
  const result = ofType(store, 'tool_result').find((e) => e.toolUseId === a.id);
  assert.equal(result.isError, true);
  assert.match(result.content, /pause outreach until Friday/);
  assert.ok(memoOf(h.state).pending.some((p) => p.includes('pause outreach until Friday')));
  assert.match(h.state.finalText!, /Email not sent/);
});

test('a later session gets the memo plus recent turns, not the full history', async () => {
  const { h } = setup();
  await h.advance();
  for (const a of pending(h)) await h.decide(a.id, { type: 'approve' });
  await h.startSession(SESSION_2_TEXT);
  const ctx = h.state.lastContext!;
  assert.equal(ctx.mode, 'memo_plus_recent');
  assert.equal(ctx.messages, 1);
  assert.ok(ctx.approxTokens < ctx.fullHistoryApproxTokens / 2);
  assert.match(h.state.finalText!, /task memo/);
});

test('stop reasons: refusal and max_tokens fail loudly; pause_turn continues', async () => {
  const refused = setup(new SeqModel([msg([], 'refusal')]));
  await refused.h.advance();
  assert.equal(refused.h.state.status, 'failed');

  const truncated = setup(new SeqModel([msg([use('t1', 'create_task', { deal_id: 'D-101', title: 'x' })], 'max_tokens')]));
  await truncated.h.advance();
  assert.equal(truncated.h.state.status, 'failed');
  assert.equal(ofType(truncated.store, 'tool_called').length, 0, 'tools from a truncated turn never run');

  const m = new SeqModel([msg([{ type: 'text', text: 'working', citations: null }], 'pause_turn')]);
  const paused = setup(m);
  await paused.h.advance();
  assert.equal(m.calls[1].messages.at(-1)!.role, 'assistant', 'the paused turn is re-sent to continue');
  assert.equal(paused.h.state.status, 'completed');
});

test('illegal transitions are rejected by the state machine', () => {
  const s = initialState();
  assert.throws(() => apply(s, { type: 'state_changed', from: 'created', to: 'completed', seq: 1, at: '', actor: 't', runId: 'r' }), /Illegal transition/);
});

test('AnthropicModel sends the documented request shape and maps API errors', async () => {
  const seen: any[] = [];
  const client: MessagesClient = { messages: { create: async (p) => { seen.push(p); return msg([{ type: 'text', text: 'ok', citations: null }], 'end_turn'); } } };
  const model = new AnthropicModel(client);
  const { h } = setup(model);
  await h.advance();
  assert.equal(h.state.status, 'completed');
  assert.equal(seen[0].model, MODEL_ID);
  assert.deepEqual(seen[0].thinking, { type: 'adaptive' });
  assert.equal(seen[0].tools.length, 5);
  assert.match(seen[0].system, /Jordan Lee/);

  const failing: MessagesClient = { messages: { create: async () => { throw new Anthropic.APIError(529, undefined, 'overloaded', new Headers()); } } };
  const s2 = setup(new AnthropicModel(failing));
  await s2.h.advance();
  assert.deepEqual(ofType(s2.store, 'model_error').map((e) => e.kind), ['transient', 'transient', 'transient']);
  assert.equal(s2.h.state.status, 'failed');
});
