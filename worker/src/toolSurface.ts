/**
 * Which MCP tools exist on which endpoint, and the permission annotations hosts see.
 * See docs/plans/mcp-surface.md (phase A).
 */

export interface ToolAnnotations {
  readOnlyHint: boolean;
  /** Only meaningful when readOnlyHint is false (MCP spec). */
  destructiveHint: boolean;
  idempotentHint?: boolean;
  openWorldHint: false;
}

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
/** Conversational write that can be undone by another call: it adds or edits, never erases. */
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
  preview_legacy_dates: READ,
  // Sync, version and admin reads
  get_workspace_snapshot: READ,
  get_workspace_delta: READ,
  get_entity: READ,
  get_entity_version: READ,
  get_link: READ,
  get_planning_settings: READ,
  export_planning_settings: READ,
  export_workspace: READ,
  // Display and listing
  show_tasks: READ,
  show_project: READ,
  list_projects: READ,
  list_tasks: READ,
  get_ready_tasks: READ,
  get_project_context: READ,
  get_action_log: READ,
  // Phase B reads
  find: READ,
  get_context: READ,
  get_history: READ,
  describe_commands: READ,
  // Preview never writes.
  preview_changes: READ,
  // Read-only since phase C: defaults merge in memory and the gap comes from history.
  start_session: READ,
  // Conversational writes (the future quick verbs and their legacy siblings)
  add_task: WRITE,
  complete_task: WRITE,
  defer_task: WRITE,
  update_task: WRITE,
  reopen_task: WRITE,
  focus_task: WRITE,
  create_project: WRITE,
  update_project: WRITE,
  link_tasks: WRITE,
  unlink_tasks: WRITE,
  update_preference: { ...WRITE, idempotentHint: true },
  // Destructive tier
  delete_task: DESTRUCTIVE,
  delete_project: DESTRUCTIVE,
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

/**
 * Tools that moved off the default endpoint but stay listed there as deprecated aliases until
 * phase D. The value says where the tool lives now; behavior is unchanged.
 */
export const DEPRECATED_ALIASES: Record<string, string> = {
  get_workspace_snapshot: 'Moved to the admin endpoint (/mcp/admin) and GET /api/v2/sync/snapshot.',
  get_workspace_delta: 'Moved to REST only: POST /api/v2/sync/delta.',
  get_entity_version: 'Moved to REST only: POST /api/v2/entity-version.',
  export_workspace: 'Moved to the admin endpoint (/mcp/admin).',
  restore_workspace: 'Moved to the admin endpoint (/mcp/admin).',
  export_planning_settings: 'Moved to the admin endpoint (/mcp/admin).',
  preview_legacy_dates: 'Moved to the admin endpoint (/mcp/admin).',
};

type Named = { name: string; description: string };

export function annotate<T extends Named>(tool: T): T & { annotations: ToolAnnotations } {
  const annotations = TOOL_ANNOTATIONS[tool.name];
  if (!annotations) throw new Error(`Tool ${tool.name} has no annotation tier.`);
  return { ...tool, annotations };
}

/** Default-endpoint copy of a moved tool: same behavior, description names the new home. */
export function asDeprecatedAlias<T extends Named>(tool: T): T {
  const home = DEPRECATED_ALIASES[tool.name];
  return home ? { ...tool, description: `Deprecated alias. ${home} ${tool.description}` } : tool;
}

/** Read tools replaced by a phase B tool. They keep working; only the description changes. */
export const REPLACED_BY: Record<string, string> = {
  list_projects: 'find({ entity: "project", filter: { status } })',
  list_tasks: 'find({ entity: "task", filter: { statuses, text } })',
  get_ready_tasks: 'find({ entity: "task", preset: "ready", filter: { project_id } })',
  get_project_context: 'get_context({ entity: "project", id })',
  get_action_log: 'get_history',
  get_entity: 'get_context({ entity, id, depth: 0 })',
  get_link: 'get_context({ entity: "link", from, to, linkType, depth: 0 })',
  get_planning_settings: 'get_context({ entity: "settings" })',
};

export function withReplacement<T extends Named>(tool: T): T {
  const next = REPLACED_BY[tool.name];
  return next ? { ...tool, description: `Deprecated: use ${next}. ${tool.description}` } : tool;
}
