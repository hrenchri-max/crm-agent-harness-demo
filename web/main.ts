import { Crm, EmailProvider, TODAY, daysBetween, lastActivity } from '../src/core/crm.ts';
import { EventStore, Harness, type HarnessDeps, type ModelPort } from '../src/core/harness.ts';
import { DEMO_REP, DEMO_REQUEST, PrewrittenModel, SESSION_2_TEXT } from '../src/core/prewritten-model.ts';
import { describeEvent } from '../src/core/describe.ts';
import { digest, memoOf, replay } from '../src/core/state.ts';
import { TOOLS, TOOL_BY_NAME, actionLabel, type ToolDef } from '../src/core/tools.ts';
import { MAX_RESULT_CHARS, RECENT_TURNS } from '../src/core/context.ts';
import type { ActionState, ContextInfo, Decision, RunEvent, RunState, RunStatus } from '../src/core/types.ts';

type Tab = 'timeline' | 'crm' | 'memo' | 'audit';
type Ev<T extends RunEvent['type']> = Extract<RunEvent, { type: T }>;

// The page paces the run so each step can be followed. ?fast=1 turns pacing off.
const FAST = new URLSearchParams(location.search).has('fast');
const PACE = FAST ? { model: 650, tool: 0, gap: 0, retry: [800, 1600] } : { model: 1200, tool: 700, gap: 650, retry: [2000, 4000] };
const PARKED: RunStatus[] = ['awaiting_approval', 'completed', 'failed', 'cancelled'];
const REP = 'Jordan Lee';
const PS = '\n\nP.S. If it is easier, I can send a short written summary first.';
const desktop = matchMedia('(min-width: 1024px)');
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
const money = (n: number) => `$${n.toLocaleString('en-US')}`;
const pretty = (v: unknown) => esc(JSON.stringify(v, null, 2));
const mail = (v: unknown) => esc(v).replace('@', '<wbr>@');
const parse = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

let crm: Crm, email: EmailProvider, store: EventStore;
let harness: Harness | null = null;
let unsubscribe = () => {};
let SHOWN: readonly RunEvent[] = []; // the events revealed so far; everything on screen renders from these
const ui = {
  tab: 'timeline' as Tab, mode: {} as Record<string, 'edit' | 'reject'>, drafts: {} as Record<string, Record<string, string>>,
  errors: {} as Record<string, string>, inflight: new Set<string>(), open: new Set<string>(), lastGate: '',
  shown: 0, lastVisible: 0, skip: false, stick: false, flashSeq: 0,
};

// Pacing lives in the dependencies the page hands the harness; the harness itself is unchanged.
let waiters: (() => void)[] = [];
function pace(ms: number): Promise<void> {
  if (ui.skip || !ms) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); waiters = waiters.filter((w) => w !== done); resolve(); };
    const t = setTimeout(done, ms);
    waiters.push(done);
  });
}
const prewritten = new PrewrittenModel(0);
const model: ModelPort = { label: prewritten.label, create: async (req) => { await pace(PACE.model); return prewritten.create(req); } };
const tools: ToolDef[] = TOOLS.map((t) => ({ ...t, handler: async (i, c) => { try { return await t.handler(i, c); } finally { await pace(PACE.tool); } } }));
const deps = (): HarnessDeps => ({ store, model, crm, email, tools, retryDelaysMs: PACE.retry, sleep: pace });

function visible(e: RunEvent, all: readonly RunEvent[]): boolean {
  if (e.type === 'model_request' || e.type === 'tool_called' || e.type === 'approval_decided') return false;
  if (e.type === 'action_proposed') return !e.action.needsApproval;
  if (e.type === 'state_changed') return PARKED.includes(e.to);
  if (e.type === 'tool_result') return !e.isError && all.some((c) => c.type === 'tool_called' && c.toolUseId === e.toolUseId && c.kind === 'read');
  return true;
}

