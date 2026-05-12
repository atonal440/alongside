import * as v from 'valibot';
import { TOOL_NAMES, ToolNameSchema } from '../parse';

export const McpToolNameSchema = ToolNameSchema;

export const McpToolCallParamsSchema = v.object({
  name: McpToolNameSchema,
  arguments: v.optional(v.objectWithRest({}, v.unknown())),
});

export type McpToolName = (typeof TOOL_NAMES)[number];
