import { err, ok, type Result } from '@shared/result';
import { parseDueDateTime, parseEventInstant, parseLocalDate, parseMinuteInstant, parseTimezone, type Timezone, type ValidationError } from '@shared/parse';
import { resolveDateBoundary, resolveOffset, resolveWallTime, type TemporalPoint, type TimeError } from '@shared/temporal';
import { parseSchema } from '@shared/parse';
import { CLIENT_PROTOCOL, MIN_SYNC_READ_PROTOCOL, MIN_WRITE_PROTOCOL } from '@shared/wire/clientVersion';
import { COMMAND_CATALOG_VERSION, TOOL_SURFACE_VERSION, CapabilitiesSchema, type Capabilities, type PlanningSettings, type ResolveTimeInput, type TimeResolution, type TimezoneSource } from '@shared/wire/planning';

export interface FoundationError {
  code: string; path: string[]; message: string; retryable: false; recoveryHint: string;
  details?: ValidationError[];
  alternatives?: TimeError['alternatives'];
}
export function invalidInput(errors: ValidationError[]): FoundationError {
  return { code: 'invalid_input', path: errors[0]?.path ?? [], message: errors.map(error => error.message).join('; '), retryable: false, recoveryHint: 'Correct the reported input fields.', details: errors };
}
export function interpretedZone(request: Timezone | undefined, settings: PlanningSettings | null): { timezone: Timezone; timezoneSource: TimezoneSource } {
  if (request !== undefined) return { timezone: request, timezoneSource: 'request' };
  if (settings) return { timezone: settings.timezone, timezoneSource: 'workspace' };
  const utc = parseTimezone('UTC');
  if (!utc.ok) throw new Error('UTC must be supported.');
  return { timezone: utc.value, timezoneSource: 'fallback_utc' };
}
export function getCapabilities(requestZone: Timezone | undefined, settings: PlanningSettings | null, now: string): Capabilities {
  const parsed = parseSchema(CapabilitiesSchema, {
    contractVersion: 2, serverNow: now, ...interpretedZone(requestZone, settings), setupRequired: settings === null,
    features: { temporalResolution: true, legacyDatePreview: true, reliableCommands: true, hierarchy: true, taskDates: true, timeblocks: false, reminders: false, seriesMaterialization: true, deltaSync: true },
    clientProtocol: { current: CLIENT_PROTOCOL, minimumWrite: MIN_WRITE_PROTOCOL, minimumSyncRead: MIN_SYNC_READ_PROTOCOL },
    limits: { atomicStatements: 100, maxHierarchyDepth: 32, maxPreviewRows: 500, maxDurationMinutes: 525_600 },
    delivery: { inbox: 'unavailable', webPush: 'unconfigured', backgroundEnabled: false },
    recurrencePolicy: { gap: 'skip', fold: 'earlier' },
    toolSurface: { version: TOOL_SURFACE_VERSION, commandCatalog: COMMAND_CATALOG_VERSION, adminEndpoint: '/mcp/admin' },
  });
  if (!parsed.ok) throw new Error('Invalid server capability configuration.');
  return parsed.value;
}
export function resolveTime(input: ResolveTimeInput, settings: PlanningSettings | null, now: string): Result<TimeResolution, FoundationError> {
  const zone = interpretedZone(input.kind === 'offset' ? input.point.timezone : input.timezone, settings);
  const event = parseEventInstant(now);
  if (!event.ok) throw new Error('Invalid server clock.');
  let resolution;
  switch (input.kind) {
    case 'wall_time': {
      const result = resolveWallTime(input.date, input.time, zone.timezone, input.disambiguation);
      resolution = result.ok ? ok({ at: result.value, comparison: 'inclusive' as const }) : result;
      break;
    }
    case 'date_boundary':
      resolution = resolveDateBoundary({ kind: 'date', date: input.date, timezone: zone.timezone }, input.role);
      break;
    case 'offset': {
      const result = resolveOffset(input.point, input.offset, input.dateAnchorTime, input.disambiguation);
      resolution = result.ok ? ok({ at: result.value, comparison: 'inclusive' as const }) : result;
      break;
    }
  }
  return resolution.ok ? ok({ contractVersion: 2, serverNow: event.value, ...zone, ...resolution.value }) : resolution;
}
export interface LegacyDueRow { id: string; due_date: string | null; due_all_day: boolean | null }
export function classifyLegacyDue(row: LegacyDueRow, timezone: Timezone): Result<{
  taskId: string; role: 'target'; point: TemporalPoint; provenance: 'legacy_all_day' | 'legacy_timed' | 'legacy_ambiguous';
  original: { due_date: string; due_all_day: boolean | null };
}, FoundationError> {
  if (row.due_date === null) return err({ code: 'missing_date', path: ['due_date'], message: 'No legacy due date.', retryable: false, recoveryHint: 'Leave the task undated.' });
  const legacy = parseDueDateTime(row.due_date);
  if (!legacy.ok) return err(invalidInput(legacy.error));
  const original = { due_date: row.due_date, due_all_day: row.due_all_day };
  if (row.due_all_day === false) {
    const at = parseMinuteInstant(legacy.value);
    if (!at.ok) return err(invalidInput(at.error));
    return ok({ taskId: row.id, role: 'target', point: { kind: 'instant', at: at.value, timezone }, provenance: 'legacy_timed', original });
  }
  const date = parseLocalDate(legacy.value.slice(0, 10));
  if (!date.ok) return err(invalidInput(date.error));
  return ok({ taskId: row.id, role: 'target', point: { kind: 'date', date: date.value, timezone }, provenance: row.due_all_day === null ? 'legacy_ambiguous' : 'legacy_all_day', original });
}