/** Reveal logged events one at a time, at least PACE.gap apart, and follow the newest one. */
let frame = 0;
let timer = 0;
const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; pump(); }); };
function pump() {
  clearTimeout(timer);
  const all = store.events;
  const near = innerHeight + scrollY >= document.documentElement.scrollHeight - 250;
  let revealed = false;
  while (ui.shown < all.length) {
    const e = all[ui.shown];
    const show = visible(e, all);
    if (show && !ui.skip) {
      const wait = ui.lastVisible + PACE.gap - performance.now();
      if (wait > 0) { timer = window.setTimeout(pump, wait); break; }
    }
    if (show) { ui.lastVisible = performance.now(); revealed = true; }
    ui.shown++;
    if (e.type === 'state_changed' && PARKED.includes(e.to)) ui.skip = false; // "Skip ahead" stops at the next decision point
  }
  render();
  if (revealed) follow(near);
}
function bind() { unsubscribe(); unsubscribe = store.subscribe(schedule); }
function drive(p: Promise<void>) {
  p.catch((err) => { console.error(err); ui.errors.global = String(err?.message ?? err); render(); });
}

function reset() {
  harness?.crash();
  harness = null;
  for (const w of [...waiters]) w();
  clearTimeout(timer);
  crm = new Crm(); email = new EmailProvider(); store = new EventStore();
  bind();
  Object.assign(ui, { mode: {}, drafts: {}, errors: {}, inflight: new Set(), open: new Set(), lastGate: '', shown: 0, lastVisible: 0, skip: false, stick: false, flashSeq: 0 });
  render();
}

function run() {
  harness = Harness.start(deps(), `run_${Date.now().toString(36)}`, DEMO_REP, DEMO_REQUEST);
  ui.stick = true;
  drive(harness.advance());
}

function skipAhead() {
  ui.skip = true;
  ui.stick = true;
  for (const w of [...waiters]) w();
  pump();
}

/** The process "dies": the harness object and its in-memory state are thrown away. Only the serialized log survives. */
function crashAndResume() {
  if (!harness) return;
  const before = digest(harness.state);
  harness.crash();
  store = EventStore.load(store.serialize());
  bind();
  harness = Harness.recover(deps(), before);
  ui.mode = {};
  ui.shown = store.events.length; // a rebuild is instant: show everything, including the recovery
  ui.lastVisible = performance.now();
  ui.flashSeq = store.events.at(-1)!.seq;
  ui.stick = true;
  if (!desktop.matches) ui.tab = 'timeline';
  render();
  panel('timeline').querySelector('.highlight')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => { ui.flashSeq = 0; render(); }, 4000);
  drive(harness.advance());
}

function decide(id: string, decision: Decision) {
  if (!harness || ui.inflight.has(id)) return;
  ui.inflight.add(id);
  delete ui.errors[id];
  ui.stick = true;
  harness.decide(id, decision)
    .then(() => { delete ui.mode[id]; })
    .catch((err) => { ui.errors[id] = err.message; })
    .finally(() => { ui.inflight.delete(id); render(); });
}

// ---------- rendering ----------

const details = (id: string, summary: string, body: string) =>
  `<details data-open-id="${id}"${ui.open.has(id) ? ' open' : ''}><summary>${summary}</summary>${body}</details>`;
const step = (cls: string, label: string, meta: string, body: string) =>
  `<article class="step ${cls}"><div class="head"><span class="label">${label}</span>${meta}</div>${body}</article>`;
const list = (xs: string[], empty: string) => (xs.length ? `<ul class="list">${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="empty">${empty}</p>`);
const deal = (id: unknown) => crm.deals.find((d) => d.id === id);
const contact = (id: unknown) => crm.contacts.find((c) => c.id === id);

const STATE_LABEL: Record<RunStatus, string> = {
  created: 'Created', running: 'Running', awaiting_approval: 'Awaiting approval', executing: 'Executing',
  completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
};

function statesHtml(s?: RunState): string {
  const seen = new Set(SHOWN.filter((e) => e.type === 'state_changed').flatMap((e) => [(e as Ev<'state_changed'>).from, (e as Ev<'state_changed'>).to]));
  const order: RunStatus[] = ['running', 'awaiting_approval', 'executing', 'completed'];
  if (s && (s.status === 'failed' || s.status === 'cancelled')) order.push(s.status);
  return order.map((st) => {
    const cur = s?.status === st;
    const cls = cur ? `current${st === 'failed' || st === 'cancelled' ? ' bad' : ''}` : seen.has(st) ? 'done' : '';
    return `<li class="${cls}"${cur ? ' aria-current="step"' : ''}><span>${STATE_LABEL[st]}</span></li>`;
  }).join('');
}

