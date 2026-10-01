import { parseSchema, type ValidationError } from '@shared/parse';
import { CapabilitiesInputSchema, LegacyDatesPreviewInputSchema, ResolveTimeInputSchema } from '@shared/wire/planning';
import { classifyLegacyDue, getCapabilities, interpretedZone, invalidInput, resolveTime, type FoundationError } from './domain/temporalFoundation';
import type { DB } from './db';
import { readJson } from './parse/request';

const timezone = { type: 'string', description: 'Canonical IANA timezone or UTC. If omitted, workspace setting or explicitly reported UTC fallback.' };
const disambiguation = { type: 'string', enum: ['earlier', 'later', 'reject'], description: 'One-off fold selection. Default reject; gaps always return alternatives.' };
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const time = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' };
const at = { type: 'string', description: 'ISO instant including offset or Z; normalized to minute UTC.' };
const point = { oneOf: [
  { type: 'object', properties: { kind: { const: 'date' }, date, timezone }, required: ['kind', 'date', 'timezone'], additionalProperties: false },
  { type: 'object', properties: { kind: { const: 'instant' }, at, timezone }, required: ['kind', 'at', 'timezone'], additionalProperties: false },
] };
export const FOUNDATION_TOOLS = [
  { name: 'get_capabilities', description: 'Discover implemented contracts, limits, server time, interpreted zone and delivery readiness. No writes.', inputSchema: { type: 'object', properties: { timezone }, additionalProperties: false } },
  { name: 'resolve_time', description: 'Resolve structured wall time, date boundary, or elapsed/calendar offset. No writes. Folds require explicit choice; gaps return alternatives.', inputSchema: {
    type: 'object', oneOf: [
      { properties: { kind: { const: 'wall_time' }, date, time, timezone, disambiguation }, required: ['kind', 'date', 'time'], additionalProperties: false },
      { properties: { kind: { const: 'date_boundary' }, date, role: { enum: ['available_from', 'target', 'deadline'] }, timezone }, required: ['kind', 'date', 'role'], additionalProperties: false },
      { properties: { kind: { const: 'offset' }, point, offset: { oneOf: [
        { type: 'object', properties: { kind: { const: 'elapsed_minutes' }, minutes: { type: 'integer', minimum: -525600, maximum: 525600 } }, required: ['kind', 'minutes'], additionalProperties: false },
        { type: 'object', properties: { kind: { const: 'calendar_days' }, days: { type: 'integer', minimum: -3660, maximum: 3660 }, localTime: time }, required: ['kind', 'days', 'localTime'], additionalProperties: false },
      ] }, dateAnchorTime: time, disambiguation }, required: ['kind', 'point', 'offset'], additionalProperties: false },
    ],
  } },
  { name: 'preview_legacy_dates', description: 'Read-only paginated classification of legacy due values as targets. Preserves originals and reports ambiguous/unresolved rows; never infers hard deadlines.', inputSchema: { type: 'object', properties: { timezone, after: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false } },
];
export class FoundationInputError extends Error {
  constructor(public readonly detail: FoundationError) { super(detail.message); }
}
function checked<T>(parsed: { ok: true; value: T } | { ok: false; error: ValidationError[] }): T {
  if (!parsed.ok) throw new FoundationInputError(invalidInput(parsed.error));
  return parsed.value;
}
export async function callFoundationTool(name: string, args: unknown, db: DB, now = new Date().toISOString()): Promise<unknown> {
  switch (name) {
    case 'get_capabilities': {
      const input = checked(parseSchema(CapabilitiesInputSchema, args));
      return getCapabilities(input.timezone, await db.getPlanningSettings(), now);
    }
    case 'resolve_time': {
      const input = checked(parseSchema(ResolveTimeInputSchema, args));
      const result = resolveTime(input, await db.getPlanningSettings(), now);
      if (!result.ok) throw new FoundationInputError(result.error);
      return result.value;
    }
    case 'preview_legacy_dates': {
      const input = checked(parseSchema(LegacyDatesPreviewInputSchema, args));
      const zone = interpretedZone(input.timezone, await db.getPlanningSettings());
      const limit = input.limit ?? 100;
      const rows = await db.listLegacyDueDates(input.after, limit + 1);
      const page = rows.slice(0, limit);
      const classifications = page.map(row => ({ row, result: classifyLegacyDue(row, zone.timezone) }));
      return { contractVersion: 2, serverNow: now, ...zone, dryRun: true,
        candidates: classifications.flatMap(item => item.result.ok ? [item.result.value] : []),
        unresolved: classifications.flatMap(item => item.result.ok ? [] : [{ taskId: item.row.id, original: item.row, error: item.result.error }]),
        nextCursor: rows.length > limit ? page[page.length - 1]?.id ?? null : null,
        consistentSnapshot: false,
      };
    }
    default: throw new Error(`Unknown foundation tool: ${name}`);
  }
}
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
export async function handleFoundationRequest(request: Request, url: URL, db: DB): Promise<Response | null> {
  const route = [
    ['GET', '/api/v2/capabilities', 'get_capabilities'],
    ['POST', '/api/v2/resolve-time', 'resolve_time'],
    ['POST', '/api/v2/legacy-dates/preview', 'preview_legacy_dates'],
  ].find(([method, path]) => method === request.method && path === url.pathname);
  if (!route) return null;
  try {
    let args: unknown;
    if (request.method === 'GET') {
      const values: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (key in values) throw new FoundationInputError(invalidInput([{ code: 'duplicate_key', path: [key], message: 'Duplicate query parameter.' }]));
        values[key] = value;
      }
      args = values;
    } else {
      if (url.search) throw new FoundationInputError(invalidInput([{ code: 'unknown_key', path: ['query'], message: 'This endpoint does not accept query parameters.' }]));
      const parsed = await readJson(request);
      args = checked(parsed);
    }
    return json(await callFoundationTool(route[2]!, args, db));
  } catch (error) {
    if (error instanceof FoundationInputError) return json({ contractVersion: 2, error: error.detail }, 400);
    throw error;
  }
}
