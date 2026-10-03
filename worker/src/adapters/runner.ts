/**
 * Shared machinery for tools that are thin adapters over the command planner (phase C of
 * docs/plans/mcp-surface.md): receipt-first replay, request hashing, derived IDs, the bounded
 * re-read/recompile loop for unpinned writes, and the atomic commit with receipt and log row.
 */
import { nanoid } from 'nanoid';
import { parseSchema } from '@shared/parse';
import { CommandEnvelopeSchema, type ChangesResult } from '@shared/wire/commands';
import type { ReceiptTool } from '@shared/wire/receipts';
import { CommandError, toolRequestHash } from '../domain/commands';
import { invalidInput } from '../domain/temporalFoundation';
import type { PreCheck } from '../domain/Op';
import type { LinkSnapshot } from '@shared/wire/versions';
import type { DB, ToolLogDraft } from '../db';

export type Json = Record<string, unknown>;

/** What a verb compiles a call into. */
export type Draft =
  | { kind: 'commands'; commands: Json[]; respond: (result: ChangesResult) => { response: unknown; log: ToolLogDraft | null } }
  | { kind: 'noop'; guards: PreCheck[]; response: unknown; log: ToolLogDraft | null };

export interface Ctx {
  db: DB;
  tool: ReceiptTool;
  commandId: string;
  /** Workspace structural revision all reads of this attempt are checked against. */
  structural: number;
  /** The caller pinned the first command's revision; a stale pin is refused, never retried. */
  expectedRevision: number | undefined;
  /** Read an entity snapshot, failing the attempt if the workspace moved since `structural` was read. */
  read(entity: 'task' | 'project', id: string): ReturnType<DB['getEntitySnapshot']>;
  /** Read an exact link orientation, with the same staleness check. */
  readLink(from: string, to: string, linkType: 'blocks' | 'related'): Promise<LinkSnapshot>;
}
export type Compiler = (ctx: Ctx, args: Json) => Promise<Draft>;

const MAX_ATTEMPTS = 3;
const COMMAND_ID = /^c_[0-9A-Za-z_-]{5,64}$/;

export const refuse = (message: string, path: string[] = []): CommandError =>
  new CommandError(invalidInput([{ code: 'invalid_input', path, message }]), 400);
export const notFound = (message: string): CommandError =>
  new CommandError({ code: 'not_found', path: [], message, retryable: false, recoveryHint: 'Check the ID with find or get_context.' }, 404);

/** Stable ID for the nth entity a call mints, so identical racing requests plan identical identities. */
export async function derivedId(prefix: 't' | 'p', commandId: string, position: number): Promise<string> {
  const bytes = new TextEncoder().encode(`${commandId}:${position}`);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hash.slice(0, 12)}`;
}

class StaleRead extends Error {}
const retryable = (error: unknown): boolean =>
  error instanceof StaleRead || (error instanceof CommandError && (error.detail.code === 'revision_conflict' || error.detail.code === 'structural_conflict'));

export async function runTool(tool: ReceiptTool, rawArgs: unknown, db: DB, compile: Compiler): Promise<unknown> {
  if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) throw refuse('Expected an input object.');
  const { commandId: suppliedId, expectedRevision, ...args } = rawArgs as Json;
  if (suppliedId !== undefined && (typeof suppliedId !== 'string' || !COMMAND_ID.test(suppliedId))) throw refuse('commandId must look like c_ followed by 5–64 letters, digits, _ or -.', ['commandId']);
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0)) throw refuse('expectedRevision must be a non-negative integer.', ['expectedRevision']);
  // The request is what the caller asked for, not what it compiles to: tool, arguments, and the pin.
  const requestHash = await toolRequestHash(tool, { ...args, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
  const commandId = (suppliedId as string | undefined) ?? `c_${nanoid(16)}`;
  const lookup = async () => suppliedId === undefined ? null : db.findToolReceipt(commandId as never, tool, requestHash);

  const replay = await lookup();
  if (replay) return replay.response;

  const attempts = expectedRevision === undefined ? MAX_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      const probe = await db.getEntitySnapshot({ entity: 'task', id: 't_probe00' } as never);
      const structural = probe.structuralRevision;
      const ctx: Ctx = {
        db, tool, commandId, structural, expectedRevision: expectedRevision as number | undefined,
        async read(entity, id) {
          const snapshot = await db.getEntitySnapshot({ entity, id } as never);
          if (snapshot.structuralRevision !== structural) throw new StaleRead();
          return snapshot;
        },
        async readLink(from, to, linkType) {
          const snapshot = await db.getLinkSnapshot({ entity: 'link', from, to, linkType } as never);
          if (snapshot.structuralRevision !== structural) throw new StaleRead();
          return snapshot;
        },
      };
      const draft = await compile(ctx, args);
      if (draft.kind === 'noop') {
        return await db.commitToolNoop({ commandId: commandId as never, tool, requestHash, guards: draft.guards, response: draft.response, log: draft.log });
      }
      const parsed = parseSchema(CommandEnvelopeSchema, { contractVersion: 2, commandId, actor: 'llm',
        ...(draft.commands.length > 1 ? { expectedStructuralRevision: structural } : {}), commands: draft.commands });
      if (!parsed.ok) throw new CommandError(invalidInput(parsed.error), 400);
      return await db.commitToolEnvelope(parsed.value, { tool, requestHash, respond: draft.respond });
    } catch (error) {
      if (!retryable(error) || attempt >= attempts) throw error instanceof StaleRead
        ? new CommandError({ code: 'structural_conflict', path: [], message: 'The workspace kept changing while the call was being compiled.', retryable: true, recoveryHint: 'Repeat the call.' }, 409)
        : error;
      // Another request with this ID may have committed in the meantime; replay it instead of retrying.
      const raced = await lookup();
      if (raced) return raced.response;
    }
  }
}

/** The after-image of a project in a command result. */
export function projectRowOf(result: ChangesResult, id: string) {
  const change = result.changes.find(candidate => candidate.entity === 'project' && candidate.id === id);
  if (!change || change.entity !== 'project' || !('row' in change.after)) throw new Error(`Result holds no row for project ${id}.`);
  return change.after.row;
}

/** The after-image of a task in a command result. */
export function taskRowOf(result: ChangesResult, id: string) {
  const change = result.changes.find(candidate => candidate.entity === 'task' && candidate.id === id);
  if (!change || change.entity !== 'task' || !('row' in change.after)) throw new Error(`Result holds no row for task ${id}.`);
  return change.after.row;
}
