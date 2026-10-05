import { callFoundationTool, FOUNDATION_TOOLS, FoundationInputError } from './foundation';
import { callCommandTool, COMMAND_TOOLS } from './commands';
import { CommandError } from './domain/commands';
import { DB, DomainOperationError } from './db';
import type { Env } from './index';
import { getAppHtml, getActionLogHtml } from './app-ui';
import { runTool } from './adapters/runner';
import { addTask, completeTask, deferTask, focusTask, updateTask } from './adapters/taskVerbs';
import { callReadTool, READ_TOOLS, READ_TOOL_NAMES } from './reads';
import { ADMIN_TOOL_NAMES, annotate } from './toolSurface';
import { presentDateRoles } from './present';

interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

const PORTABLE_TOOLS = new Set(['export_workspace', 'restore_workspace', 'get_workspace_snapshot', 'get_workspace_delta']);

function mcpResponse(id: string | number, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function mcpError(id: string | number, code: number, message: string) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

const TASK_DASHBOARD_URI = 'ui://alongside/task-dashboard';
const ACTION_LOG_URI = 'ui://alongside/action-log';

// Helper: build _meta with both modern and legacy keys (SDK compat)
function uiMeta(resourceUri: string, extra?: Record<string, unknown>) {
  return {
    'ui/resourceUri': resourceUri,
    ui: { resourceUri, ...extra },
  };
}

const SERVER_INSTRUCTIONS = `
Alongside stores tasks, projects, links, focus windows and a change history. It does not prescribe a workflow; follow the user's own.

Reading: find lists tasks or projects (sort, order and filters such as focused are arguments), get_context reads one entity with its neighborhood, get_history reads past changes.
Writing: the verbs (add_task, complete_task, and so on) and apply_changes all go through the same planner. Pass a commandId so a retry replays the first result instead of repeating the change.
Preferences are stored values the user has set; get_context({ entity: "preferences" }) reads them and apply_changes with a preference.set command changes one when the user asks.
`.trim();

const TOOL_DEFS = [
  ...FOUNDATION_TOOLS,
  ...COMMAND_TOOLS,
  ...READ_TOOLS,
  {
    name: 'show_tasks',
    description: 'Renders tasks in the inline widget: the given task IDs, or a project and its pending tasks. Give exactly one of task_ids or project_id. Does not change task state.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ids: { type: 'array', items: { type: 'string' }, description: 'Task IDs to display.' },
        project_id: { type: 'string', description: 'A project to display with its pending tasks.' },
      },
    },
    _meta: uiMeta(TASK_DASHBOARD_URI),
  },
  {
    name: 'add_task',
    description: 'Creates a task in pending status. Set due_date + recurrence for repeating tasks. Set task_type "plan" for tasks needing a planning conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional c_… ID. Retrying with the same ID and arguments replays the first result instead of repeating the change.' },
        title: { type: 'string', description: 'Short, actionable title.' },
        notes: { type: 'string', description: 'Additional context or links.' },
        due_date: { type: 'string', description: 'The target: when to aim to finish. ISO 8601 date or datetime. A bare date is all-day (stored at noon UTC); a full datetime is a timed target. Use deadline for a hard boundary. Omit for undated.' },
        recurrence: { type: 'string', description: 'Infinite date-only RRULE (e.g. FREQ=WEEKLY;INTERVAL=2 or FREQ=MONTHLY;BYDAY=3FR). Requires due_date.' },
        task_type: { type: 'string', enum: ['action', 'plan'], description: '"action" (default) or "plan".' },
        project_id: { type: 'string', description: 'Associate with a project.' },
        kickoff_note: { type: 'string', description: 'Where to start next time.' },
        parent_id: { type: 'string', description: 'Make this a subtask of that task. The parent must be in the same project (set project_id to match). Nests up to 32 deep.' },
        position: { type: 'number', description: 'Sort key among siblings, ascending. Only used with parent_id.' },
        deadline: { type: 'string', description: 'Hard deadline, distinct from due_date (the target to aim for). A bare YYYY-MM-DD allows completion throughout that local day; an ISO datetime with offset is a moment. Needs timezone or a workspace timezone.' },
        available_from: { type: 'string', description: 'Earliest permitted start, independent of deferral. YYYY-MM-DD opens at the start of that local day; an ISO datetime with offset is a moment. Needs timezone or a workspace timezone.' },
        timezone: { type: 'string', description: 'IANA zone for deadline and available_from (e.g. America/Los_Angeles). Defaults to the workspace timezone.' },
      },
      required: ['title'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'complete_task',
    description: 'Marks a task done. Recurring tasks automatically get their next occurrence created.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional c_… ID. Retrying with the same ID and arguments replays the first result instead of repeating the change.' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'Optional. Refuse the change if the task is no longer at this revision (see get_context).' },
        task_id: { type: 'string' },
      },
      required: ['task_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'defer_task',
    description: 'Hides a task. Use kind="until" with an ISO timestamp to defer temporarily, or kind="someday" to defer indefinitely.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional c_… ID. Retrying with the same ID and arguments replays the first result instead of repeating the change.' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'Optional. Refuse the change if the task is no longer at this revision (see get_context).' },
        task_id: { type: 'string' },
        kind: { type: 'string', enum: ['until', 'someday'], description: '"until" reappears at the given timestamp; "someday" hides indefinitely.' },
        until: { type: 'string', description: 'ISO 8601 timestamp with timezone. Required when kind="until".' },
      },
      required: ['task_id', 'kind'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'update_task',
    description: 'Updates fields on an existing task. Only included fields change.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional c_… ID. Retrying with the same ID and arguments replays the first result instead of repeating the change.' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'Optional. Refuse the change if the task is no longer at this revision (see get_context).' },
        task_id: { type: 'string' },
        title: { type: 'string' },
        notes: { type: 'string', description: 'Replaces existing notes.' },
        status: { type: 'string', enum: ['pending'], description: 'Use complete_task for "done", defer_task to defer, focus_task to put front-of-mind. Only valid value is "pending" (to reset a task).' },
        due_date: { type: 'string', description: 'The target: when to aim to finish. ISO 8601 date or datetime. A bare date is all-day (stored at noon UTC); a full datetime is a timed target. Use deadline for a hard boundary.' },
        recurrence: { type: 'string', description: 'Infinite date-only RRULE.' },
        task_type: { type: 'string', enum: ['action', 'plan'] },
        project_id: { type: ['string', 'null'], description: 'Move to project, or null to remove.' },
        kickoff_note: { type: 'string', description: 'Where to start next time.' },
        session_log: { type: 'string', description: 'What happened this session.' },
        parent_id: { type: ['string', 'null'], description: 'Make this a subtask of that task (same project, no loops, up to 32 deep), or null to make it top level.' },
        position: { type: ['number', 'null'], description: 'Sort key among siblings, ascending; null clears it.' },
        deadline: { type: ['string', 'null'], description: 'Hard deadline, distinct from due_date (the target to aim for). YYYY-MM-DD or ISO datetime with offset; null clears it. Needs timezone or a workspace timezone.' },
        available_from: { type: ['string', 'null'], description: 'Earliest permitted start, independent of deferral. YYYY-MM-DD or ISO datetime with offset; null clears it.' },
        timezone: { type: 'string', description: 'IANA zone for deadline and available_from. Defaults to the workspace timezone.' },
        focused_until: { type: ['string', 'null'], description: 'ISO 8601 timestamp. Set to null to clear focus.' },
      },
      required: ['task_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'focus_task',
    description: 'Puts a task front-of-mind for a time window (default 3 hours). Focus decays automatically — no cleanup needed.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional c_… ID. Retrying with the same ID and arguments replays the first result instead of repeating the change.' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'Optional. Refuse the change if the task is no longer at this revision (see get_context).' },
        task_id: { type: 'string' },
        hours: { type: 'number', description: 'How long to keep focus, greater than 0 and no more than 24 hours. Defaults to 3.' },
      },
      required: ['task_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
];

