import type { BaseIssue, BaseSchema, InferOutput } from 'valibot';
import { parseSchema, type ValidationError } from '@shared/parse';
import { err, ok, type Result } from '@shared/result';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type WireSchema<T> = BaseSchema<unknown, T, BaseIssue<unknown>>;

export interface RouteSpec<Params, Query, Body> {
  method: HttpMethod;
  pattern: string;
  params: WireSchema<Params>;
  query: WireSchema<Query>;
  body: WireSchema<Body>;
}

export function defineRoute<const Params, const Query, const Body>(
  spec: RouteSpec<Params, Query, Body>,
): RouteSpec<Params, Query, Body> {
  return spec;
}

export function parseWire<TSchema extends WireSchema<unknown>>(
  schema: TSchema,
  input: unknown,
): Result<InferOutput<TSchema>, ValidationError[]> {
  return parseSchema(schema, input);
}

export interface ParsedRoute<TSpec extends RouteSpec<unknown, unknown, unknown>> {
  params: InferOutput<TSpec['params']>;
  query: InferOutput<TSpec['query']>;
}

function routeError(message: string, path: string[] = []): ValidationError {
  return { path, code: 'route', message };
}

function queryObject(searchParams: URLSearchParams): Record<string, string> {
  const query: Record<string, string> = {};
  for (const key of searchParams.keys()) {
    if (query[key] === undefined) query[key] = searchParams.get(key) ?? '';
  }
  return query;
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/').slice(1);
  const pathParts = pathname.split('/').slice(1);
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (const [index, patternPart] of patternParts.entries()) {
    const pathPart = pathParts[index];
    if (pathPart === undefined) return null;
    if (patternPart.startsWith(':')) {
      if (pathPart === '') return null;
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
    } else if (patternPart !== pathPart) {
      return null;
    }
  }

  return params;
}

export function parseRoute<TSpec extends RouteSpec<unknown, unknown, unknown>>(
  spec: TSpec,
  request: Request,
  url: URL,
): Result<ParsedRoute<TSpec> | null, ValidationError[]> {
  if (request.method !== spec.method) return ok(null);

  let rawParams: Record<string, string> | null;
  try {
    rawParams = matchPath(spec.pattern, url.pathname);
  } catch {
    return err([routeError('Invalid route parameter encoding.')]);
  }
  if (rawParams === null) return ok(null);

  const params = parseWire(spec.params, rawParams);
  const query = parseWire(spec.query, queryObject(url.searchParams));
  if (!params.ok || !query.ok) {
    return err([
      ...(!params.ok ? params.error : []),
      ...(!query.ok ? query.error : []),
    ]);
  }

  return ok({ params: params.value, query: query.value });
}
