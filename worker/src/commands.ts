import { parseSchema } from '@shared/parse';
import { CommandEnvelopeSchema, PlanningSettingsExportSchema } from '@shared/wire/commands';
import { parseEntityKey, parseEntityReadKey, parseLinkKey } from '@shared/wire/versions';
import { CommandError } from './domain/commands';
import { invalidInput } from './domain/temporalFoundation';
import { readJson } from './parse/request';
import type { DB } from './db';

const envelope = {
  type: 'object', additionalProperties: false,
  properties: {
    contractVersion: { const: 2 }, commandId: { type: 'string', pattern: '^c_[0-9A-Za-z_-]{5,64}$' },
    actor: { enum: ['user', 'llm', 'import'] }, reason: { type: 'string', maxLength: 1000 },
    expectedStructuralRevision: { type: 'integer', minimum: 0, maximum: 9007199254740991, description: 'Required for mixed batches of 2–20 distinct-identity commands. Graph commands share this base revision. Forbidden for standalone commands. Settings remain standalone. Lifecycle commands include their successor/cascade/detachment effects and may not overlap other written identities.' },
    commands: { type: 'array', minItems: 1, maxItems: 20, items: {
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
const nullableText = (maxLength: number) => ({ type: ['string', 'null'], maxLength });
const creationProperties = { title: { type: 'string', minLength: 1, maxLength: 200 }, notes: nullableText(10000), kickoffNote: nullableText(2000) };
const creationCommandSchema = (entity: 'task' | 'project') => ({
  type: 'object', additionalProperties: false, properties: {
    kind: { const: `${entity}.create` }, id: { type: 'string', pattern: entity === 'task' ? '^t_[0-9A-Za-z_-]{5,}$' : '^p_[0-9A-Za-z_-]{5,}$' },
    clientRef: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' },
    expectedRevision: { type: 'null' }, expectedStructuralRevision: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    values: { type: 'object', additionalProperties: false,
      properties: entity === 'project' ? creationProperties : { ...creationProperties,
        taskType: { enum: ['action', 'plan'] },
        project: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', pattern: '^p_[0-9A-Za-z_-]{5,}$' }, expectedRevision: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
        }, required: ['id', 'expectedRevision'] }] },
      }, required: entity === 'project' ? ['title', 'notes', 'kickoffNote'] : ['title', 'notes', 'kickoffNote', 'taskType', 'project'],
    },
  }, required: ['kind', 'id', 'expectedRevision', 'expectedStructuralRevision', 'values'],
});
const contentCommandSchema = (entity: 'task' | 'project') => ({
  type: 'object', additionalProperties: false, properties: {
    kind: { const: `${entity}.content.set` }, id: { type: 'string', pattern: entity === 'task' ? '^t_[0-9A-Za-z_-]{5,}$' : '^p_[0-9A-Za-z_-]{5,}$' },
    expectedRevision: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    values: { type: 'object', additionalProperties: false,
      properties: entity === 'project' ? creationProperties : { ...creationProperties, sessionLog: nullableText(10000) },
      required: entity === 'project' ? ['title', 'notes', 'kickoffNote'] : ['title', 'notes', 'kickoffNote', 'sessionLog'],
    },
  }, required: ['kind', 'id', 'expectedRevision', 'values'],
});
const stateCommandSchema = (kind: string, field?: string, schema?: object) => ({
  type: 'object', additionalProperties: false, properties: {
    kind: { const: kind }, id: { type: 'string', pattern: kind.startsWith('task.') ? '^t_[0-9A-Za-z_-]{5,}$' : '^p_[0-9A-Za-z_-]{5,}$' },
    expectedRevision: { type: 'integer', minimum: 0, maximum: 9007199254740991 }, ...(field ? { [field]: schema } : {}),
  }, required: ['kind', 'id', 'expectedRevision', ...(field ? [field] : [])],
});
const stateSchemas = [
  stateCommandSchema('task.focus.set', 'focusedUntil', { type: ['string', 'null'], format: 'date-time', description: 'Explicit instant with offset; normalized to minute UTC in years 0100–9999. Non-null focus clears deferral. Null only clears focus.' }),
  stateCommandSchema('task.defer.set', 'defer', { oneOf: [
    ...['none', 'someday'].map(kind => ({ type: 'object', additionalProperties: false, properties: { kind: { const: kind } }, required: ['kind'] })),
    { type: 'object', additionalProperties: false, properties: { kind: { const: 'until' }, until: { type: 'string', format: 'date-time', description: 'Explicit instant; normalized UTC year must be 0100–9999.' } }, required: ['kind', 'until'] },
  ] }),
  stateCommandSchema('task.reopen'), stateCommandSchema('project.archive'), stateCommandSchema('project.reopen'),
];
const completionSchema = {
  type: 'object', additionalProperties: false, properties: {
    kind: { const: 'task.complete' }, id: { type: 'string', pattern: '^t_[0-9A-Za-z_-]{5,}$' },
    expectedRevision: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    expectedStructuralRevision: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    successor: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', pattern: '^t_[0-9A-Za-z_-]{5,}$' }, clientRef: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' },
    }, required: ['id'] }] },
  }, required: ['kind', 'id', 'expectedRevision', 'expectedStructuralRevision', 'successor'],
};
const taskFieldSchemas = [
  { ...stateCommandSchema('task.project.set'), properties: { ...stateCommandSchema('task.project.set').properties,
    expectedStructuralRevision: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    project: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: { id: { type: 'string', pattern: '^p_[0-9A-Za-z_-]{5,}$' }, expectedRevision: { type: 'integer', minimum: 0, maximum: 9007199254740991 } }, required: ['id', 'expectedRevision'] }] },
  }, required: ['kind', 'id', 'expectedRevision', 'expectedStructuralRevision', 'project'] },
  stateCommandSchema('task.type.set', 'taskType', { enum: ['action', 'plan'] }),
  stateCommandSchema('task.legacy-schedule.set', 'values', { type: 'object', additionalProperties: false, properties: {
    dueDate: { type: ['string', 'null'], description: 'Legacy calendar date or offset instant, normalized to minute UTC in years 0100–9999; not a hard deadline.' },
    dueAllDay: { type: ['boolean', 'null'], description: 'Explicit classification. Null preserves legacy ambiguity; clearing dueDate requires null.' },
    recurrence: { type: ['string', 'null'], description: 'Legacy date-only RRULE; requires all-day/ambiguous dueDate. Clearing dueDate requires null.' },
  }, required: ['dueDate', 'dueAllDay', 'recurrence'] }),
];
const linkSchemas = ['link.add', 'link.remove'].map(kind => ({
  type: 'object', additionalProperties: false, properties: {
    kind: { const: kind }, from: { type: 'string', pattern: '^t_[0-9A-Za-z_-]{5,}$' }, to: { type: 'string', pattern: '^t_[0-9A-Za-z_-]{5,}$' },
    linkType: { enum: ['blocks', 'related'], description: 'Related additions require ascending endpoints; removal uses the exact stored orientation.' },
    expectedRevision: { type: kind === 'link.add' ? ['integer', 'null'] : 'integer', minimum: 0, maximum: 9007199254740991 },
    expectedStructuralRevision: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
  }, required: ['kind', 'from', 'to', 'linkType', 'expectedRevision', 'expectedStructuralRevision'],
}));
const deleteSchemas = ['task','project'].map(entity => ({type:'object',additionalProperties:false,properties:{kind:{const:`${entity}.delete`},id:{type:'string',pattern:entity === 'task' ? '^t_[0-9A-Za-z_-]{5,}$' : '^p_[0-9A-Za-z_-]{5,}$'},expectedRevision:{type:'integer',minimum:0,maximum:9007199254740991},expectedStructuralRevision:{type:'integer',minimum:0,maximum:9007199254740991}},required:['kind','id','expectedRevision','expectedStructuralRevision']}));
const commandEnvelope = { ...envelope, properties: { ...envelope.properties,
  commands: { ...envelope.properties.commands, items: { oneOf: [envelope.properties.commands.items, creationCommandSchema('task'), creationCommandSchema('project'), contentCommandSchema('task'), contentCommandSchema('project'), ...stateSchemas, completionSchema, ...taskFieldSchemas, ...linkSchemas, ...deleteSchemas] } },
} };
export const COMMAND_TOOLS = [
  { name: 'get_link', description: 'Read an exact link orientation, its live/deleted revision and the structural revision together. Related additions require ascending IDs; legacy reversed links remain inspectable/removable. Use for reliable link planning.', inputSchema: {
    type: 'object', additionalProperties: false, properties: { entity: { const: 'link' }, from: { type: 'string' }, to: { type: 'string' }, linkType: { enum: ['blocks', 'related'] } }, required: ['entity', 'from', 'to', 'linkType'],
  } },
  { name: 'get_entity', description: 'Read a task/project row and its entity/structural versions together. Missing identities return null row/version; tombstones have null row and retained deleted version. Use for reliable command planning.', inputSchema: {
    type: 'object', oneOf: ['task', 'project'].map(entity => ({ type: 'object', additionalProperties: false, properties: { entity: { const: entity }, id: { type: 'string' } }, required: ['entity', 'id'] })),
  } },
  { name: 'get_entity_version', description: 'Read a task/project/duty/link revision and workspace structural revision in one snapshot. version=null means never recorded; deletedAt marks a retained tombstone. This is a version lookup, not a full data snapshot or delta sync.', inputSchema: {
    type: 'object', oneOf: [
      ...['task', 'project', 'duty'].map(entity => ({ type: 'object', additionalProperties: false, properties: { entity: { const: entity }, id: { type: 'string' } }, required: ['entity', 'id'] })),
      { type: 'object', additionalProperties: false, properties: { entity: { const: 'link' }, from: { type: 'string' }, to: { type: 'string' }, linkType: { enum: ['blocks', 'related'] } }, required: ['entity', 'from', 'to', 'linkType'] },
    ],
  } },
  { name: 'get_planning_settings', description: 'Read complete workspace planning settings and their revision, or null before setup.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'export_planning_settings', description: 'Export only planning preferences, without revision or credentials. Restore non-null values through planning.set with a fresh command ID and current expectedRevision. This is not a full-workspace backup.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'preview_changes', description: 'Preview a reliable command without writes. One supported standalone command, or a bounded mixed batch of task/project/link commands including lifecycle effects with an envelope structural revision and distinct written identities; links require entity/structural revisions and existing endpoints, with atomic blocks-cycle validation; creation requires a stable ID, no prior identity history and the workspace structural revision. Use the current numeric revision for edits; initial settings and creation use null. A preview is not a lock.', inputSchema: commandEnvelope },
  { name: 'apply_changes', description: 'Atomically apply a supported standalone command or mixed batch of 2–20 task/project/link commands including lifecycle effects, with a caller-minted command ID and expected revision. Same ID/payload returns the original result; a different payload conflicts. Includes receipt, audit and command feed. Creation supports scoped clientRef/ID mapping. Content commands change only title/notes/kickoff and task session log; Focus/deferral follow existing pending-task transitions; reopening clears both. Project state preserves members/links. Completion uses structural guards and requires a stable successor ID for legacy recurrence, or successor:null otherwise. Membership uses structural and selected-project guards. Legacy schedule changes replace only existing due-date classification/recurrence, not future explicit date roles. Link add/remove are guarded; related additions use ascending IDs and prevent reversed duplicates, blocks additions reject cycles. Task deletion returns cascade link tombstones; project deletion detaches members and rejects duty ownership. Both require structural revisions and reject oversized atomic effects before writes. Mixed batches require an envelope structural revision, distinct written identities and unique scoped clientRefs. Create referenced entities earlier in the array. Final blocks graph validation allows atomic edge replacement; the complete generated SQL must fit 100 statements. Mixed results include changeGroups with one derived-image count per command. Lifecycle effects must be disjoint; settings stay standalone. Offline overlays follow later.', inputSchema: commandEnvelope },
];
export async function callCommandTool(name: string, args: unknown, db: DB): Promise<unknown> {
  if (name === 'get_link') {
    const key = parseLinkKey(args);
    if (!key.ok) throw new CommandError(invalidInput(key.error), 400);
    return db.getLinkSnapshot(key.value);
  }
  if (name === 'get_entity') {
    const key = parseEntityReadKey(args);
    if (!key.ok) throw new CommandError(invalidInput(key.error), 400);
    return db.getEntitySnapshot(key.value);
  }
  if (name === 'get_entity_version') {
    const key = parseEntityKey(args);
    if (!key.ok) throw new CommandError(invalidInput(key.error), 400);
    return db.getEntityVersion(key.value);
  }
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
    ['POST', '/api/v2/link', 'get_link'],
    ['POST', '/api/v2/entity', 'get_entity'],
    ['POST', '/api/v2/entity-version', 'get_entity_version'],
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
