import { ToolError } from './types.ts';

/** The demo's fixed "today", so quiet-day counts and model inputs are deterministic. */
export const TODAY = '2026-09-25';
export const STAGES = ['Discovery', 'Proposal', 'Negotiation', 'On Hold', 'Closed Won', 'Closed Lost'] as const;

export interface Rep { id: string; name: string; email: string }
export interface Contact { id: string; name: string; title: string; email: string; accountIds: string[] }
export interface Activity { date: string; kind: 'call' | 'email_out' | 'email_in' | 'meeting' | 'note'; summary: string }
export interface Deal {
  id: string; name: string; account: string; ownerId: string; stage: string; amount: number;
  contactIds: string[]; activities: Activity[];
}
export interface Task { id: string; dealId: string; title: string; dueDate: string; ownerId: string }
export interface Change { kind: 'email' | 'task' | 'stage'; text: string }

export const REPS: Rep[] = [
  { id: 'rep_jordan', name: 'Jordan Lee', email: 'jordan.lee@larkspur-demo.test' },
  { id: 'rep_sam', name: 'Sam Ortiz', email: 'sam.ortiz@larkspur-demo.test' },
];

const CONTACTS: Contact[] = [
  // Dana consults for two companies whose deals belong to different reps.
  { id: 'C-11', name: 'Dana Whitfield', title: 'Procurement consultant, Whitfield Advisory', email: 'dana@whitfield-advisory.test', accountIds: ['Brightwater Logistics', 'Halvorsen Marine Supply'] },
  { id: 'C-12', name: 'Marcus Bell', title: 'VP Operations', email: 'marcus.bell@brightwater-logistics.test', accountIds: ['Brightwater Logistics'] },
  { id: 'C-21', name: 'Renee Castillo', title: 'Director of Practice Operations', email: 'renee.castillo@copperline-dental.test', accountIds: ['Copperline Dental Group'] },
  { id: 'C-31', name: 'Omar Haddad', title: 'Head of Data', email: 'omar@tallgrass-analytics.test', accountIds: ['Tallgrass Analytics'] },
  { id: 'C-41', name: 'Luis Ferreira', title: 'Operations Manager (left the company)', email: 'luis.ferreira@pinecrest-vet.test', accountIds: ['Pinecrest Veterinary Clinics'] },
  { id: 'C-42', name: 'Grace Okafor', title: 'Practice Manager', email: 'grace.okafor@pinecrest-vet.test', accountIds: ['Pinecrest Veterinary Clinics'] },
  { id: 'C-51', name: 'Ingrid Halvorsen', title: 'COO', email: 'ingrid@halvorsen-marine.test', accountIds: ['Halvorsen Marine Supply'] },
];

const copperlineThread: Activity[] = [
  ['2026-07-20', 'meeting', 'Demo for Renee and three office managers. Biggest pain: double-booked hygienist chairs across 12 offices.'],
  ['2026-07-24', 'email_out', 'Sent recap and a pilot plan for the Elm Street office. ' + 'Covered chair utilization reporting, SMS reminders, and the migration path from their current scheduler. '.repeat(3)],
  ['2026-07-31', 'email_in', 'Renee: pilot approved for Elm Street. Wants weekly check-ins. ' + 'She asked for a breakdown of the SMS reminder costs per office and how no-show reporting rolls up to the regional view. '.repeat(3)],
  ['2026-08-07', 'call', 'Pilot week 1: no-shows down at Elm Street; front desk likes the waitlist fill.'],
  ['2026-08-14', 'call', 'Pilot week 2: chair utilization report shared with the CFO.'],
  ['2026-08-21', 'email_out', 'Sent 12-office pricing ($31,500/yr) and a tentative rollout: November, three offices per week. ' + 'Included the implementation timeline, training plan for front-desk staff, and the data migration checklist. '.repeat(3)],
  ['2026-08-28', 'email_in', 'Renee: CFO is fine on price. Sending the MSA to legal.'],
  ['2026-09-02', 'email_out', 'Sent our standard data processing addendum (DPA) at legal\'s request.'],
  ['2026-09-08', 'email_in', 'Renee: legal has the MSA redlines and is still reviewing the DPA. She will come back to us once they sign off.'],
].map(([date, kind, summary]) => ({ date, kind, summary }) as Activity);