const isSharedDef = (name: string) =>
  FOUNDATION_TOOLS.some(tool => tool.name === name) || COMMAND_TOOLS.some(tool => tool.name === name);
/** Foundation and command tools the default endpoint lists; the rest are admin-only or REST-only. */
const DEFAULT_SHARED_TOOL_NAMES: readonly string[] = ['get_capabilities', 'resolve_time', 'preview_changes', 'apply_changes'];

/** Default `/mcp` list. Export, restore and the sync reads live on `/mcp/admin` or REST only. */
export const TOOLS = TOOL_DEFS
  .filter(tool => !isSharedDef(tool.name) || DEFAULT_SHARED_TOOL_NAMES.includes(tool.name))
  .map(tool => annotate(tool));

/** Opt-in `/mcp/admin` list: export, restore, and the reads restore depends on. */
export const ADMIN_TOOLS = ADMIN_TOOL_NAMES.map(name => {
  const tool = TOOL_DEFS.find(candidate => candidate.name === name);
  if (!tool) throw new Error(`Admin tool ${name} is not registered.`);
  return annotate(tool);
});

export type McpSurface = 'default' | 'admin';

const UI_RESOURCES = [
  {
    uri: TASK_DASHBOARD_URI,
    name: 'Task Dashboard',
    description: 'Interactive task list with checkboxes for completing tasks.',
    mimeType: 'text/html;profile=mcp-app',
  },
  {
    uri: ACTION_LOG_URI,
    name: 'Action Log',
    description: 'Compact one-line feedback for task mutations.',
    mimeType: 'text/html;profile=mcp-app',
  },
];