function tabsHtml(): string {
  const side = sideTab();
  const tabs: [Tab, string][] = [['timeline', 'Timeline'], ['crm', 'CRM'], ['memo', 'Memo'], ['audit', 'Audit log']];
  return tabs.map(([t, label]) => {
    const active = desktop.matches ? t === side : t === ui.tab;
    return `<button type="button" role="tab" data-act="tab" data-tab="${t}" aria-selected="${active}" class="${active ? 'active' : ''}">${label}</button>`;
  }).join('');
}
const sideTab = (): Tab => (ui.tab === 'timeline' ? 'crm' : ui.tab);

function modelStep(e: Ev<'model_response'>, ctx: ContextInfo | undefined, n: number): string {
  const m = e.message;
  const texts = m.content.map((b) => (b.type === 'text' ? `<p class="prose">${esc(b.text)}</p>` : b.type === 'thinking' && b.thinking ? `<p class="muted prose">Reasoning summary: ${esc(b.thinking)}</p>` : '')).join('');
  const counts: Record<string, number> = {};
  for (const b of m.content) if (b.type === 'tool_use') counts[b.name] = (counts[b.name] ?? 0) + 1;
  const calls = Object.entries(counts).map(([k, v]) => (v > 1 ? `${k} (${v} calls)` : k)).join(', ');
  const sent = ctx ? `<p class="muted">Sent ${ctx.mode === 'full_history' ? 'the session history' : 'the memo plus recent turns'}: ${ctx.messages} message${ctx.messages > 1 ? 's' : ''}, about ${ctx.approxTokens.toLocaleString('en-US')} tokens.</p>` : '';
  const tag = m.model === 'prewritten' ? 'pre-written' : esc(m.model);
  return step('', `Model, step ${n}`, `<span class="tag">${tag}</span><span class="tag">stop_reason: ${m.stop_reason}</span>`,
    `${texts}${calls ? `<p class="muted">Tool calls: ${esc(calls)}</p>` : ''}${details(`m-${e.seq}`, 'Context and raw response', `${sent}<pre>${pretty({ id: m.id, stop_reason: m.stop_reason, content: m.content })}</pre>`)}`);
}

function readStep(call: Ev<'tool_called'>, result: Ev<'tool_result'> | undefined): string {
  if (!result || result.isError) return '';
  const data: any = result.full ?? parse(result.content);
  const summary = call.tool === 'list_my_deals'
    ? `Found ${data.length} deal${data.length === 1 ? '' : 's'} quiet 14+ days: ${data.map((d: any) => `${d.deal_id} ${d.account} (${d.days_quiet} days)`).join(', ')}.`
    : `${data.account}: ${data.name}. ${data.stage}, ${money(data.amount)}, quiet ${data.days_quiet} days, ${data.activities?.length} activities.`;
  const trimmed = result.trimmed ? `<p class="muted">Large result. The model got a trimmed copy (newest 4 items, long text shortened, ${MAX_RESULT_CHARS} character budget); the full result stays in the event log.</p>` : '';
  const id = (call.input as any)?.deal_id ?? '';
  return step('', `Read: ${call.tool} ${esc(id)}`, '<span class="tag">runs as Jordan Lee</span>',
    `<p>${esc(summary)}</p>${trimmed}${details(`r-${call.toolUseId}`, 'Input and what the model received', `<pre>${pretty(call.input)}</pre><pre>${pretty(parse(result.content))}</pre>`)}`);
}

