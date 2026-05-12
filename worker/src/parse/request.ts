import { err, ok, type Result } from '@shared/result';
import { validationError, type ValidationError } from '@shared/parse';

export async function readJson(request: Request): Promise<Result<unknown, ValidationError[]>> {
  try {
    return ok(await request.json());
  } catch {
    return err([validationError('json', 'Invalid JSON body.')]);
  }
}

export async function readForm(request: Request): Promise<Result<FormData, ValidationError[]>> {
  try {
    return ok(await request.formData());
  } catch {
    return err([validationError('form', 'Invalid form body.')]);
  }
}

export function readQueryBool(searchParams: URLSearchParams, key: string): Result<boolean | undefined, ValidationError[]> {
  const value = searchParams.get(key);
  if (value === null) return ok(undefined);
  if (value === 'true') return ok(true);
  if (value === 'false') return ok(false);
  return err([validationError('query_bool', `Expected ${key} to be "true" or "false".`, [key])]);
}

export function readRouteParam(params: Record<string, string | undefined>, key: string): Result<string, ValidationError[]> {
  const value = params[key];
  return value === undefined || value === ''
    ? err([validationError('route_param', `Missing route parameter ${key}.`, [key])])
    : ok(value);
}
