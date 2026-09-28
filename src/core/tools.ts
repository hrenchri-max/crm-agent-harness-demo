import type Anthropic from '@anthropic-ai/sdk';
import { ToolError, type Risk } from './types.ts';
import { STAGES, TODAY, daysBetween, lastActivity, type EmailProvider, type RepScopedCrm } from './crm.ts';
import type { JsonSchema } from './validate.ts';

export interface ToolContext { crm: RepScopedCrm; email: EmailProvider; idempotencyKey: string }

type Input = Record<string, any>;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, s.lastIndexOf(' ', n))}...`);

export interface ToolDef {
  name: string;
  description: string;
  kind: 'read' | 'write';
  risk: Risk; // low-risk writes are auto-approved by policy; medium and high wait for the rep
  input_schema: JsonSchema & { type: 'object' };
  editable?: string[]; // fields the rep may change at the approval gate
  authorize?(input: Input, ctx: ToolContext): void; // write pre-check at proposal time; throws ToolError
  handler(input: Input, ctx: ToolContext): unknown | Promise<unknown>;
  facts?(input: Input, result: any): string[]; // compact lines for the task memo
}

const dealId: JsonSchema = { type: 'string', pattern: '^D-\\d{3}$', description: 'Deal id, e.g. D-101' };
const obj = (properties: Record<string, JsonSchema>, required: string[]) =>
  ({ type: 'object', properties, required, additionalProperties: false }) as const;

export const TOOLS: ToolDef[] = [
  {
    name: 'list_my_deals',
    kind: 'read', risk: 'low',
    description: "List the acting rep's open deals with stage, amount and days since the last logged activity. Call this first whenever the rep asks about their pipeline or about deals that have gone quiet.",
    input_schema: obj({ min_days_quiet: { type: 'integer', minimum: 0, maximum: 365, description: 'Only return deals with no activity for at least this many days.' } }, []),
    handler: (i, { crm }) => crm.myDeals()
      .map((d) => ({ deal_id: d.id, name: d.name, account: d.account, stage: d.stage, amount: d.amount, last_activity: lastActivity(d), days_quiet: daysBetween(lastActivity(d), TODAY) }))
      .filter((d) => d.days_quiet >= (i.min_days_quiet ?? 0))
      .sort((a, b) => b.days_quiet - a.days_quiet),
    facts: (_i, r: any[]) => r.map((d) => `${d.deal_id} ${d.account}: ${d.stage}, $${d.amount.toLocaleString('en-US')}, quiet ${d.days_quiet} days`),
  },
  {
    name: 'get_deal',
    kind: 'read', risk: 'low',
    description: 'Get one deal with its contacts and activity history (newest first). Call this before drafting anything about a deal so the draft reflects what actually happened.',
    input_schema: obj({ deal_id: dealId }, ['deal_id']),
    handler: (i, { crm }) => {
      const d = crm.deal(i.deal_id);
      return {
        deal_id: d.id, name: d.name, account: d.account, stage: d.stage, amount: d.amount,
        days_quiet: daysBetween(lastActivity(d), TODAY),
        contacts: crm.contactsOn(d).map((c) => ({ contact_id: c.id, name: c.name, title: c.title, email: c.email })),
        activities: [...d.activities].sort((a, b) => b.date.localeCompare(a.date)),
      };
    },
    facts: (_i, r) => [`${r.deal_id} latest (${r.activities[0]?.date}): ${clip(String(r.activities[0]?.summary), 200)}`],
  },
  {
    name: 'send_email',
    kind: 'write', risk: 'high',
    description: "Send an email from the rep to a contact on one of the rep's deals. Does not send immediately: the rep reviews every email first and may edit or reject it. The tool result tells you what happened.",
    input_schema: obj({
      deal_id: dealId,
      to_contact_id: { type: 'string', pattern: '^C-\\d{2}$', description: 'A contact on that deal' },
      subject: { type: 'string', minLength: 3, maxLength: 120 },
      body: { type: 'string', minLength: 20, maxLength: 2000, description: 'Plain text, signed by the rep' },
    }, ['deal_id', 'to_contact_id', 'subject', 'body']),
    editable: ['subject', 'body'],
    authorize: (i, { crm }) => {
      const d = crm.deal(i.deal_id);
      if (!d.contactIds.includes(i.to_contact_id)) throw new ToolError('validation', `${i.to_contact_id} is not a contact on ${i.deal_id}.`);
    },
    handler: async (i, { crm, email, idempotencyKey }) => {
      const c = crm.contactsOn(crm.deal(i.deal_id)).find((x) => x.id === i.to_contact_id)!;
      const sent = await email.send({ key: idempotencyKey, from: crm.rep.email, to: c.email, subject: i.subject, body: i.body });
      crm.logEmail(`${idempotencyKey}:log`, i.deal_id, c.name, i.subject);
      return { message_id: sent.messageId, to: `${c.name} <${c.email}>`, subject: i.subject, deduplicated: sent.deduplicated };
    },
  },
  {
    name: 'create_task',
    kind: 'write', risk: 'low',
    description: 'Create a follow-up task for the rep on a deal. Use this to log next steps. Low risk, so it runs without waiting for approval.',
    input_schema: obj({
      deal_id: dealId,
      title: { type: 'string', minLength: 3, maxLength: 120 },
      due_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD, today or later' },
    }, ['deal_id', 'title', 'due_date']),
    editable: ['title', 'due_date'],
    authorize: (i, { crm }) => {
      crm.deal(i.deal_id);
      if (i.due_date < TODAY) throw new ToolError('validation', `due_date ${i.due_date} is in the past (today is ${TODAY}).`);
    },
    handler: (i, { crm, idempotencyKey }) => {
      const t = crm.createTask(idempotencyKey, i.deal_id, i.title, i.due_date);
      return { task_id: t.id, title: t.title, due_date: t.dueDate };
    },
  },
  {
    name: 'update_deal_stage',
    kind: 'write', risk: 'medium',
    description: "Move one of the rep's deals to a different pipeline stage, with a short reason. The rep approves stage changes before they apply.",
    input_schema: obj({
      deal_id: dealId,
      stage: { type: 'string', enum: STAGES },
      reason: { type: 'string', minLength: 5, maxLength: 300 },
    }, ['deal_id', 'stage', 'reason']),
    editable: ['stage', 'reason'],
    authorize: (i, { crm }) => { crm.deal(i.deal_id); },
    handler: (i, { crm, idempotencyKey }) => ({ deal_id: i.deal_id, ...crm.setStage(idempotencyKey, i.deal_id, i.stage) }),
  },
];

export const TOOL_BY_NAME: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** The definitions sent to the Messages API. Order is fixed so the prompt-cache prefix stays stable. */
export function toApiTools(tools: ToolDef[] = TOOLS): Anthropic.Tool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema }));
}

export function actionLabel(tool: string, i: Input): string {
  if (tool === 'send_email') return `email "${i.subject}" on ${i.deal_id}`;
  if (tool === 'create_task') return `task "${i.title}" on ${i.deal_id}, due ${i.due_date}`;
  if (tool === 'update_deal_stage') return `move ${i.deal_id} to ${i.stage}`;
  return `${tool} ${JSON.stringify(i)}`;
}