async function handleToolCall(name: string, args: Record<string, unknown>, db: DB) {
  if (FOUNDATION_TOOLS.some(tool => tool.name === name)) return callFoundationTool(name, args, db);
  if (COMMAND_TOOLS.some(tool => tool.name === name)) return callCommandTool(name, args, db, { source: 'mcp' });
  if (READ_TOOL_NAMES.includes(name)) return callReadTool(name, args, db);
  switch (name) {
    case 'add_task': return runTool('add_task', args, db, addTask);
    case 'complete_task': return runTool('complete_task', args, db, completeTask);
    case 'defer_task': return runTool('defer_task', args, db, deferTask);
    case 'update_task': return runTool('update_task', args, db, updateTask);
    case 'focus_task': return runTool('focus_task', args, db, focusTask);
    case 'show_tasks': {
      const projectId = args.project_id as string | undefined;
      const taskIds = args.task_ids as string[] | undefined;
      if ((projectId === undefined) === (taskIds === undefined)) throw new Error('Give exactly one of task_ids or project_id.');
      if (projectId !== undefined && typeof projectId !== 'string') throw new Error('project_id must be a string.');
      if (taskIds !== undefined && (!Array.isArray(taskIds) || taskIds.some(id => typeof id !== 'string'))) throw new Error('task_ids must be an array of strings.');
      if (projectId !== undefined) {
        const project = await db.getProject(projectId);
        if (!project) throw new Error('Project not found');
        const tasks = (await db.listAllTasks(['pending'])).filter(t => t.project_id === projectId);
        return { project, tasks };
      }
      const tasks = (await Promise.all(taskIds!.map(id => db.getTask(id)))).filter((t): t is NonNullable<typeof t> => t !== null);
      // Include project names so the widget can show them without extra fetches
      const projectIds = [...new Set(tasks.filter(t => t.project_id).map(t => t.project_id as string))];
      const projectEntries = await Promise.all(
        projectIds.map(async id => [id, (await db.getProject(id))?.title ?? null])
      );
      const projects: Record<string, string> = Object.fromEntries(projectEntries.filter(([, v]) => v));
      return { tasks, projects };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function handleMcpRequest(request: Request, db: DB, env: Env, surface: McpSurface = 'default'): Promise<Response> {
  const admin = surface === 'admin';
  const endpoint = admin ? '/mcp/admin' : '/mcp';
  if (request.method === 'GET') {
    // Streamable HTTP: GET opens an SSE stream for server-initiated messages.
    return new Response(`event: endpoint\ndata: ${endpoint}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  }
  if (request.method === 'DELETE') {
    return new Response(null, { status: 204 });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await request.json<McpRequest>();

  switch (body.method) {
    case 'initialize':
      return mcpResponse(body.id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          resources: {},
          extensions: {
            'io.modelcontextprotocol/ui': {
              mimeTypes: ['text/html;profile=mcp-app'],
            },
          },
        },
        serverInfo: { name: admin ? 'alongside-admin' : 'alongside', version: '1.0.0' },
        ...(admin ? {} : { instructions: SERVER_INSTRUCTIONS }),
      });

    case 'tools/list':
      return mcpResponse(body.id, { tools: admin ? ADMIN_TOOLS : TOOLS });

    case 'resources/list':
      return mcpResponse(body.id, { resources: admin ? [] : UI_RESOURCES });

    case 'resources/read': {
      const params = body.params as { uri: string };
      if (admin) return mcpError(body.id, -32602, `Unknown resource: ${params.uri}`);
      if (params.uri === TASK_DASHBOARD_URI) {
        return mcpResponse(body.id, {
          contents: [{
            uri: TASK_DASHBOARD_URI,
            mimeType: 'text/html;profile=mcp-app',
            text: getAppHtml(),
            _meta: { ui: { prefersBorder: true } },
          }],
        });
      }
      if (params.uri === ACTION_LOG_URI) {
        return mcpResponse(body.id, {
          contents: [{
            uri: ACTION_LOG_URI,
            mimeType: 'text/html;profile=mcp-app',
            text: getActionLogHtml(),
            _meta: { ui: { prefersBorder: false } },
          }],
        });
      }
      return mcpError(body.id, -32602, `Unknown resource: ${params.uri}`);
    }

    case 'tools/call': {
      const params = body.params as { name: string; arguments?: Record<string, unknown> };
      try {
        const listed = admin ? ADMIN_TOOLS : TOOLS;
        if (!listed.some(tool => tool.name === params.name)) throw new Error(`Unknown tool: ${params.name}`);
        const raw = await handleToolCall(params.name, params.arguments || {}, db);
        // Portable documents and the sync feed keep the stored spelling so they restore exactly.
        const result = PORTABLE_TOOLS.has(params.name) ? raw : presentDateRoles(raw);
        const toolDef = listed.find(t => t.name === params.name) as { _meta?: Record<string, unknown> } | undefined;
        const meta = toolDef?._meta ? { _meta: toolDef._meta } : {};
        return mcpResponse(body.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          ...meta,
        });
      } catch (e) {
        if (e instanceof DomainOperationError && e.appError.kind === 'capacity_exceeded') {
          return mcpResponse(body.id, { isError: true, content: [{ type: 'text', text: e.message }], structuredContent: { error: { code: 'capacity_exceeded', requiredStatements: e.appError.requiredStatements, limit: e.appError.limit, retryable: false, recoveryHint: 'Reduce the atomic scope; replacement imports cannot be split into independent wipes.' } } });
        }
        if (e instanceof FoundationInputError || e instanceof CommandError) {
          return mcpResponse(body.id, { isError: true, content: [{ type: 'text', text: e.message }], structuredContent: { contractVersion: 2, error: e.detail } });
        }
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return mcpError(body.id, -32000, msg);
      }
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
        headers: { 'Content-Type': 'application/json' },
      });

    default:
      return mcpError(body.id, -32601, `Method not found: ${body.method}`);
  }
}
