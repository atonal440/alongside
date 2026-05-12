export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function mapResult<T, U, E>(result: Result<T, E>, map: (value: T) => U): Result<U, E> {
  if (result.ok) return ok(map(result.value));
  return err(result.error);
}

export function andThen<T, U, E>(
  result: Result<T, E>,
  next: (value: T) => Result<U, E>,
): Result<U, E> {
  if (result.ok) return next(result.value);
  return err(result.error);
}

export function all<T, E>(results: readonly Result<T, readonly E[]>[]): Result<T[], E[]> {
  const values: T[] = [];
  const errors: E[] = [];

  for (const result of results) {
    if (!result.ok) {
      errors.push(...result.error);
      continue;
    }
    values.push(result.value);
  }

  return errors.length > 0 ? err(errors) : ok(values);
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