function approval(a: ActionState, s: RunState): string {
  const d = deal(a.input.deal_id);
  const i = a.finalInput;
  const title = ({ send_email: 'Email', update_deal_stage: 'Stage change', create_task: 'Task' } as Record<string, string>)[a.tool] ?? a.tool;
  const head = `<div class="head"><span class="label">${title}</span><span class="tag">${a.risk} risk</span><span class="meta">${esc(a.input.deal_id)} ${esc(d?.account)}</span></div>`;
  let body = '';
  if (a.tool === 'send_email') {
    const c = contact(i.to_contact_id);
    body = `<dl><dt>To</dt><dd>${esc(c?.name)} &lt;${mail(c?.email)}&gt;</dd><dt>Subject</dt><dd>${esc(i.subject)}</dd></dl><div class="email-body">${esc(i.body)}</div>`;
  } else if (a.tool === 'update_deal_stage') {
    body = `<dl><dt>Stage</dt><dd>${esc((a.result as any)?.from ?? d?.stage)} to ${esc(i.stage)}</dd><dt>Reason</dt><dd>${esc(i.reason)}</dd></dl>`;
  } else {
    body = `<dl>${Object.entries(i).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  }
  const mode = ui.mode[a.id];
  const open = a.status === 'pending_approval' && s.status === 'awaiting_approval';
  let controls: string;
  if (open && mode === 'edit') controls = editForm(a);
  else if (open && mode === 'reject') controls = rejectForm(a);
  else if (open) controls = `<div class="actions"><button class="primary" data-act="approve" data-id="${a.id}">Approve</button><button data-act="edit" data-id="${a.id}">Edit</button><button class="danger" data-act="reject" data-id="${a.id}">Reject</button></div>`;
  else controls = decided(a);
  const err = ui.errors[a.id] ? `<p class="error" role="alert">${esc(ui.errors[a.id])}</p>` : '';
  return `<article class="approval" data-card="${a.id}">${head}${open && mode === 'edit' ? '' : body}${controls}${err}</article>`;
}

const FIELD_LABEL: Record<string, string> = { subject: 'Subject', body: 'Body', stage: 'Stage', reason: 'Reason', title: 'Title', due_date: 'Due date (YYYY-MM-DD)' };
function editForm(a: ActionState): string {
  const tool = TOOL_BY_NAME[a.tool];
  const draft = ui.drafts[a.id] ?? {};
  const fields = (tool.editable ?? []).map((f) => {
    const v = draft[f] ?? String(a.finalInput[f] ?? '');
    const id = `f-${a.id}-${f}`;
    const attrs = `id="${id}" data-id="${a.id}" data-field="${f}"`;
    const opts = tool.input_schema.properties?.[f]?.enum;
    const control = opts ? `<select ${attrs}>${opts.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
      : f === 'due_date' ? `<input ${attrs} value="${esc(v)}" inputmode="numeric">` : `<textarea ${attrs} rows="${f === 'body' ? 12 : Math.min(5, Math.max(2, Math.ceil(v.length / 24)))}">${esc(v)}</textarea>`;
    return `<label for="${id}">${FIELD_LABEL[f] ?? f}</label>${control}`;
  }).join('');
  const example = a.tool === 'send_email' ? `<button type="button" class="link" data-act="example-edit" data-id="${a.id}">Add an example P.S.</button>` : '';
  return `<div class="form">${fields}${example}<p class="muted">The edited version is what executes, and the model is told it was edited.</p><div class="actions"><button class="primary" data-act="save-edit" data-id="${a.id}">Save and approve</button><button data-act="cancel-mode" data-id="${a.id}">Cancel</button></div></div>`;
}

function rejectForm(a: ActionState): string {
  const id = `r-${a.id}`;
  return `<div class="form"><label for="${id}">Reason. The model gets this as the tool result and adapts.</label><textarea id="${id}" rows="3" data-id="${a.id}" data-field="__reason" placeholder="For example: Legal asked us to pause outreach until Friday">${esc(ui.drafts[a.id]?.__reason ?? '')}</textarea><div class="actions"><button class="danger" data-act="confirm-reject" data-id="${a.id}">Reject with this reason</button><button data-act="cancel-mode" data-id="${a.id}">Cancel</button></div></div>`;
}

function decided(a: ActionState): string {
  const ev = SHOWN.find((e) => e.type === 'approval_decided' && e.actionId === a.id);
  const when = ev ? ` at ${time(ev.at)}` : '';
  if (!a.decision) return '<div class="decided">Not decided. The run ended first.</div>';
  if (a.decision.type === 'reject') return `<div class="decided bad">Rejected by ${esc(a.decidedBy)}${when}. Reason: "${esc(a.decision.reason)}". Nothing ran; the reason went back to the model.</div>`;
  const outcome = a.status === 'executed' ? ' Executed.' : a.status === 'failed' ? ` Failed: ${esc(a.error)}` : ' Queued to execute.';
  return `<div class="decided good">${a.decision.type === 'edit' ? 'Edited, then approved' : 'Approved'} by ${esc(a.decidedBy)}${when}.${outcome}</div>`;
}

function gate(s: RunState, turn: number): string {
  const acts = s.actionOrder.map((id) => s.actions[id]).filter((a) => a.needsApproval && a.turn === turn);
  const waiting = s.status === 'awaiting_approval' ? acts.filter((a) => a.status === 'pending_approval').length : 0;
  const head = waiting
    ? `<h3>Waiting for ${REP}</h3><p>${waiting} of ${acts.length} proposed changes need a decision. The run is parked in <code>awaiting_approval</code> and nothing has been written. Edits and rejection reasons go back to the model.</p><p class="muted">Worth trying here: throw the process away and rebuild this parked run from the event log.</p><div class="actions"><button type="button" data-act="crash">Simulate crash + resume</button></div>`
    : `<h3>Approval gate</h3><p class="muted">${acts.length} changes needed a decision from ${REP}.</p>`;
  return `<section class="gate${waiting ? ' open' : ''}" id="gate-${turn}">${head}${acts.map((a) => approval(a, s)).join('')}</section>`;
}

