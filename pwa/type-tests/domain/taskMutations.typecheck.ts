// Type-level fixtures for pwa/src/domain/taskMutations.ts.
// Convention mirrors worker/type-tests/domain/task.typecheck.ts:
// each @ts-expect-error line must produce exactly one TS error.
import type { IsoDateTime, NonEmptyString } from '@shared/parse';
import type { DeferInput } from '../../src/domain/taskMutations';
import { newLocalTask, applyDefer } from '../../src/domain/taskMutations';
import type { Task } from '@shared/types';

declare const nowIso: IsoDateTime;
declare const laterIso: IsoDateTime;
declare const task: Task;

// ── newLocalTask requires NonEmptyString<200>, not a plain string ──────────────

// @ts-expect-error raw string is not assignable to NonEmptyString<200>
newLocalTask('raw title', nowIso, 't_abc01');

// Branded value is accepted.
declare const validTitle: NonEmptyString<200>;
newLocalTask(validTitle, nowIso, 't_abc01'); // no error

// ── DeferInput disallows { kind: 'someday', until: ... } ──────────────────────

// @ts-expect-error 'someday' variant cannot carry an 'until' field
const _badDefer: DeferInput = { kind: 'someday', until: laterIso };

// Valid variants are accepted (void casts suppress unused-variable errors).
void ({ kind: 'someday' } satisfies DeferInput);
void ({ kind: 'until', until: laterIso } satisfies DeferInput);

// applyDefer rejects the bad input at the call site too.
// @ts-expect-error 'someday' variant cannot carry an 'until' field
applyDefer(task, { kind: 'someday', until: laterIso }, nowIso);
