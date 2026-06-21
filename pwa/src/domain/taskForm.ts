import { ok, err, type Result } from '@shared/result';
import {
  parseNonEmpty,
  parseBounded,
  parseIsoDate,
  parseRrule,
  type IsoDate,
  type IsoDateTime,
  type NonEmptyString,
  type BoundedString,
  type Rrule,
} from '@shared/parse';
import {
  TASK_TITLE_MAX,
  TASK_NOTES_MAX,
  TASK_KICKOFF_MAX,
  TASK_SESSION_LOG_MAX,
} from '@shared/wire/rows';
import type { TaskUpdatePatch } from './taskMutations';

export interface TaskFormInput {
  title: string;
  notes: string;
  kickoffNote: string;
  dueDate: string;
  recurrence: string;
  sessionLog: string;
  deferKind: 'none' | 'until' | 'someday';
  deferUntil: string;
  // Original ISO timestamp from task.defer_until — preserved when deferUntil
  // date is unchanged, so editing unrelated fields doesn't silently shift time.
  existingDeferUntil?: string;
}

export type FieldErrors = Partial<Record<keyof TaskFormInput, string>>;

// Parse a full edit-form submission into a typed update patch.
// Returns field-scoped errors (one per field) on validation failure.
// Three-layer contract: form parses for UX; domain re-guards; server re-validates.
export function parseTaskForm(input: TaskFormInput): Result<TaskUpdatePatch, FieldErrors> {
  const errors: FieldErrors = {};

  // title — trimmed, non-empty, ≤200
  let title: NonEmptyString<200> | undefined;
  const titleResult = parseNonEmpty(TASK_TITLE_MAX, input.title);
  if (titleResult.ok) {
    title = titleResult.value;
  } else {
    errors.title = titleResult.error[0]?.message ?? 'Title is required.';
  }

  // notes — optional, ≤10 000
  let notes: BoundedString<typeof TASK_NOTES_MAX> | null = null;
  if (input.notes !== '') {
    const r = parseBounded(TASK_NOTES_MAX, input.notes);
    if (r.ok) {
      notes = r.value;
    } else {
      errors.notes = r.error[0]?.message ?? 'Notes too long.';
    }
  }

  // kickoffNote — optional, ≤2 000
  let kickoffNote: BoundedString<typeof TASK_KICKOFF_MAX> | null = null;
  if (input.kickoffNote !== '') {
    const r = parseBounded(TASK_KICKOFF_MAX, input.kickoffNote);
    if (r.ok) {
      kickoffNote = r.value;
    } else {
      errors.kickoffNote = r.error[0]?.message ?? 'Kickoff note too long.';
    }
  }

  // sessionLog — optional, ≤10 000
  let sessionLog: BoundedString<typeof TASK_SESSION_LOG_MAX> | null = null;
  if (input.sessionLog !== '') {
    const r = parseBounded(TASK_SESSION_LOG_MAX, input.sessionLog);
    if (r.ok) {
      sessionLog = r.value;
    } else {
      errors.sessionLog = r.error[0]?.message ?? 'Session note too long.';
    }
  }

  // dueDate — empty → null, non-empty → IsoDate
  let dueDate: IsoDate | null = null;
  if (input.dueDate !== '') {
    const r = parseIsoDate(input.dueDate);
    if (r.ok) {
      dueDate = r.value;
    } else {
      errors.dueDate = r.error[0]?.message ?? 'Invalid date.';
    }
  }

  // recurrence — empty → null, non-empty → Rrule + cross-field check
  let recurrence: Rrule | null = null;
  if (input.recurrence !== '') {
    const r = parseRrule(input.recurrence);
    if (r.ok) {
      recurrence = r.value.rrule;
      if (!dueDate && !errors.dueDate) {
        errors.recurrence = 'Recurrence requires a due date.';
        recurrence = null;
      }
    } else {
      errors.recurrence = r.error[0]?.message ?? 'Invalid recurrence.';
    }
  }

  // deferUntil — required when deferKind === 'until', forbidden otherwise
  let deferUntil: IsoDateTime | null = null;
  if (input.deferKind === 'until') {
    if (!input.deferUntil) {
      errors.deferUntil = 'Please select a date.';
    } else {
      const dateResult = parseIsoDate(input.deferUntil);
      if (!dateResult.ok) {
        errors.deferUntil = 'Invalid date.';
      } else {
        // Preserve the original timestamp when date is unchanged so editing an
        // unrelated field doesn't silently shift e.g. 17:00 UTC to 09:00 local.
        const existingDate = input.existingDeferUntil?.split('T')[0];
        if (existingDate === dateResult.value && input.existingDeferUntil) {
          deferUntil = input.existingDeferUntil as IsoDateTime;
        } else {
          // New date (or no existing timestamp) → normalize to 9am local.
          deferUntil = new Date(`${dateResult.value}T09:00:00`).toISOString() as IsoDateTime;
        }
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return err(errors);
  }

  const patch: TaskUpdatePatch = {
    title: title!,
    notes,
    kickoff_note: kickoffNote,
    due_date: dueDate,
    recurrence,
    session_log: sessionLog,
    defer_kind: input.deferKind,
    defer_until: deferUntil,
    ...(input.deferKind === 'none' ? {} : { focused_until: null }),
  };

  return ok(patch);
}

// Parse a quick-add title (AddBar). Returns a human error string on failure.
export function parseQuickAddTitle(raw: string): Result<NonEmptyString<200>, string> {
  const r = parseNonEmpty(TASK_TITLE_MAX, raw);
  if (!r.ok) {
    return err(r.error[0]?.message ?? 'Title is required.');
  }
  return ok(r.value);
}