function execution(s: RunState, id: string): string {
  const a = s.actions[id];
  const evs = SHOWN.filter((e) => (e as any).actionId === id || e.type === 'recovered');
  const i = a.finalInput;
  const label = a.tool === 'send_email' ? `Send email to ${contact(i.to_contact_id)?.name}` : a.tool === 'create_task' ? `Create task on ${i.deal_id}` : `Move ${i.deal_id} to ${i.stage}`;
  const lines: string[] = [];
  let started = false;
  let finished = false;
  for (const e of evs) {
    if (e.type === 'action_attempt') { started = true; lines.push(`Attempt ${e.attempt}, idempotency key <code>${esc(e.idempotencyKey)}</code>`); }
    if (e.type === 'action_retry_scheduled') lines.push(`Transient failure: ${esc(e.error)}. Retrying in ${e.delayMs / 1000} s with the same key.`);
    if (e.type === 'recovered' && started && !finished) lines.push('Crash here. The recovered harness picked the action up from the log.');
    if (e.type === 'action_executed' || e.type === 'action_failed') finished = true;
    if (e.type === 'action_executed') lines.push((e.result as any)?.deduplicated ? 'The provider had already accepted a message with this key, so it returned the original instead of sending again. Sent exactly once.' : 'Done.');
    if (e.type === 'action_failed') lines.push(`Failed (${e.kind}): ${esc(e.error)}`);
  }
  const mine = evs.filter((e) => (e as any).actionId === id);
  const last = mine.at(-1);
  if (last?.type === 'action_retry_scheduled') lines.push(`<span class="waiting">Waiting ${last.delayMs / 1000} s before the next attempt</span>`);
  return step(`exec${a.status === 'failed' ? ' bad' : ''}`, esc(label), `<span class="tag">${a.tool}</span>`, `<ol>${lines.map((l) => `<li>${l}</li>`).join('')}</ol>`);
}

function recovered(e: Ev<'recovered'>): string {
  const hint: Partial<Record<RunStatus, string>> = {
    awaiting_approval: 'Still parked at the approval gate above. Decisions there continue the run.',
    executing: 'Execution continues. Finished actions are skipped, and an interrupted one retries with its original idempotency key.',
    running: 'The model call that was in flight is simply made again.',
  };
  return step(`info${e.seq === ui.flashSeq ? ' highlight' : ''}`, 'Simulated crash, then recovery', `<span class="meta">${time(e.at)}</span>`,
    `<p>The in-memory harness was thrown away. A new one loaded the saved event log, replayed ${e.replayed} events and rebuilt the run.</p><dl class="ctx"><dt>Status</dt><dd>${STATE_LABEL[e.status]}</dd><dt>Digest before</dt><dd><code>${e.digestBefore}</code></dd><dt>Digest after</dt><dd><code>${e.digestAfter}</code> ${e.digestBefore === e.digestAfter ? '(identical)' : '(different)'}</dd></dl><p class="muted">${hint[e.status] ?? 'Nothing was left to do.'}</p>`);
}

