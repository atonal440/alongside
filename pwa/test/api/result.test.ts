import { describe, test, expect } from 'vitest';
import { isDurableFailure, isTransientFailure, type ApiResult } from '../../src/api/result';

function ok(): ApiResult<unknown> { return { kind: 'ok', value: 'x' }; }
function http(status: number): ApiResult<unknown> { return { kind: 'http', status, body: { error: 'e' } }; }
function contract(): ApiResult<unknown> { return { kind: 'contract', status: 200, issues: [] }; }
function network(): ApiResult<unknown> { return { kind: 'network' }; }
function unconfigured(): ApiResult<unknown> { return { kind: 'unconfigured' }; }

describe('isDurableFailure', () => {
  test('false for ok', () => { expect(isDurableFailure(ok())).toBe(false); });
  test('false for network', () => { expect(isDurableFailure(network())).toBe(false); });
  test('false for unconfigured', () => { expect(isDurableFailure(unconfigured())).toBe(false); });
  test('true for contract', () => { expect(isDurableFailure(contract())).toBe(true); });
  test('true for 400', () => { expect(isDurableFailure(http(400))).toBe(true); });
  test('true for 404', () => { expect(isDurableFailure(http(404))).toBe(true); });
  test('true for 409', () => { expect(isDurableFailure(http(409))).toBe(true); });
  test('true for 422', () => { expect(isDurableFailure(http(422))).toBe(true); });
  test('false for 500', () => { expect(isDurableFailure(http(500))).toBe(false); });
  test('false for 503', () => { expect(isDurableFailure(http(503))).toBe(false); });
});

describe('isTransientFailure', () => {
  test('false for ok', () => { expect(isTransientFailure(ok())).toBe(false); });
  test('false for contract', () => { expect(isTransientFailure(contract())).toBe(false); });
  test('false for unconfigured', () => { expect(isTransientFailure(unconfigured())).toBe(false); });
  test('true for network', () => { expect(isTransientFailure(network())).toBe(true); });
  test('false for 400', () => { expect(isTransientFailure(http(400))).toBe(false); });
  test('false for 404', () => { expect(isTransientFailure(http(404))).toBe(false); });
  test('false for 409', () => { expect(isTransientFailure(http(409))).toBe(false); });
  test('false for 422', () => { expect(isTransientFailure(http(422))).toBe(false); });
  test('true for 500', () => { expect(isTransientFailure(http(500))).toBe(true); });
  test('true for 503', () => { expect(isTransientFailure(http(503))).toBe(true); });
});

describe('mutual exclusivity', () => {
  const cases: Array<[string, ApiResult<unknown>]> = [
    ['ok', ok()],
    ['http 400', http(400)],
    ['http 404', http(404)],
    ['http 409', http(409)],
    ['http 422', http(422)],
    ['http 500', http(500)],
    ['http 503', http(503)],
    ['contract', contract()],
    ['network', network()],
    ['unconfigured', unconfigured()],
  ];

  test.each(cases)('%s: durable and transient are never both true', (_, r) => {
    expect(isDurableFailure(r) && isTransientFailure(r)).toBe(false);
  });

  test.each(cases)('ok and unconfigured are unclassified', (label, r) => {
    if (label === 'ok' || label === 'unconfigured') {
      expect(isDurableFailure(r)).toBe(false);
      expect(isTransientFailure(r)).toBe(false);
    }
  });
});
