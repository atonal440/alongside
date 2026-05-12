import type { BaseIssue, BaseSchema, InferOutput } from 'valibot';
import { parseSchema, type ValidationError } from '@shared/parse';
import type { Result } from '@shared/result';

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
