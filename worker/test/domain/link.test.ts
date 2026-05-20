import { describe, expect, it } from 'vitest';
import { expectTypeOf } from 'vitest';
import type { Result } from '@shared/result';
import type { AppError } from '../../src/domain/errors';
import type { TaskLinkDomain } from '../../src/domain/link';
import {
  findBlocksCycle,
  taskLinkFromParts,
} from '../../src/domain/link';
import {
  linkTasksPlan,
  unlinkTasksPlan,
} from '../../src/domain/ops/link';

function expectOk<T, E>(result: Result<T, E>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected ok result.');
  return result.value;
}

function expectAppOk<T>(result: Result<T, AppError>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected ok result.');
  return result.value;
}

describe('task link domain parsing', () => {
  it('parses task-link inputs into branded domain values', () => {
    const link = expectOk(taskLinkFromParts('t_from1', 't_to222', 'blocks'));

    expect(link).toEqual({
      from: 't_from1',
      to: 't_to222',
      linkType: 'blocks',
    });
    expectTypeOf(link).toMatchTypeOf<TaskLinkDomain>();
  });

  it('reports field-specific validation errors', () => {
    const result = taskLinkFromParts('bad', 'also_bad', 'depends');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['from_task_id'] }),
        expect.objectContaining({ path: ['to_task_id'] }),
        expect.objectContaining({ path: ['link_type'] }),
      ]));
    }
  });
});

describe('link planners', () => {
  it('plans blocks links with endpoint and acyclic prechecks', () => {
    const link = expectOk(taskLinkFromParts('t_from1', 't_to222', 'blocks'));
    const plan = expectAppOk(linkTasksPlan(link));

    expect(plan).toEqual({
      assertions: [
        { kind: 'task.exists', id: 't_from1' },
        { kind: 'task.exists', id: 't_to222' },
        { kind: 'link.blocks_acyclic', from: 't_from1', to: 't_to222' },
      ],
      ops: [{
        kind: 'link.upsert',
        row: {
          from_task_id: 't_from1',
          to_task_id: 't_to222',
          link_type: 'blocks',
        },
      }],
    });
  });

  it('plans related links without graph prechecks', () => {
    const link = expectOk(taskLinkFromParts('t_from1', 't_to222', 'related'));
    const plan = expectAppOk(linkTasksPlan(link));

    expect(plan.assertions).toEqual([
      { kind: 'task.exists', id: 't_from1' },
      { kind: 'task.exists', id: 't_to222' },
    ]);
  });

  it('rejects self-links before storage planning', () => {
    const link = expectOk(taskLinkFromParts('t_same1', 't_same1', 'blocks'));
    const result = linkTasksPlan(link);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ kind: 'validation' });
    }
  });

  it('plans unlink as a typed delete without endpoint prechecks', () => {
    const link = expectOk(taskLinkFromParts('t_from1', 't_to222', 'blocks'));
    const plan = expectAppOk(unlinkTasksPlan(link));

    expect(plan).toEqual({
      assertions: [],
      ops: [{
        kind: 'link.delete',
        from: 't_from1',
        to: 't_to222',
        linkType: 'blocks',
      }],
    });
  });
});

describe('blocks graph helpers', () => {
  it('detects cycles among blocks links and ignores related links', () => {
    const cycle = findBlocksCycle([
      { from_task_id: 't_one11', to_task_id: 't_two22', link_type: 'blocks' },
      { from_task_id: 't_two22', to_task_id: 't_thr33', link_type: 'blocks' },
      { from_task_id: 't_thr33', to_task_id: 't_one11', link_type: 'blocks' },
      { from_task_id: 't_four4', to_task_id: 't_one11', link_type: 'related' },
    ]);

    expect(cycle).toEqual(['t_one11', 't_two22', 't_thr33', 't_one11']);
  });
});
