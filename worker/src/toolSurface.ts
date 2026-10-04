/**
 * Which MCP tools exist on which endpoint, and the permission annotations hosts see.
 * See docs/plans/mcp-surface.md.
 */

export interface ToolAnnotations {
  readOnlyHint: boolean;
  /** Only meaningful when readOnlyHint is false (MCP spec). */
  destructiveHint: boolean;
  idempotentHint?: boolean;
  openWorldHint: false;
}

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
/**
 * Conversational write that can be undone by another call: it adds or edits, never erases. The MCP
 * spec reads `destructiveHint: false` as additive-only, but marking every edit or unlink destructive
 * would make hosts confirm routine changes. Each change is revisioned and readable through history,
 * and a link removal can be added back, so "destructive" is reserved for deletes, bulk applies and
 * restore. Revisit when `undo_changes` ships.
 */
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

/**
 * One entry per registered tool; `annotate` throws at module load if a tool is missing, so a new
 * tool cannot ship without a deliberate tier.
 */
export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // Foundation reads
  get_capabilities: READ,
  resolve_time: READ,
  // Admin reads (served on /mcp/admin only)
  preview_legacy_dates: READ,
  get_workspace_snapshot: READ,
  export_planning_settings: READ,
  export_workspace: READ,
  // Display and reads
  show_tasks: READ,
  find: READ,
  get_context: READ,
  get_history: READ,
  describe_commands: READ,
  // Preview never writes.
  preview_changes: READ,
  // Conversational quick verbs
  add_task: WRITE,
  complete_task: WRITE,
  defer_task: WRITE,
  update_task: WRITE,
  focus_task: WRITE,
  // Destructive tier
  apply_changes: DESTRUCTIVE,
  restore_workspace: DESTRUCTIVE,
};

/** Tools served by `/mcp/admin`. Everything else stays on `/mcp` only. */
export const ADMIN_TOOL_NAMES = [
  'export_workspace',
  'restore_workspace',
  'get_workspace_snapshot',
  'export_planning_settings',
  'preview_legacy_dates',
] as const;

type Named = { name: string; description: string };

export function annotate<T extends Named>(tool: T): T & { annotations: ToolAnnotations } {
  const annotations = TOOL_ANNOTATIONS[tool.name];
  if (!annotations) throw new Error(`Tool ${tool.name} has no annotation tier.`);
  return { ...tool, annotations };
}