function timelineHtml(s?: RunState): string {
  if (!s) return `<p class="intro">Press Run. The agent looks for ${REP}'s deals with no activity in 14 or more days, reads their history and proposes follow-ups. Nothing is written until the approval policy allows it. Today in the demo CRM is ${TODAY}.</p>`;
  const ev = SHOWN;
  const results = new Map(ev.filter((e): e is Ev<'tool_result'> => e.type === 'tool_result').map((e) => [e.toolUseId, e]));
  const calls = new Map(ev.filter((e): e is Ev<'tool_called'> => e.type === 'tool_called').map((e) => [e.toolUseId, e]));
  const out: string[] = [];
  const execShown = new Set<string>();
  let ctx: ContextInfo | undefined;
  let n = 0;
  let turn = 0;
  for (const e of ev) {
    if (e.type === 'run_created') out.push(step('', `${REP} asked`, `<span class="meta">${time(e.at)}</span>`, `<p>${esc(e.request)}</p>`));
    if (e.type === 'model_request') ctx = e;
    if (e.type === 'model_response') { turn = e.turn; out.push(modelStep(e, ctx, ++n)); }
    if (e.type === 'tool_called' && e.kind === 'read') out.push(readStep(e, results.get(e.toolUseId)));
    if (e.type === 'permission_denied') {
      const c = calls.get(e.toolUseId);
      out.push(step('bad', 'Blocked by permissions', `<span class="tag">${esc(e.tool)}</span>`, `<p>${esc(c?.tool)} ${esc((c?.input as any)?.deal_id)}: ${esc(e.reason)}</p><p class="muted">Enforced in the tool layer, not the prompt. Logged, returned to the model as an is_error tool_result, and not retried.</p>`));
    }
    if (e.type === 'validation_failed') {
      out.push(step('warn', 'Rejected by the schema check', `<span class="tag">${esc(e.tool)}</span>`, `<p>${e.errors.map(esc).join('<br>')}</p><p class="muted">Every input is validated before anything runs. This went back to the model as an is_error tool_result; nothing executed.</p>${details(`v-${e.seq}`, 'Input', `<pre>${pretty(calls.get(e.toolUseId)?.input)}</pre>`)}`));
    }
    if (e.type === 'action_proposed' && !e.action.needsApproval) out.push(`<div class="auto"><strong>Auto-approved by policy</strong> (low-risk write): ${esc(actionLabel(e.action.tool, e.action.input))}</div>`);
    if (e.type === 'state_changed' && e.to === 'awaiting_approval') out.push(gate(s, turn));
    if (e.type === 'state_changed' && e.to === 'failed') out.push(step('bad', 'Run failed', '', `<p>${esc(e.reason)}</p>`));
    if (e.type === 'state_changed' && e.to === 'cancelled') out.push(step('', 'Run cancelled', '', `<p>${esc(e.reason)}. Pending approvals were never executed.</p>`));
    if (e.type === 'action_attempt' && !execShown.has(e.actionId)) { execShown.add(e.actionId); out.push(execution(s, e.actionId)); }
    if (e.type === 'recovered') out.push(recovered(e));
    if (e.type === 'session_started') out.push(step('info', `Session ${e.session}: ${REP} asked`, `<span class="meta">${time(e.at)}</span>`, `<p>${esc(e.text)}</p><p class="muted">A new working session. The model gets the task memo plus the last ${RECENT_TURNS} turns as text, not the transcript.</p>`));
  }
  if (s.status === 'running' && ev.at(-1)?.type === 'model_request') out.push('<div class="step pending">Model is working</div>');
  if (s.status === 'completed' && s.session === 1) {
    out.push(step('info', 'Later: a new session', '', `<p>Pick the task up the next day. The harness starts a fresh conversation from the task memo instead of replaying the transcript.</p><p><em>"${esc(SESSION_2_TEXT)}"</em></p><div class="actions"><button class="primary" data-act="session2">Start session 2</button></div>`));
  }
  if (ui.errors.global) out.push(step('bad', 'Unexpected error', '', `<p>${esc(ui.errors.global)}</p>`));
  return out.join('');
}

