import type { RunEvent } from './types.ts';
import { actionLabel } from './tools.ts';

const short = (v: unknown, n = 90) => {
  const s = JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}...` : s;
};

/** One plain-language line per event, shared by the audit log view and the CLI. */
export function describeEvent(e: RunEvent): string {
  switch (e.type) {
    case 'run_created': return `Run started: "${e.request}"`;
    case 'state_changed': return `State ${e.from} to ${e.to}${e.reason ? ` (${e.reason})` : ''}`;
    case 'model_request': return `Model call ${e.turn}, session ${e.session}: ${e.mode === 'full_history' ? 'session history' : 'memo plus recent turns'}, ${e.messages} messages, about ${e.approxTokens.toLocaleString('en-US')} tokens`;
    case 'model_response': {
      const calls = e.message.content.filter((b) => b.type === 'tool_use').length;
      return `Model replied, stop_reason ${e.message.stop_reason}${calls ? `, ${calls} tool call${calls > 1 ? 's' : ''}` : ''}`;
    }
    case 'model_error': return `Model call failed (${e.kind}): ${e.message}`;
    case 'tool_called': return `Tool call ${e.tool} ${short(e.input)}`;
    case 'validation_failed': return `Input rejected by the schema check for ${e.tool}: ${e.errors.join('; ')}`;
    case 'permission_denied': return `Permission denied on ${e.tool}: ${e.reason}`;
    case 'action_proposed': return `Proposed: ${actionLabel(e.action.tool, e.action.input)} (${e.action.risk} risk, ${e.action.needsApproval ? 'waits for the rep' : 'auto-approved by policy'})`;
    case 'approval_decided': {
      const d = e.decision;
      return `${e.by}: ${d.type === 'approve' ? 'approved' : d.type === 'edit' ? `edited ${Object.keys(d.input).join(', ')} and approved` : `rejected, reason "${d.reason}"`}`;
    }
    case 'action_attempt': return `Attempt ${e.attempt} for ${e.actionId}, idempotency key ${e.idempotencyKey}`;
    case 'action_retry_scheduled': return `Transient error: ${e.error}. Retrying in ${e.delayMs} ms with the same key`;
    case 'action_executed': return `Executed ${e.actionId} after ${e.attempts} attempt${e.attempts > 1 ? 's' : ''}${(e.result as any)?.deduplicated ? '; the provider recognized the key and did not send again' : ''}`;
    case 'action_failed': return `Action ${e.actionId} failed (${e.kind}): ${e.error}`;
    case 'tool_result': return `Result for ${e.toolUseId}${e.isError ? ' (is_error)' : ''}${e.trimmed ? ', trimmed before it reached the model' : ''}`;
    case 'session_started': return `Session ${e.session} started: "${e.text}"`;
    case 'recovered': return `Recovered by replaying ${e.replayed} events. Status ${e.status}. State digest ${e.digestBefore || 'n/a'} before, ${e.digestAfter} after${e.digestBefore === e.digestAfter ? ' (match)' : ''}`;
  }
}
