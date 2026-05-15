import { describe, expect, it } from 'vitest';
import { DB, DomainOperationError } from '../src/db';

function dbWithoutStorage(): DB {
  return new DB({} as ConstructorParameters<typeof DB>[0]);
}

describe('DB task recurrence boundaries', () => {
  it('rejects malformed RRULEs before persistence', async () => {
    await expect(dbWithoutStorage().addTask({
      title: 'Bad repeat',
      due_date: '2026-05-15',
      recurrence: 'FREQ=WEEKL',
    })).rejects.toMatchObject({
      appError: { kind: 'validation' },
    });
  });

  it('rejects recurring tasks without a due date before persistence', async () => {
    await expect(dbWithoutStorage().addTask({
      title: 'Undated repeat',
      recurrence: 'FREQ=DAILY',
    })).rejects.toBeInstanceOf(DomainOperationError);
  });
});
