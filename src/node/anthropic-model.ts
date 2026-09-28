import Anthropic from '@anthropic-ai/sdk';
import type { ModelPort, ModelRequest } from '../core/harness.ts';
import { ToolError } from '../core/types.ts';

export const MODEL_ID = 'claude-opus-5';
const USD_PER_MTOK = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

/** The subset of the SDK client the harness uses, so tests can pass a mock. */
export interface MessagesClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export function costOf(u: Anthropic.Usage): number {
  return (u.input_tokens * USD_PER_MTOK.input + u.output_tokens * USD_PER_MTOK.output
    + (u.cache_creation_input_tokens ?? 0) * USD_PER_MTOK.cacheWrite + (u.cache_read_input_tokens ?? 0) * USD_PER_MTOK.cacheRead) / 1e6;
}

/** The real model behind the same ModelPort the page uses. The harness owns the loop; this makes one call. */
export class AnthropicModel implements ModelPort {
  readonly label = MODEL_ID;
  spentUsd = 0;
  private client: MessagesClient;
  private budgetUsd: number;
  private log: (line: string) => void;

  constructor(client: MessagesClient = new Anthropic(), opts: { budgetUsd?: number; log?: (line: string) => void } = {}) {
    this.client = client;
    this.budgetUsd = opts.budgetUsd ?? 1;
    this.log = opts.log ?? (() => {});
  }

  async create(req: ModelRequest): Promise<Anthropic.Message> {
    if (this.spentUsd >= this.budgetUsd) throw new ToolError('fatal', `spend cap of $${this.budgetUsd} reached`);
    try {
      const msg = await this.client.messages.create({
        model: MODEL_ID,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' }, // caches the stable prefix: system, tools, earlier turns
        system: req.system,
        tools: req.tools,
        messages: req.messages,
      });
      const cost = costOf(msg.usage);
      this.spentUsd += cost;
      this.log(`usage: in ${msg.usage.input_tokens}, out ${msg.usage.output_tokens}, cache read ${msg.usage.cache_read_input_tokens ?? 0}, cache write ${msg.usage.cache_creation_input_tokens ?? 0}, $${cost.toFixed(4)} (total $${this.spentUsd.toFixed(4)})`);
      return msg;
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        const transient = err.status === undefined || err.status === 429 || err.status >= 500;
        throw new ToolError(transient ? 'transient' : 'fatal', `${err.status ?? 'connection'}: ${err.message}`);
      }
      throw err;
    }
  }
}
