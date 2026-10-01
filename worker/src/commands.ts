import { parseSchema } from '@shared/parse';
import { CommandEnvelopeSchema, PlanningSettingsExportSchema } from '@shared/wire/commands';
import { CommandError } from './domain/commands';
import { invalidInput } from './domain/temporalFoundation';
import { readJson } from './parse/request';
import type { DB } from './db';

const envelope = {
  type: 'object', additionalProperties: false,
  properties: {
    contractVersion: { const: 2 }, commandId: { type: 'string', pattern: '^c_[0-9A-Za-z_-]{5,64}$' },
    actor: { enum: ['user', 'llm', 'import'] }, reason: { type: 'string', maxLength: 1000 },
    commands: { type: 'array', minItems: 1, maxItems: 1, items: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { const: 'planning.set' }, expectedRevision: { type: ['integer', 'null'], minimum: 0, maximum: 9007199254740991 },
        values: { type: 'object', additionalProperties: false, properties: {
          timezone: { type: 'string', description: 'Canonical IANA timezone or UTC; never inferred from the host.' },
          bufferMinutes: { type: 'integer', minimum: 0, maximum: 1440 },
          workingHours: { type: 'array', maxItems: 28, items: {
            type: 'object', additionalProperties: false,
            properties: { weekday: { type: 'integer', minimum: 1, maximum: 7, description: 'Monday=1, Sunday=7.' }, start: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, end: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' } },
            required: ['weekday', 'start', 'end'],
          } },
        }, required: ['timezone', 'bufferMinutes', 'workingHours'] },
      }, required: ['kind', 'expectedRevision', 'values'],
    } },
  }, required: ['contractVersion', 'commandId', 'actor', 'commands'],
};
export const COMMAND_TOOLS = [
  { name: 'get_planning_settings', description: 'Read complete workspace planning settings and their revision, or null before setup.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'export_planning_settings', description: 'Export only planning preferences, without revision or credentials. Restore non-null values through planning.set with a fresh command ID and current expectedRevision. This is not a full-workspace backup.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'preview_changes', description: 'Preview a reliable command without writes. Initial command family: exactly one planning.set. expectedRevision=null requires no settings; otherwise use the current revision. A preview is not a lock.', inputSchema: envelope },
  { name: 'apply_changes', description: 'Atomically apply exactly one planning.set command, with a caller-minted command ID and expected revision. Same ID/payload returns the original result; a different payload conflicts. Includes receipt, audit and settings change feed. Other command families are not implemented yet.', inputSchema: envelope },
];
export async function callCommandTool(name: string, args: unknown, db: DB): Promise<unknown> {
  if (name === 'get_planning_settings' || name === 'export_planning_settings') {
    if (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
      throw new CommandError(invalidInput([{ code: 'invalid_input', path: [], message: 'Expected an empty input object.' }]), 400);
    }
    const settings = await db.getPlanningSettings();
    if (name === 'get_planning_settings') return { contractVersion: 2, settings };
    const exported = parseSchema(PlanningSettingsExportSchema, { contractVersion: 2, kind: 'planning_settings', exportedAt: new Date().toISOString(),
      values: settings === null ? null : { timezone: settings.timezone, bufferMinutes: settings.bufferMinutes, workingHours: settings.workingHours },
    });
    if (!exported.ok) throw new Error('Planning export failed validation.');
    return exported.value;
  }
  const input = parseSchema(CommandEnvelopeSchema, args);
  if (!input.ok) throw new CommandError(invalidInput(input.error), 400);
  if (name === 'preview_changes') return db.previewChanges(input.value);
  if (name === 'apply_changes') return db.applyChanges(input.value);
  throw new Error(`Unknown command tool: ${name}`);
}
export async function handleCommandRequest(request: Request, url: URL, db: DB): Promise<Response | null> {
  const route = [
    ['GET', '/api/v2/planning-settings', 'get_planning_settings'],
    ['GET', '/api/v2/planning-settings/export', 'export_planning_settings'],
    ['POST', '/api/v2/changes/preview', 'preview_changes'],
    ['POST', '/api/v2/changes', 'apply_changes'],
  ].find(([method, path]) => method === request.method && path === url.pathname);
  if (!route) return null;
  try {
    if (url.search) throw new CommandError(invalidInput([{ code: 'unknown_key', path: ['query'], message: 'This endpoint does not accept query parameters.' }]), 400);
    let args: unknown = {};
    if (request.method !== 'GET') {
      const body = await readJson(request);
      if (!body.ok) throw new CommandError(invalidInput(body.error), 400);
      args = body.value;
    }
    const result = await callCommandTool(route[2]!, args, db);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    if (error instanceof CommandError) return new Response(JSON.stringify({ contractVersion: 2, error: error.detail }), { status: error.status, headers: { 'Content-Type': 'application/json' } });
    throw error;
  }
}
