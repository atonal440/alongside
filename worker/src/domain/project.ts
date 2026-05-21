import type {
  BoundedString,
  IsoDateTime,
  NonEmptyString,
  ProjectId,
  ProjectStatus,
  ValidationError,
} from '../parse';
import {
  parseBounded,
  parseIsoDateTime,
  parseNonEmpty,
  parseProjectId,
  parseProjectStatus,
} from '../parse';
import type { Result } from '@shared/result';
import { err, ok } from '@shared/result';
import type { Project } from '@shared/types';

export interface ProjectDomain {
  id: ProjectId;
  title: NonEmptyString<200>;
  notes: BoundedString<10_000> | null;
  kickoffNote: BoundedString<2_000> | null;
  status: ProjectStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

function withPath(path: string, errors: ValidationError[]): ValidationError[] {
  return errors.map(error => ({
    ...error,
    path: [path, ...error.path],
  }));
}

function nullableBounded<const Max extends number>(
  path: string,
  max: Max,
  input: string | null,
): Result<BoundedString<Max> | null, ValidationError[]> {
  if (input === null) return ok(null);
  const parsed = parseBounded(max, input);
  return parsed.ok ? ok(parsed.value) : err(withPath(path, parsed.error));
}

export function projectFromRow(row: Project): Result<ProjectDomain, ValidationError[]> {
  const errors: ValidationError[] = [];

  const id = parseProjectId(row.id);
  if (!id.ok) errors.push(...withPath('id', id.error));

  const title = parseNonEmpty(200, row.title);
  if (!title.ok) errors.push(...withPath('title', title.error));

  const notes = nullableBounded('notes', 10_000, row.notes);
  if (!notes.ok) errors.push(...notes.error);

  const kickoffNote = nullableBounded('kickoff_note', 2_000, row.kickoff_note);
  if (!kickoffNote.ok) errors.push(...kickoffNote.error);

  const status = parseProjectStatus(row.status);
  if (!status.ok) errors.push(...withPath('status', status.error));

  const createdAt = parseIsoDateTime(row.created_at);
  if (!createdAt.ok) errors.push(...withPath('created_at', createdAt.error));

  const updatedAt = parseIsoDateTime(row.updated_at);
  if (!updatedAt.ok) errors.push(...withPath('updated_at', updatedAt.error));

  if (
    !id.ok ||
    !title.ok ||
    !notes.ok ||
    !kickoffNote.ok ||
    !status.ok ||
    !createdAt.ok ||
    !updatedAt.ok ||
    errors.length > 0
  ) {
    return err(errors);
  }

  return ok({
    id: id.value,
    title: title.value,
    notes: notes.value,
    kickoffNote: kickoffNote.value,
    status: status.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}
