import { callFoundationTool, FOUNDATION_TOOLS, FoundationInputError } from './foundation';
import { callCommandTool, COMMAND_TOOLS } from './commands';
import { CommandError } from './domain/commands';
import { DB, DomainOperationError } from './db';
import type { Task, Project } from '@shared/types';
import type { Env } from './index';
import { getAppHtml, getActionLogHtml } from './app-ui';
import { runTool } from './adapters/runner';
import { addTask, completeTask, deferTask, focusTask, updateTask } from './adapters/taskVerbs';
import { createProject, deleteProject, deleteTask, linkTasks, reopenTask, unlinkTasks, updateProject } from './adapters/projectVerbs';
import { updatePreference } from './adapters/prefVerbs';
import { callReadTool, READ_TOOLS, READ_TOOL_NAMES } from './reads';
import { ADMIN_TOOL_NAMES, annotate, asDeprecatedAlias, withReplacement } from './toolSurface';

interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

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

/** No recorded activity for this long means the user is returning after a gap. */
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

Reading: find lists tasks or projects, get_context reads one entity with its neighborhood, get_history reads past changes.
Writing: the verbs (add_task, complete_task, and so on) and apply_changes all go through the same planner. Pass a commandId so a retry replays the first result instead of repeating the change.
Preferences are stored values the user has set; start_session returns them (with focused tasks) and update_preference changes them with update_preference when the user asks.
`.trim();

const TOOL_DEFS = [
  ...FOUNDATION_TOOLS,
  ...COMMAND_TOOLS,
  ...READ_TOOLS,
  {
    name: 'start_session',
    description: 'Optional snapshot: focused tasks, the top three ready tasks and preferences. It is the way to read focused tasks and stored preferences; nothing requires calling it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'show_tasks',
    description: 'Renders tasks in the inline widget. Does not change task state.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ids: { type: 'array', items: { type: 'string' }, description: 'Task IDs to display.' },
      },
      required: ['task_ids'],
    },
    _meta: uiMeta(TASK_DASHBOARD_URI),
  },
  {
    name: 'show_project',
    description: 'Renders a project and its tasks in the inline widget.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
      },
      required: ['project_id'],
    },
    _meta: uiMeta(TASK_DASHBOARD_URI),
  },
  {
    name: 'list_projects',
    description: 'Lists projects filtered by status. Defaults to active.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'archived'], description: 'Defaults to "active".' },
      },
    },
  },
  {
    name: 'list_tasks',
    description: 'Lists tasks filtered by status or search query. Includes deferred tasks (check defer_kind/defer_until to see if active). Defaults to pending.',
    inputSchema: {
      type: 'object',
      properties: {
        statuses: {
          type: 'array',
          items: { type: 'string', enum: ['pending', 'done'] },
          description: 'Defaults to ["pending"].',
        },
        query: { type: 'string', description: 'Search title and notes (case-insensitive).' },
      },
    },
  },
  {
    name: 'get_ready_tasks',
    description: 'Returns unblocked tasks sorted by readiness score.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Filter to a specific project.' },
      },
    },
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
        due_date: { type: 'string', description: 'ISO 8601 date or datetime. A bare date is all-day (stored at noon UTC); a full datetime is a genuine deadline at that moment. Omit for undated.' },
        recurrence: { type: 'string', description: 'Infinite date-only RRULE (e.g. FREQ=WEEKLY;INTERVAL=2 or FREQ=MONTHLY;BYDAY=3FR). Requires due_date.' },
        task_type: { type: 'string', enum: ['action', 'plan'], description: '"action" (default) or "plan".' },
        project_id: { type: 'string', description: 'Associate with a project.' },
        kickoff_note: { type: 'string', description: 'Where to start next time.' },
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
        due_date: { type: 'string', description: 'ISO 8601 date or datetime. A bare date is all-day (stored at noon UTC); a full datetime is a genuine deadline at that moment.' },
        recurrence: { type: 'string', description: 'Infinite date-only RRULE.' },
        task_type: { type: 'string', enum: ['action', 'plan'] },
        project_id: { type: 'string', description: 'Move to project, or null to remove.' },
        kickoff_note: { type: 'string', description: 'Where to start next time.' },
        session_log: { type: 'string', description: 'What happened this session.' },
        focused_until: { type: 'string', description: 'ISO 8601 timestamp. Set to null to clear focus.' },
      },
      required: ['task_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'reopen_task',
    description: 'Clears a deferral or re-opens a completed task.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional c_… ID. Retrying with the same ID and arguments replays the first result instead of repeating the change.' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'Optional. Refuse the change if the entity is no longer at this revision (see get_context).' },
        task_id: { type: 'string' },
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
  {
    name: 'delete_task',
    description: 'Permanently deletes a task. Prefer complete_task for finished work.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional c_… ID. Retrying with the same ID and arguments replays the first result instead of repeating the change.' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'Optional. Refuse the change if the entity is no longer at this revision (see get_context).' },
        task_id: { type: 'string' },
      },
      required: ['task_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'create_project',
    description: 'Creates a project and optionally assigns existing tasks to it.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional c_… ID. Retrying with the same ID and arguments replays the first result instead of repeating the change.' },
        title: { type: 'string', description: 'Project name.' },
        notes: { type: 'string', description: 'General project notes.' },
        kickoff_note: { type: 'string', description: 'Where to start and why.' },
        task_ids: { type: 'array', items: { type: 'string' }, description: 'Existing tasks to assign.' },
      },
      required: ['title'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'update_project',
    description: 'Updates a project\'s title, notes, kickoff note, or status. Use status "archived" to archive.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional c_… ID. Retrying with the same ID and arguments replays the first result instead of repeating the change.' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'Optional. Refuse the change if the entity is no longer at this revision (see get_context).' },
        project_id: { type: 'string' },
        title: { type: 'string' },
        notes: { type: 'string', description: 'General project notes.' },
        kickoff_note: { type: 'string', description: 'Where to start and why.' },
        status: { type: 'string', enum: ['active', 'archived'] },
      },
      required: ['project_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'delete_project',
    description: 'Permanently deletes a project. Its tasks are kept but unlinked.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional c_… ID. Retrying with the same ID and arguments replays the first result instead of repeating the change.' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'Optional. Refuse the change if the entity is no longer at this revision (see get_context).' },
        project_id: { type: 'string' },
      },
      required: ['project_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'get_project_context',
    description: 'Returns a project\'s details and its ready tasks in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'link_tasks',
    description: 'Creates a dependency between two tasks. Defaults to "blocks" (from must complete before to).',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional c_… ID. Retrying with the same ID and arguments replays the first result instead of repeating the change.' },
        from_task_id: { type: 'string', description: 'The blocking or related task.' },
        to_task_id: { type: 'string', description: 'The blocked or related task.' },
        link_type: { type: 'string', enum: ['blocks', 'related'], description: 'Defaults to "blocks".' },
      },
      required: ['from_task_id', 'to_task_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'unlink_tasks',
    description: 'Removes a dependency between two tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional c_… ID. Retrying with the same ID and arguments replays the first result instead of repeating the change.' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'Optional. Refuse the change if the entity is no longer at this revision (see get_context).' },
        from_task_id: { type: 'string' },
        to_task_id: { type: 'string' },
        link_type: { type: 'string', enum: ['blocks', 'related'], description: 'Defaults to "blocks".' },
      },
      required: ['from_task_id', 'to_task_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'update_preference',
    description: 'Sets a user preference. Call immediately when the user states one.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional c_… ID. Retrying with the same ID and arguments replays the first result instead of repeating the change.' },
        expectedRevision: { type: ['integer', 'null'], minimum: 0, description: 'Optional. Refuse the change if the preference is no longer at this revision (null: it has never been set).' },
        key: { type: 'string', enum: ['sort_by', 'urgency_visibility', 'kickoff_nudge', 'session_log', 'interruption_style', 'planning_prompt'] },
        value: { type: 'string' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'get_action_log',
    description: 'Returns recent operation history. Used by the action log widget.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** Default `/mcp` list. Tools that moved to the admin endpoint or REST stay here as deprecated aliases until phase D. */
export const TOOLS = TOOL_DEFS.map(tool => annotate(withReplacement(asDeprecatedAlias(tool))));

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
    case 'reopen_task': return runTool('reopen_task', args, db, reopenTask);
    case 'delete_task': return runTool('delete_task', args, db, deleteTask);
    case 'create_project': return runTool('create_project', args, db, createProject);
    case 'update_project': return runTool('update_project', args, db, updateProject);
    case 'delete_project': return runTool('delete_project', args, db, deleteProject);
    case 'link_tasks': return runTool('link_tasks', args, db, linkTasks);
    case 'unlink_tasks': return runTool('unlink_tasks', args, db, unlinkTasks);
    case 'show_tasks': {
      const taskIds = args.task_ids as string[];
      const tasks = (await Promise.all(taskIds.map(id => db.getTask(id)))).filter((t): t is NonNullable<typeof t> => t !== null);
      // Include project names so the widget can show them without extra fetches
      const projectIds = [...new Set(tasks.filter(t => t.project_id).map(t => t.project_id as string))];
      const projectEntries = await Promise.all(
        projectIds.map(async id => [id, (await db.getProject(id))?.title ?? null])
      );
      const projects: Record<string, string> = Object.fromEntries(projectEntries.filter(([, v]) => v));
      return { tasks, projects };
    }

    case 'show_project': {
      const project = await db.getProject(args.project_id as string);
      if (!project) throw new Error('Project not found');
      const allTasks = await db.listAllTasks(['pending']);
      const tasks = allTasks.filter(t => t.project_id === args.project_id);
      return { project, tasks };
    }

    case 'start_session': {
      // Read-only: defaults are merged in memory (no rows are seeded), so nothing here needs a
      // command ID or receipt.
      const [readyTasks, focusedTasks, preferences] = await Promise.all([
        db.listReadyTasks(),
        db.listFocusedTasks(),
        db.getAllPreferences(),
      ]);

      return {
        focused_tasks: focusedTasks,
        suggested_tasks: readyTasks.slice(0, 3),
        preferences,
      };
    }
    case 'list_projects': {
      const status = ((args.status as string) || 'active') as Project['status'];
      const projects = await db.listProjects(status);
      return { projects };
    }

    case 'list_tasks': {
      const statuses = ((args.statuses as string[]) || ['pending']) as Task['status'][];
      let tasks = await db.listAllTasks(statuses);
      const query = args.query as string | undefined;
      if (query) {
        const q = query.toLowerCase();
        tasks = tasks.filter(t =>
          t.title.toLowerCase().includes(q) ||
          (t.notes && t.notes.toLowerCase().includes(q))
        );
      }
      return { tasks };
    }

    case 'get_ready_tasks': {
      const projectId = args.project_id as string | undefined;
      const tasks = await db.listReadyTasks(projectId);
      return { tasks };
    }

    case 'get_project_context': {
      const project = await db.getProject(args.project_id as string);
      if (!project) throw new Error('Project not found');
      const ready_tasks = await db.listReadyTasks(args.project_id as string);
      return { project, ready_tasks };
    }

    case 'update_preference': return runTool('update_preference', args, db, updatePreference);
    case 'get_action_log': {
      const entries = await db.getActionLog();
      return { entries };
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
        const result = await handleToolCall(params.name, params.arguments || {}, db);
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
