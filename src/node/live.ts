// npm run live [-- "your request"]   Runs the harness against the real Claude API with your own key.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Crm, EmailProvider } from '../core/crm.ts';
import { EventStore, Harness } from '../core/harness.ts';
import { describeEvent } from '../core/describe.ts';
import { DEMO_REP, DEMO_REQUEST } from '../core/prewritten-model.ts';
import { TOOL_BY_NAME } from '../core/tools.ts';
import { AnthropicModel } from './anthropic-model.ts';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY in your environment first. This script never writes it anywhere.');
  process.exit(1);
}

const request = process.argv.slice(2).join(' ') || DEMO_REQUEST;
const budgetUsd = Number(process.env.SPEND_CAP_USD ?? 1);
const store = new EventStore();
const model = new AnthropicModel(undefined, { budgetUsd, log: (l) => console.log(`  [${l}]`) });
store.subscribe((e) => {
  console.log(`#${e.seq} ${e.actor}: ${describeEvent(e)}`);
  if (e.type === 'model_response') for (const b of e.message.content) if (b.type === 'text') console.log(`\n${b.text}\n`);
});

const runId = `run_${Date.now()}`;
const harness = Harness.start({ store, model, crm: new Crm(), email: new EmailProvider() }, runId, DEMO_REP, request);
const rl = createInterface({ input: stdin, output: stdout });

await harness.advance();
while (harness.state.status === 'awaiting_approval') {
  const pending = Object.values(harness.state.actions).filter((a) => a.status === 'pending_approval');
  for (const a of pending) {
    console.log(`\n--- Needs approval: ${a.tool} (${a.risk} risk) ---\n${JSON.stringify(a.input, null, 2)}`);
    const choice = (await rl.question('[a]pprove, [e]dit, [r]eject? ')).trim().toLowerCase();
    if (choice.startsWith('r')) {
      await harness.decide(a.id, { type: 'reject', reason: (await rl.question('Reason (goes back to the model): ')) || 'Not now.' });
    } else if (choice.startsWith('e')) {
      const input: Record<string, unknown> = {};
      for (const field of TOOL_BY_NAME[a.tool].editable ?? []) {
        const v = await rl.question(`New ${field} (Enter keeps it; use \\n for new lines): `);
        if (v) input[field] = v.replace(/\\n/g, '\n');
      }
      await harness.decide(a.id, Object.keys(input).length ? { type: 'edit', input } : { type: 'approve' });
    } else {
      await harness.decide(a.id, { type: 'approve' });
    }
  }
}
rl.close();

mkdirSync('runs', { recursive: true });
writeFileSync(`runs/${runId}.json`, store.serialize());
console.log(`\nStatus: ${harness.state.status}${harness.state.failure ? ` (${harness.state.failure})` : ''}. Spend: $${model.spentUsd.toFixed(4)}. Event log: runs/${runId}.json`);
