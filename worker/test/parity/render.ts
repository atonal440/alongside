import type { Outcome, Row } from './harness';

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

function effects(diff: Outcome['diff']): string {
  const parts: string[] = [];
  for (const [table, change] of Object.entries(diff) as [string, { added?: { key: string; tool_name?: string }[]; removed?: unknown[]; changed?: { key: string; fields: Record<string, unknown> }[] }][]) {
    if (change.added?.length) parts.push(table === 'action_log' ? `logs \`${change.added[0]!.tool_name}\`` : `${table} +${change.added.length}`);
    if (change.removed?.length) parts.push(`${table} −${change.removed.length}`);
    if (change.changed?.length) {
      const fields = [...new Set(change.changed.flatMap(c => Object.keys(c.fields)))].filter(f => f !== 'updated_at');
      const bump = change.changed.every(c => 'updated_at' in c.fields) ? ' (+updated_at)' : '';
      parts.push(`${table} ~${change.changed.length}${fields.length ? `: ${fields.join(', ')}` : ': updated_at only'}${fields.length ? bump : ''}`);
    }
  }
  return parts.length ? parts.join('; ') : 'no writes';
}

export function legacySummary(outcome: Outcome): string {
  const { result } = outcome;
  if (!result.ok) return `refused (${result.channel === 'rpc_error' ? 'JSON-RPC error' : 'tool error'}): ${result.message.slice(0, 90)}${effects(outcome.diff) === 'no writes' ? '' : ` — ${effects(outcome.diff)}`}`;
  return `ok — ${effects(outcome.diff)}`;
}

export function renderMatrix(rows: Row[], outcomes: Record<string, Outcome>, approved: Record<string, unknown>): string {
  const tools = [...new Set(rows.map(r => r.tool))];
  const out: string[] = [];
  for (const tool of tools) {
    out.push(`### \`${tool}\``, '', '| Row | Input | What it exercises | Legacy outcome | Status |', '| --- | --- | --- | --- | --- |');
    for (const row of rows.filter(r => r.tool === tool)) {
      const input = JSON.stringify(row.input);
      out.push(`| \`${row.id.slice(tool.length + 1)}\` | \`${cell(input.length > 120 ? `${input.slice(0, 117)}…` : input)}\` | ${cell(row.note)} | ${cell(legacySummary(outcomes[row.id]!))} | ${approved[row.id] ? 'approved difference' : 'must match'} |`);
    }
    out.push('');
  }
  return out.join('\n');
}
