import { describe, expect, it } from 'vitest';
import { ok } from '@shared/result';

describe('worker test harness', () => {
  it('loads shared modules through the worker alias', () => {
    expect(ok('ready')).toEqual({ ok: true, value: 'ready' });
  });
});
