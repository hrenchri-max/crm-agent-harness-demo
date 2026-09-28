import type Anthropic from '@anthropic-ai/sdk';
import type { ModelPort, ModelRequest } from './harness.ts';

export const DEMO_REP = 'rep_jordan';
export const DEMO_REQUEST = 'Which of my deals have gone quiet for 14+ days? Draft follow-ups for them and log next steps.';
export const SESSION_2_TEXT = "New day. What is still open from yesterday's stalled-deal follow-ups?";

/**
 * Stand-in for the model on the static page (a public page cannot hold an API key). Every turn is
 * written ahead of time in the exact Message shape the Messages API returns, and chosen from what
 * the harness actually sent: the tool results, the rep's edits and rejection reasons. The harness
 * cannot tell it apart from AnthropicModel, which is the point of the ModelPort seam.
 */
export class PrewrittenModel implements ModelPort {
  readonly label = 'pre-written';
  private delayMs: number;
  constructor(delayMs = 0) { this.delayMs = delayMs; }

  async create(req: ModelRequest): Promise<Anthropic.Message> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return respond(req.messages);
  }
}

const text = (t: string): Anthropic.TextBlock => ({ type: 'text', text: t, citations: null });
const call = (id: string, name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock =>
  ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } });

function message(n: number, content: Anthropic.ContentBlock[], stop: Anthropic.StopReason): Anthropic.Message {
  return {
    id: `msg_prewritten_${n}`, type: 'message', role: 'assistant', model: 'prewritten', content,
    stop_reason: stop, stop_sequence: null, stop_details: null, container: null,
    usage: {
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null,
      inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: 'standard',
    },
  };
}

type Block = { type: string; [k: string]: any };
const blocks = (m: Anthropic.MessageParam): Block[] => (typeof m.content === 'string' ? [] : (m.content as Block[]));
const json = (s: unknown) => { try { return JSON.parse(String(s)); } catch { return {}; } };

const EMAILS = {
  'D-101': {
    to_contact_id: 'C-11',
    subject: 'Brightwater telematics: a phased start while Halvorsen lands',
    body: "Hi Dana,\n\nWhen we spoke on the 4th, you said Brightwater wants to see how the Halvorsen rollout goes before signing. That makes sense.\n\nOne timing point to weigh: Marcus wants driver-behavior scoring live before Q1, and installing 140 trucks takes about six weeks. A phased start would let Brightwater begin with a single depot now and commit the rest of the fleet once you have seen results.\n\nWould 20 minutes this week work to walk through it?\n\nBest,\nJordan",
  },
  'D-102': {
    to_contact_id: 'C-21',
    subject: 'Copperline: helping legal close out the DPA',
    body: 'Hi Renee,\n\nChecking in on the data processing addendum. Last we heard, legal had the MSA redlines and was still reviewing the DPA.\n\nIf it would help, I can set up a short call between our privacy counsel and yours to settle any open points. We are still holding the November rollout slots (three offices a week) while that finishes.\n\nBest,\nJordan',
  },
} as const;

function respond(messages: Anthropic.MessageParam[]): Anthropic.Message {
  const first = messages[0];
  if (typeof first.content === 'string' && first.content.includes('<task_memo>')) return nextSession(first.content);

  const turns = messages.filter((m) => m.role === 'assistant');
  const n = turns.length + 1;
  const lastCalls = turns.length ? blocks(turns.at(-1)!).filter((b) => b.type === 'tool_use') : [];
  const results = new Map<string, Block>();
  for (const m of messages) for (const b of blocks(m)) if (b.type === 'tool_result') results.set(b.tool_use_id, b);
  const names = lastCalls.map((c) => c.name);

  if (!turns.length) {
    return message(n, [text("I'll pull your open deals that have been quiet for 14 days or more."), call('toolu_pw_01', 'list_my_deals', { min_days_quiet: 14 })], 'tool_use');
  }
  if (names.includes('list_my_deals')) {
    const deals: any[] = json(results.get(lastCalls[0].id)?.content);
    const ids = Array.isArray(deals) ? deals.map((d) => d.deal_id) : [];
    if (!ids.length) return message(n, [text('None of your open deals have been quiet for 14 days or more, so there is nothing to follow up on today.')], 'end_turn');
    return message(n, [
      text(`${ids.length} deals have gone quiet. I'll read the history on each before drafting anything.`),
      ...ids.map((id, i) => call(`toolu_pw_02_${i + 1}`, 'get_deal', { deal_id: id })),
    ], 'tool_use');
  }
  if (names.length && names.every((x) => x === 'get_deal')) {
    const asked = lastCalls.map((c) => c.input.deal_id);
    const mentions201 = lastCalls.some((c) => String(results.get(c.id)?.content).includes('D-201'));
    if (mentions201 && !asked.includes('D-201')) {
      return message(n, [
        text('Dana tied the Brightwater decision to the Halvorsen scanner rollout (D-201). I\'ll check where that deal stands before writing to her.'),
        call('toolu_pw_03', 'get_deal', { deal_id: 'D-201' }),
      ], 'tool_use');
    }
    return proposals(n, asked.includes('D-201'));
  }
  if (names.includes('send_email')) return fixUps(n, lastCalls, results, messages);
  return summary(n, messages, results);
}

