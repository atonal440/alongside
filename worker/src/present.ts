import { parseTemporalPointText } from '@shared/temporal';

const DATE_ROLE_FIELDS = new Set(['available_from', 'deadline']);

/**
 * Tool results show a task's date roles as TemporalPoint objects instead of the canonical JSON
 * text the row stores, so a caller reads {kind:'date', date, timezone} rather than an escaped
 * string. Applies to conversational tool output only: portable exports and the sync feed keep the
 * stored spelling so they round-trip byte for byte.
 */
export function presentDateRoles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(presentDateRoles);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, field]) => {
    if (DATE_ROLE_FIELDS.has(key) && typeof field === 'string') {
      const point = parseTemporalPointText(field);
      return [key, point.ok ? point.value : field];
    }
    return [key, presentDateRoles(field)];
  }));
}