function seedDeals(): Deal[] {
  return [
    { id: 'D-101', name: 'Fleet telematics rollout', account: 'Brightwater Logistics', ownerId: 'rep_jordan', stage: 'Proposal', amount: 48000, contactIds: ['C-11', 'C-12'], activities: [
      { date: '2026-08-18', kind: 'meeting', summary: 'Discovery with Marcus Bell: 140 trucks, wants driver-behavior scoring live before Q1.' },
      { date: '2026-08-27', kind: 'email_out', summary: 'Sent proposal v2: 3-year term, $48,000/yr, phased install (about 6 weeks for 140 trucks).' },
      { date: '2026-09-04', kind: 'call', summary: 'Call with Dana Whitfield, who runs procurement for Brightwater and also advises Halvorsen Marine. Pricing is fine. Brightwater wants to see how the Halvorsen scanner rollout (deal D-201) lands before signing.' },
    ] },
    { id: 'D-102', name: 'Scheduling suite, 12 offices', account: 'Copperline Dental Group', ownerId: 'rep_jordan', stage: 'Negotiation', amount: 31500, contactIds: ['C-21'], activities: copperlineThread },
    { id: 'D-103', name: 'Data connector add-on', account: 'Tallgrass Analytics', ownerId: 'rep_jordan', stage: 'Discovery', amount: 9800, contactIds: ['C-31'], activities: [
      { date: '2026-09-22', kind: 'call', summary: 'Omar wants a sandbox to test the warehouse connector next week.' },
    ] },
    { id: 'D-104', name: 'Clinic network renewal', account: 'Pinecrest Veterinary Clinics', ownerId: 'rep_jordan', stage: 'Proposal', amount: 22000, contactIds: ['C-41', 'C-42'], activities: [
      { date: '2026-08-05', kind: 'email_out', summary: 'Sent renewal proposal to Luis Ferreira.' },
      { date: '2026-08-14', kind: 'note', summary: 'Auto-reply: Luis Ferreira has left Pinecrest. Grace Okafor is the new practice manager. No contact with Grace yet.' },
    ] },
    { id: 'D-201', name: 'Warehouse scanner rollout', account: 'Halvorsen Marine Supply', ownerId: 'rep_sam', stage: 'Proposal', amount: 27000, contactIds: ['C-51', 'C-11'], activities: [
      { date: '2026-09-02', kind: 'call', summary: 'Ingrid wants the pilot site live before their inventory count.' },
    ] },
    { id: 'D-202', name: 'Handheld refresh', account: 'Halvorsen Marine Supply', ownerId: 'rep_sam', stage: 'Discovery', amount: 12500, contactIds: ['C-51'], activities: [
      { date: '2026-09-18', kind: 'meeting', summary: 'Scoping call for 40 handhelds.' },
    ] },
  ];
}

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
export const lastActivity = (d: Deal) => d.activities.map((a) => a.date).sort().at(-1) ?? TODAY;

/** Stands in for the database. Only the harness and the UI hold this; tools get a RepScopedCrm. */
export class Crm {
  deals = seedDeals();
  contacts = CONTACTS;
  tasks: Task[] = [];
  changes: Change[] = [];
  private applied = new Map<string, unknown>(); // idempotency key -> result

  forRep(repId: string): RepScopedCrm {
    return new RepScopedCrm(this, repId);
  }

  /** Runs a write at most once per idempotency key (the UNIQUE constraint in schema.sql). */
  once<T>(key: string, write: () => T): T {
    if (!this.applied.has(key)) this.applied.set(key, write());
    return this.applied.get(key) as T;
  }
}

/**
 * The only CRM handle a tool ever receives. Every query is filtered by the acting rep, the way
 * row-level security filters queries made with the rep's own Supabase JWT.
 */
export class RepScopedCrm {
  private crm: Crm;
  readonly rep: Rep;
  constructor(crm: Crm, repId: string) {
    this.crm = crm;
    this.rep = REPS.find((r) => r.id === repId)!;
  }

  myDeals(): Deal[] {
    return this.crm.deals.filter((d) => d.ownerId === this.rep.id);
  }

  deal(id: string): Deal {
    const d = this.crm.deals.find((x) => x.id === id);
    if (!d) throw new ToolError('not_found', `No deal with id ${id}.`);
    if (d.ownerId !== this.rep.id) throw new ToolError('permission', `${id} is not in ${this.rep.name}'s book of business, so this rep cannot read or change it.`);
    return d;
  }

  contactsOn(d: Deal): Contact[] {
    return d.contactIds.map((cid) => this.crm.contacts.find((c) => c.id === cid)!);
  }

  createTask(key: string, dealId: string, title: string, dueDate: string): Task {
    this.deal(dealId);
    return this.crm.once(key, () => {
      const t = { id: `T-${this.crm.tasks.length + 1}`, dealId, title, dueDate, ownerId: this.rep.id };
      this.crm.tasks.push(t);
      this.crm.changes.push({ kind: 'task', text: `${t.id} on ${dealId}: ${title} (due ${dueDate})` });
      return t;
    });
  }

  logEmail(key: string, dealId: string, to: string, subject: string): void {
    const d = this.deal(dealId);
    this.crm.once(key, () => {
      d.activities.push({ date: TODAY, kind: 'email_out', summary: `Emailed ${to}: ${subject}` });
      this.crm.changes.push({ kind: 'email', text: `${dealId} ${d.account}: emailed ${to}, "${subject}"` });
    });
  }

  setStage(key: string, dealId: string, stage: string): { from: string; to: string } {
    const d = this.deal(dealId);
    return this.crm.once(key, () => {
      const from = d.stage;
      d.stage = stage;
      this.crm.changes.push({ kind: 'stage', text: `${dealId} ${d.account}: ${from} to ${stage}` });
      return { from, to: stage };
    });
  }
}

export interface SentEmail { messageId: string; key: string; from: string; to: string; subject: string; body: string }

/**
 * A fake email provider that honors idempotency keys. The first send fails with a 503 AFTER the
 * provider has accepted the message: the ambiguous failure where a naive retry double-sends.
 */
export class EmailProvider {
  outbox: SentEmail[] = [];
  attempts: { key: string; outcome: string }[] = [];
  failFirstSend = true;

  async send(req: Omit<SentEmail, 'messageId'>): Promise<SentEmail & { deduplicated: boolean }> {
    const existing = this.outbox.find((m) => m.key === req.key);
    if (existing) {
      this.attempts.push({ key: req.key, outcome: 'duplicate key: returned the original message, nothing sent' });
      return { ...existing, deduplicated: true };
    }
    const msg = { ...req, messageId: `msg_${this.outbox.length + 1}` };
    this.outbox.push(msg);
    if (this.failFirstSend) {
      this.failFirstSend = false;
      this.attempts.push({ key: req.key, outcome: 'accepted, then answered 503' });
      throw new ToolError('transient', '503 Service Unavailable from the email provider (the message may or may not have been accepted)');
    }
    this.attempts.push({ key: req.key, outcome: 'sent' });
    return { ...msg, deduplicated: false };
  }
}