function proposals(n: number, checked201: boolean): Anthropic.Message {
  const intro = checked201
    ? "D-201 isn't in your book, so I can't see how the Halvorsen rollout is going. I'll write to Dana without it.\n\n"
    : '';
  return message(n, [
    text(`${intro}Here is what I'd do on each stalled deal:\n- Brightwater (D-101): follow up with Dana on timing and offer a phased start.\n- Copperline (D-102): nudge Renee on the DPA and offer a counsel-to-counsel call.\n- Pinecrest (D-104): our champion left, so move it to On Hold and reach the new practice manager.`),
    call('toolu_pw_04_1', 'send_email', { deal_id: 'D-101', ...EMAILS['D-101'] }),
    call('toolu_pw_04_2', 'create_task', { deal_id: 'D-101', title: 'Call Dana Whitfield if there is no reply to the telematics follow-up', due_date: '2026-10-02' }),
    call('toolu_pw_04_3', 'send_email', { deal_id: 'D-102', ...EMAILS['D-102'] }),
    call('toolu_pw_04_4', 'create_task', { deal_id: 'D-102', title: "Check with Renee on legal's DPA sign-off", due_date: '2026-09-30T09:00' }),
    call('toolu_pw_04_5', 'update_deal_stage', { deal_id: 'D-104', stage: 'On Hold', reason: 'Our champion, Luis Ferreira, left Pinecrest in August. Grace Okafor, the new practice manager, has not been contacted yet.' }),
    call('toolu_pw_04_6', 'create_task', { deal_id: 'D-104', title: 'Introduce yourself to Grace Okafor, the new practice manager at Pinecrest', due_date: '2026-09-29' }),
  ], 'tool_use');
}

/** After the gate: repair the invalid task, and turn each rejected email into a reminder. */
function fixUps(n: number, calls: Block[], results: Map<string, Block>, messages: Anthropic.MessageParam[]): Anthropic.Message {
  const lines: string[] = [];
  const next: Anthropic.ToolUseBlock[] = [];
  for (const c of calls) {
    const r = results.get(c.id);
    const body = json(r?.content);
    if (c.name === 'create_task' && body.error === 'invalid_input') {
      lines.push("One task had a time on its due date, which the task tool doesn't accept. I'm re-creating it with the date only.");
      next.push(call(`toolu_pw_05_${next.length + 1}`, 'create_task', { ...c.input, due_date: String(c.input.due_date).slice(0, 10) }));
    }
    if (c.name === 'send_email' && body.status === 'rejected_by_rep') {
      const name = c.input.to_contact_id === 'C-11' ? 'Dana' : 'Renee';
      lines.push(`You held the email to ${name} ("${body.reason}"), so it stays unsent. I'll log a reminder instead.`);
      next.push(call(`toolu_pw_05_${next.length + 1}`, 'create_task', { deal_id: c.input.deal_id, title: `Revisit the email to ${name}: ${body.reason}`.slice(0, 120), due_date: '2026-10-02' }));
    }
  }
  if (!next.length) return summary(n, messages, results);
  return message(n, [text(lines.join('\n')), ...next], 'tool_use');
}

function summary(n: number, messages: Anthropic.MessageParam[], results: Map<string, Block>): Anthropic.Message {
  const calls = messages.filter((m) => m.role === 'assistant').flatMap(blocks).filter((b) => b.type === 'tool_use');
  return summaryFrom(n, calls, results);
}

function summaryFrom(n: number, calls: Block[], results: Map<string, Block>): Anthropic.Message {
  const accounts: Record<string, string> = { 'D-101': 'Brightwater', 'D-102': 'Copperline', 'D-104': 'Pinecrest' };
  const byDeal: Record<string, string[]> = {};
  const add = (deal: string, line: string) => (byDeal[deal] ??= []).push(line);
  for (const c of calls) {
    const r = results.get(c.id);
    if (!r || !['send_email', 'create_task', 'update_deal_stage'].includes(c.name)) continue;
    const body = json(r.content);
    const deal = c.input.deal_id;
    if (body.status === 'rejected_by_rep') add(deal, `${c.name === 'send_email' ? 'Email not sent' : 'Stage change not applied'}. Your note: "${body.reason}"`);
    else if (r.is_error) { if (body.error !== 'invalid_input') add(deal, `${c.name} failed: ${body.message}`); }
    else if (c.name === 'send_email') add(deal, `Follow-up sent to ${String(body.result?.to).split(' <')[0]}${body.status === 'done_with_rep_edits' ? ', with your edits' : ''}.`);
    else if (c.name === 'create_task') add(deal, `Task: ${body.result?.title} (due ${body.result?.due_date}).`);
    else add(deal, `Moved from ${body.result?.from} to ${body.result?.to}.`);
  }
  const sections = Object.entries(byDeal).map(([d, ls]) => `${accounts[d] ?? d} (${d})\n${ls.map((l) => `- ${l}`).join('\n')}`);
  const denied = [...results.values()].some((r) => String(r.content).includes('permission_denied'));
  const attention = denied
    ? "\n\nNeeds your attention: Dana tied Brightwater's timing to the Halvorsen deal (D-201), which isn't in your book, so I couldn't check it. If its status matters, ask the rep who owns it."
    : '';
  return message(n, [text(`Here's where things stand.\n\n${sections.join('\n\n')}${attention}`)], 'end_turn');
}

function nextSession(opening: string): Anthropic.Message {
  const memo = json(opening.split('<task_memo>')[1]?.split('</task_memo>')[0]);
  const pending: string[] = memo.pending ?? [];
  const done: string[] = (memo.facts ?? []).filter((f: string) => f.startsWith('Done: ') && !f.startsWith('Done: task')).map((f: string) => f.slice(6));
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- Nothing');
  return message(21, [text(
    `Going from the task memo (I don't have yesterday's full conversation):\n\nStill open:\n${list(pending)}\n\nAlready done:\n${list(done)}\n\nWant me to draft anything for the open items?`,
  )], 'end_turn');
}