function crmHtml(): string {
  const rows = (xs: string[], empty: string) => (xs.length ? `<div class="rows">${xs.join('')}</div>` : `<p class="empty">${empty}</p>`);
  const outbox = email.outbox.map((m) => {
    const tries = email.attempts.filter((x) => x.key === m.key);
    return `<div class="row"><strong>${esc(m.subject)}</strong><div class="meta">To ${mail(m.to)}. Key <code>${esc(m.key)}</code></div><div class="meta">Delivery attempts with this key: ${tries.length} (${esc(tries.map((t) => t.outcome).join('; '))}). Messages sent: 1.</div>${details(`o-${m.key}`, 'Body', `<pre>${esc(m.body)}</pre>`)}</div>`;
  });
  const tasks = crm.tasks.map((t) => `<div class="row"><strong>${esc(t.title)}</strong><div class="meta">${t.id} on ${t.dealId}. Due ${t.dueDate}</div></div>`);
  const deals = crm.deals.map((d) => {
    const mine = d.ownerId === DEMO_REP;
    const changed = crm.changes.some((c) => c.text.startsWith(d.id));
    return `<div class="row${mine ? '' : ' other'}${changed ? ' changed' : ''}"><div class="top-line"><strong>${d.id} ${esc(d.account)}</strong><span>${esc(d.stage)}${changed ? ' (changed)' : ''}</span></div><div class="meta">${esc(d.name)}. ${money(d.amount)}. Last activity ${daysBetween(lastActivity(d), TODAY)} days ago</div><div class="meta">Owner: ${mine ? REP : 'Sam Ortiz. Outside Jordan\'s scope, so the tools cannot read or change it.'}</div></div>`;
  });
  return `<p class="intro">The fake CRM and email provider. Like a real database they survive a simulated crash, and they change only when an approved action executes.</p>
    <h2>What changed</h2>${crm.changes.length ? `<ol class="list">${crm.changes.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ol>` : '<p class="empty">Nothing yet.</p>'}
    <h2>Email provider outbox</h2>${rows(outbox, 'No emails sent.')}<h2>Tasks</h2>${rows(tasks, 'No tasks yet.')}<h2>Deals</h2>${rows(deals, '')}`;
}

function memoHtml(s?: RunState): string {
  if (!s) return '<p class="intro">The task memo appears when a run starts.</p>';
  const memo = memoOf(s);
  const c = s.lastContext;
  const ctx = c ? `<dl class="ctx"><dt>Session</dt><dd>${c.session}</dd><dt>Sent</dt><dd>${c.mode === 'full_history' ? 'Session history, large results trimmed' : `Memo plus last ${RECENT_TURNS} turns`}</dd><dt>Messages</dt><dd>${c.messages}</dd><dt>Size</dt><dd>about ${c.approxTokens.toLocaleString('en-US')} tokens</dd><dt>Full history</dt><dd>about ${c.fullHistoryApproxTokens.toLocaleString('en-US')} tokens</dd></dl>` : '<p class="empty">No model call yet.</p>';
  const first = s.messages[0]?.content;
  const opening = s.session > 1 && typeof first === 'string' ? details('s2-open', 'What session 2 sent to the model', `<pre>${esc(first)}</pre>`) : '';
  return `<p class="intro">A compact record kept with the run and rebuilt from the event log. A later session starts from this instead of the transcript.</p>
    <h2>Goal</h2><p>${esc(memo.goal)}</p><h2>Facts gathered</h2>${list(memo.facts, 'None yet.')}<h2>Decisions</h2>${list(memo.decisions, 'None yet.')}
    <h2>Pending</h2>${list(memo.pending, 'Nothing pending.')}<h2>Context on the last model call</h2>${ctx}${opening}`;
}

function auditHtml(): string {
  const ev = SHOWN;
  if (!ev.length) return '<p class="intro">Every event of the run lands here: model turns, tool calls and inputs, results, permission denials, retries and approval decisions, each with who and when.</p>';
  return `<p class="intro">${ev.length} events, append-only. Run state is never saved directly; it is rebuilt by replaying these in order.</p>` +
    ev.map((e) => `<details class="audit-item" data-open-id="a-${e.seq}"${ui.open.has(`a-${e.seq}`) ? ' open' : ''}><summary><span class="when">#${e.seq} ${time(e.at)} ${esc(e.actor)} ${e.type}</span><span class="line">${esc(describeEvent(e))}</span></summary><pre>${pretty(e)}</pre></details>`).join('');
}

const app = document.getElementById('app')!;
app.innerHTML = `
  <section class="card request">
    <div class="who">Signed in as <strong>${REP}</strong>, sales rep. The same CRM holds deals owned by Sam Ortiz, which Jordan's tools cannot touch.</div>
    <blockquote>${esc(DEMO_REQUEST)}</blockquote>
    <div class="controls">
      <button class="primary" data-act="run">Run</button>
      <button data-act="crash">Simulate crash + resume</button>
      <button data-act="cancel">Cancel run</button>
      <button data-act="skip">Skip ahead</button>
      <button data-act="reset">Reset</button>
    </div>
  </section>
  <div class="sticky"><ol class="states" id="states" aria-label="Run state"></ol><nav class="tabs" id="tabs" role="tablist" aria-label="Views"></nav></div>
  <div class="layout">
    <section class="panel" data-panel="timeline" aria-label="Timeline"></section>
    <section class="panel" data-panel="crm" aria-label="CRM"></section>
    <section class="panel" data-panel="memo" aria-label="Memo"></section>
    <section class="panel" data-panel="audit" aria-label="Audit log"></section>
  </div>`;
const panel = (t: Tab) => app.querySelector(`[data-panel="${t}"]`) as HTMLElement;
const control = (act: string) => app.querySelector(`.controls [data-act="${act}"]`) as HTMLButtonElement;

function render() {
  SHOWN = store.events.slice(0, ui.shown);
  const s = SHOWN.length ? replay(SHOWN) : undefined;
  const live = harness?.state;
  const ended = !live || ['completed', 'failed', 'cancelled'].includes(live.status);
  control('run').disabled = !!harness;
  control('crash').disabled = !harness;
  control('cancel').disabled = ended;
  control('skip').disabled = !live || (ui.shown >= store.events.length && !['running', 'executing'].includes(live.status));
  app.querySelector('#states')!.innerHTML = statesHtml(s);
  app.querySelector('#tabs')!.innerHTML = tabsHtml();
  panel('timeline').innerHTML = timelineHtml(s);
  panel('crm').innerHTML = crmHtml();
  panel('memo').innerHTML = memoHtml(s);
  panel('audit').innerHTML = auditHtml();
  for (const t of ['timeline', 'crm', 'memo', 'audit'] as Tab[]) {
    panel(t).classList.toggle('active', t === ui.tab);
    panel(t).classList.toggle('side', t === sideTab());
  }
}

/** Follow the newest step, unless the reader has scrolled up to look at something. */
function follow(near: boolean) {
  if (!(ui.stick || near) || (ui.tab !== 'timeline' && !desktop.matches)) return;
  const tl = panel('timeline');
  const gateEl = tl.querySelector<HTMLElement>('.gate.open');
  if (gateEl) {
    if (ui.lastGate !== gateEl.id) { ui.lastGate = gateEl.id; ui.stick = false; gateEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    return;
  }
  tl.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

app.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!btn || (btn as HTMLButtonElement).disabled) return;
  const id = btn.dataset.id ?? '';
  const s = harness?.state;
  const a = s?.actions[id];
  switch (btn.dataset.act) {
    case 'run': return run();
    case 'crash': return crashAndResume();
    case 'cancel': harness?.cancel(); return render();
    case 'reset': return reset();
    case 'tab': {
      ui.tab = btn.dataset.tab as Tab;
      render();
      const top = (app.querySelector('.layout') as HTMLElement).getBoundingClientRect().top + scrollY - (app.querySelector('.sticky') as HTMLElement).offsetHeight;
      return window.scrollTo({ top: Math.min(scrollY, top) });
    }
    case 'approve': return decide(id, { type: 'approve' });
    case 'edit': case 'reject': ui.mode[id] = btn.dataset.act; delete ui.errors[id]; return render();
    case 'cancel-mode': delete ui.mode[id]; delete ui.errors[id]; return render();
    case 'example-edit': {
      const d = (ui.drafts[id] ??= {});
      const body = d.body ?? String(a?.finalInput.body ?? '');
      if (!body.includes(PS.trim())) d.body = body + PS;
      return render();
    }
    case 'save-edit': {
      if (!a) return;
      const draft = ui.drafts[id] ?? {};
      const input: Record<string, unknown> = {};
      for (const f of TOOL_BY_NAME[a.tool].editable ?? []) if (draft[f] !== undefined && draft[f] !== String(a.input[f] ?? '')) input[f] = draft[f];
      return decide(id, Object.keys(input).length ? { type: 'edit', input } : { type: 'approve' });
    }
    case 'confirm-reject': {
      const reason = (ui.drafts[id]?.__reason ?? '').trim();
      if (!reason) { ui.errors[id] = 'Add a reason. It goes back to the model.'; return render(); }
      return decide(id, { type: 'reject', reason });
    }
    case 'skip': return skipAhead();
    case 'session2': ui.stick = true; return drive(harness!.startSession(SESSION_2_TEXT));
  }
});
const saveDraft = (ev: Event) => {
  const el = ev.target as HTMLInputElement;
  if (el.dataset?.field && el.dataset.id) (ui.drafts[el.dataset.id] ??= {})[el.dataset.field] = el.value;
};
app.addEventListener('input', saveDraft);
app.addEventListener('change', saveDraft);
document.addEventListener('toggle', (ev) => {
  const d = ev.target as HTMLDetailsElement;
  const id = d.dataset?.openId;
  if (id) d.open ? ui.open.add(id) : ui.open.delete(id);
}, true);
for (const t of ['wheel', 'touchmove'] as const) addEventListener(t, () => { ui.stick = false; }, { passive: true });
desktop.addEventListener('change', render);
reset();
