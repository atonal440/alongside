import type { DB } from './db';
import type { Duty } from '@shared/types';

// Wall-clock parts in a given IANA timezone.
interface TzParts { y: number; mo: number; d: number; h: number; mi: number; s: number; }

function toTzParts(iso: string, tz: string): TzParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(iso)).map(p => [p.type, p.value]));
  return {
    y:  Number(parts.year),
    mo: Number(parts.month),
    d:  Number(parts.day),
    // Intl emits "24" for midnight in some locales; normalize to 0.
    h:  parts.hour === '24' ? 0 : Number(parts.hour),
    mi: Number(parts.minute),
    s:  Number(parts.second),
  };
}

// Treat (y, mo, d, h, mi, s) as wall-clock in `tz`; return UTC ISO timestamp.
// Two-pass DST adjustment: guess the offset at one point in time, apply it, then
// re-check in case the guess landed across a DST boundary.
function fromTzParts(p: TzParts, tz: string): string {
  const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  const adjust = (utc: number): number => {
    const seen = toTzParts(new Date(utc).toISOString(), tz);
    const seenWall = Date.UTC(seen.y, seen.mo - 1, seen.d, seen.h, seen.mi, seen.s);
    return wall - seenWall;
  };
  const utc1 = wall + adjust(wall);
  const utc2 = utc1 + adjust(utc1);
  return new Date(utc2).toISOString();
}

interface RRuleParts { freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'; interval: number; }

function parseRRule(rrule: string): RRuleParts | null {
  const map: Record<string, string> = {};
  for (const part of rrule.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) map[k] = v;
  }
  const freq = map.FREQ;
  const interval = map.INTERVAL === undefined ? 1 : Number(map.INTERVAL);
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
  if (!Number.isInteger(interval) || interval < 1) return null;
  return { freq, interval };
}

// Add `n` periods of `freq` to a wall-clock instant in `tz` and return the new
// UTC ISO timestamp. Adding in tz parts (not UTC) prevents DST drift on the
// anchor time of day.
export function computeNextFire(rrule: string, fromIso: string, tz: string): string | null {
  const r = parseRRule(rrule);
  if (!r) return null;
  const p = toTzParts(fromIso, tz);
  switch (r.freq) {
    case 'DAILY':   p.d  += r.interval; break;
    case 'WEEKLY':  p.d  += 7 * r.interval; break;
    case 'MONTHLY': p.mo += r.interval; break;
    case 'YEARLY':  p.y  += r.interval; break;
  }
  return fromTzParts(p, tz);
}

// Convert a UTC instant + offset (in days, in tz) to a YYYY-MM-DD wall-clock date.
export function deriveDueDate(fireAtIso: string, offsetDays: number, tz: string): string {
  const p = toTzParts(fireAtIso, tz);
  p.d += offsetDays;
  // Round-trip to normalize day overflow (e.g. day 32 → next month).
  const normalized = toTzParts(fromTzParts({ ...p, h: 0, mi: 0, s: 0 }, tz), tz);
  const mo = String(normalized.mo).padStart(2, '0');
  const d  = String(normalized.d).padStart(2, '0');
  return `${normalized.y}-${mo}-${d}`;
}

// Convert a YYYY-MM-DD date to a UTC ISO timestamp at midnight in `tz`.
export function dateAtMidnightInTz(yyyymmdd: string, tz: string): string {
  const [yStr, moStr, dStr] = yyyymmdd.split('-');
  return fromTzParts(
    { y: Number(yStr), mo: Number(moStr), d: Number(dStr), h: 0, mi: 0, s: 0 },
    tz,
  );
}

// Today's wall-clock date in `tz` as a YYYY-MM-DD string.
export function todayInTz(tz: string): string {
  const p = toTzParts(new Date().toISOString(), tz);
  const mo = String(p.mo).padStart(2, '0');
  const d  = String(p.d).padStart(2, '0');
  return `${p.y}-${mo}-${d}`;
}

const DEFAULT_TZ = 'UTC';

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function isDutyFireUniqueViolation(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('UNIQUE constraint failed')
    && error.message.includes('tasks.duty_id')
    && error.message.includes('tasks.duty_fire_at');
}

export async function getUserTimezone(db: DB): Promise<string> {
  const tz = await db.getPreference('timezone');
  return tz && isValidTimezone(tz) ? tz : DEFAULT_TZ;
}

async function migrateLegacyRecurringTasks(db: DB, tz: string, nowIso: string): Promise<void> {
  const tasks = await db.listLegacyRecurringTasks();
  for (const task of tasks) {
    const fireDate = task.due_date ?? todayInTz(tz);
    await db.convertLegacyRecurringTaskToDuty(task, dateAtMidnightInTz(fireDate, tz), nowIso);
  }
}

// Materialize every duty whose next_fire_at is at or before `nowIso` into a real
// task and advance its schedule. Idempotent: skips creation when a task already
// exists for the same (duty_id, duty_fire_at) pair, so concurrent reads can call
// this without producing duplicates.
export async function materializeDueDuties(db: DB, nowIso: string): Promise<{ materialized: number }> {
  const tz = await getUserTimezone(db);
  await migrateLegacyRecurringTasks(db, tz, nowIso);

  const dueDuties = await db.listDueDuties(nowIso);
  if (dueDuties.length === 0) return { materialized: 0 };

  let count = 0;

  for (const duty of dueDuties) {
    const fireAt = duty.next_fire_at;

    // Idempotency: only create the task if no instance for this fire exists.
    // A unique index backs this up when concurrent request paths race here.
    const already = await db.findTaskByDutyFire(duty.id, fireAt);
    if (!already) {
      const dueDate = deriveDueDate(fireAt, duty.due_offset_days, tz);
      try {
        const task = await db.addTaskFromDuty({
          title:        duty.title,
          notes:        duty.notes ?? undefined,
          kickoff_note: duty.kickoff_note ?? undefined,
          task_type:    duty.task_type,
          project_id:   duty.project_id ?? undefined,
          due_date:     dueDate,
          recurrence:   undefined,
          duty_id:      duty.id,
          duty_fire_at: fireAt,
        });
        await db.logAction({
          tool_name: 'duty_fired',
          task_id:   task.id,
          title:     task.title,
          detail:    duty.id,
        });
        count += 1;
      } catch (error) {
        if (!isDutyFireUniqueViolation(error)) throw error;
      }
    }

    const next = computeNextFire(duty.recurrence, fireAt, tz);
    if (next) {
      await db.markDutyFired(duty.id, fireAt, next, nowIso);
    } else {
      // Unparseable RRULE — pause the duty so we don't loop. Edit and re-activate.
      await db.setDutyActive(duty.id, false, nowIso);
    }
  }

  return { materialized: count };
}
