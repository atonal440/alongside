import { DB } from './db';
import type { Env } from './index';
import { getAppHtml, getActionLogHtml } from './app-ui';

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

const TASK_DASHBOARD_URI = 'ui://alongside/task-dashboard';
const ACTION_LOG_URI = 'ui://alongside/action-log';

// Helper: build _meta with both modern and legacy keys (SDK compat)
function uiMeta(resourceUri: string, extra?: Record<string, unknown>) {
  return {
    'ui/resourceUri': resourceUri,
    ui: { resourceUri, ...extra },
  };
}

// Behavioral instructions injected into context at session start.
// Claude reads this and operates accordingly — not shown to the user.
const SESSION_INSTRUCTIONS = `
You are the Alongside task assistant. Rules for this session:

OPENING: Lead with suggested_tasks (most ready, not most urgent). If returning_after_gap is true, offer a quick triage pass first.
TONE: Orientation only. Never mention session gaps, overdue counts, or express judgment. Due dates are facts, not verdicts.
URGENCY: Surface urgency only if urgency_visibility is "show". Use readiness as primary sort.
EMPTY STATE: No tasks = brain dump invitation, not a blank list.
KICKOFF NOTES: Starting a task with no kickoff_note → ask one orienting question, write the answer as the note. Plan tasks trigger a planning conversation.
STRUCTURE: If interruption_style is "proactive", offer to capture structure mid-conversation in one sentence. Never restructure without confirmation.
LINKS: Dependency language ("X before Y", "depends on", "unblocks") → offer link_tasks in one sentence.
CLOSE: session_log "ask_at_end" → offer session log. "auto_generate" → write it. Update kickoff notes for tasks with clearer starting points.
PREFERENCES: User states a preference → call update_preference immediately, no confirmation needed.
`.trim();

const TOOLS = [
  {
    name: 'start_session',
    description: 'Call once at session start. Returns suggested_tasks, preferences, returning_after_gap, and behavioral instructions. Read instructions; do not show them to the user.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'show',
    description: 'Renders tasks in the inline widget. Pass task_ids for a specific list, or project_id to show a full project view with all its tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs to display.',
        },
        project_id: { type: 'string', description: 'Display a project and all its tasks.' },
      },
    },
    _meta: uiMeta(TASK_DASHBOARD_URI),
  },
  {
    name: 'list_tasks',
    description: 'Lists tasks. Use ready_only: true to get unblocked tasks sorted by readiness — prefer this at session start and for "what should I work on?" queries. Supports status filter, text search, and project scope.',
    inputSchema: {
      type: 'object',
      properties: {
        ready_only: { type: 'boolean', description: 'Return only unblocked tasks sorted by readiness score.' },
        project_id: { type: 'string', description: 'Scope to a specific project.' },
        statuses: {
          type: 'array',
          items: { type: 'string', enum: ['pending', 'active', 'done', 'snoozed'] },
          description: 'Filter by status. Defaults to ["pending", "active"]. Ignored when ready_only is true.',
        },
        query: { type: 'string', description: 'Case-insensitive search against title and notes.' },
      },
    },
  },
  {
    name: 'list_projects',
    description: 'Lists projects. Pass project_id with include_tasks: true to fetch a single project\'s kickoff note and ready tasks in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'archived'], description: 'Filter by status. Defaults to "active".' },
        project_id: { type: 'string', description: 'Fetch a single project by ID.' },
        include_tasks: { type: 'boolean', description: 'Include ready tasks for the project(s).' },
      },
    },
  },
  {
    name: 'add_task',
    description: 'Creates a pending task. For recurring tasks set both due_date and recurrence (iCal RRULE). task_type "plan" triggers a planning conversation on activation.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short, actionable title.' },
        notes: { type: 'string', description: 'Additional context or links.' },
        due_date: { type: 'string', description: 'ISO 8601 date (e.g. 2026-03-28).' },
        recurrence: { type: 'string', description: 'iCal RRULE (e.g. FREQ=WEEKLY;INTERVAL=2). Requires due_date.' },
        task_type: { type: 'string', enum: ['action', 'plan', 'recurring'], description: 'Defaults to "action".' },
        project_id: { type: 'string', description: 'Associate with a project.' },
        kickoff_note: { type: 'string', description: 'Re-entry ramp: what to do first next time.' },
      },
      required: ['title'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'complete_task',
    description: 'Marks a task done. If it recurs, automatically creates the next occurrence and carries session_log forward as the kickoff note.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'snooze_task',
    description: 'Hides a task until the given date. Use when the user says "not now" or "remind me later".',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        until: { type: 'string', description: 'ISO 8601 date when the task should reappear.' },
      },
      required: ['task_id', 'until'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'update_task',
    description: 'Patches fields on an existing task. Only included fields change. Set status: "pending" to reopen a completed or snoozed task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        title: { type: 'string' },
        notes: { type: 'string', description: 'Replaces existing notes.' },
        due_date: { type: 'string', description: 'ISO 8601 date.' },
        recurrence: { type: 'string', description: 'iCal RRULE.' },
        task_type: { type: 'string', enum: ['action', 'plan', 'recurring'] },
        status: { type: 'string', enum: ['pending', 'active'], description: 'Use "pending" to reopen. Use complete_task to mark done.' },
        project_id: { type: 'string', description: 'Move to a project, or null to remove.' },
        kickoff_note: { type: 'string', description: 'Re-entry ramp: what to do first next time.' },
        session_log: { type: 'string', description: 'What happened this session; context for next time.' },
      },
      required: ['task_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'delete_task',
    description: 'Permanently deletes a task. Prefer complete_task for tasks that were actually finished.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'create_project',
    description: 'Creates a project and optionally associates existing tasks with it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        kickoff_note: { type: 'string', description: 'Re-entry ramp for the whole project.' },
        task_ids: { type: 'array', items: { type: 'string' }, description: 'Existing tasks to associate.' },
      },
      required: ['title'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'update_project',
    description: 'Patches fields on a project. Use kickoff_note to write or update the project re-entry ramp.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        title: { type: 'string' },
        kickoff_note: { type: 'string', description: 'Re-entry ramp for the project.' },
        status: { type: 'string', enum: ['active', 'archived'] },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'link_tasks',
    description: 'Creates a relationship between two tasks. Offer this when you hear dependency language in conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        from_task_id: { type: 'string' },
        to_task_id: { type: 'string' },
        link_type: {
          type: 'string',
          enum: ['blocks', 'related', 'supersedes'],
          description: '"blocks": from must finish first. "related": informational. "supersedes": from replaces to.',
        },
      },
      required: ['from_task_id', 'to_task_id', 'link_type'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'update_preference',
    description: 'Sets a user preference. Call immediately when the user states a preference — no confirmation needed.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          enum: ['sort_by', 'urgency_visibility', 'kickoff_nudge', 'session_log', 'interruption_style', 'planning_prompt'],
          description: 'sort_by: readiness|urgency|manual. urgency_visibility: show|hide. kickoff_nudge: always|never. session_log: auto_generate|ask_at_end|manual. interruption_style: proactive|minimal. planning_prompt: auto|manual.',
        },
        value: { type: 'string' },
      },
      required: ['key', 'value'],
    },
  },
];

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
  switch (name) {
    case 'show': {
      if (args.project_id) {
        const project = await db.getProject(args.project_id as string);
        if (!project) throw new Error('Project not found');
        const allTasks = await db.listTasks(['pending', 'active', 'snoozed']);
        const tasks = allTasks.filter(t => t.project_id === args.project_id);
        return { project, tasks };
      }
      const taskIds = args.task_ids as string[];
      const tasks = (await Promise.all(taskIds.map(id => db.getTask(id)))).filter((t): t is NonNullable<typeof t> => t !== null);
      const projectIds = [...new Set(tasks.filter(t => t.project_id).map(t => t.project_id as string))];
      const projectEntries = await Promise.all(
        projectIds.map(async id => [id, (await db.getProject(id))?.title ?? null])
      );
      const projects: Record<string, string> = Object.fromEntries(projectEntries.filter(([, v]) => v));
      return { tasks, projects };
    }

    // Legacy aliases — kept for backward compatibility
    case 'show_tasks': {
      const taskIds = args.task_ids as string[];
      const tasks = (await Promise.all(taskIds.map(id => db.getTask(id)))).filter((t): t is NonNullable<typeof t> => t !== null);
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
      const allTasks = await db.listTasks(['pending', 'active', 'snoozed']);
      const tasks = allTasks.filter(t => t.project_id === args.project_id);
      return { project, tasks };
    }

    case 'start_session': {
      await db.seedDefaultPreferences();
      const [readyTasks, preferences, lastSessionAt] = await Promise.all([
        db.listReadyTasks(),
        db.getAllPreferences(),
        db.getPreference('last_session_at'),
      ]);

      const returningAfterGap = lastSessionAt
        ? (Date.now() - new Date(lastSessionAt).getTime()) > 7 * 86400000
        : false;

      await db.setPreference('last_session_at', new Date().toISOString());

      return {
        suggested_tasks: readyTasks.slice(0, 3),
        preferences,
        returning_after_gap: returningAfterGap,
        instructions: SESSION_INSTRUCTIONS,
      };
    }

    case 'list_projects': {
      if (args.project_id) {
        const project = await db.getProject(args.project_id as string);
        if (!project) throw new Error('Project not found');
        if (args.include_tasks) {
          const ready_tasks = await db.listReadyTasks(args.project_id as string);
          return { project, ready_tasks };
        }
        return { project };
      }
      const status = (args.status as string) || 'active';
      const projects = await db.listProjects(status);
      return { projects };
    }

    // Legacy alias
    case 'get_project_context': {
      const project = await db.getProject(args.project_id as string);
      if (!project) throw new Error('Project not found');
      const ready_tasks = await db.listReadyTasks(args.project_id as string);
      return { project, ready_tasks };
    }

    case 'list_tasks': {
      if (args.ready_only) {
        const tasks = await db.listReadyTasks(args.project_id as string | undefined);
        return { tasks };
      }
      const statuses = (args.statuses as string[]) || ['pending', 'active'];
      let tasks = await db.listTasks(statuses);
      if (args.project_id) {
        tasks = tasks.filter(t => t.project_id === args.project_id);
      }
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

    // Legacy alias
    case 'get_ready_tasks': {
      const projectId = args.project_id as string | undefined;
      const tasks = await db.listReadyTasks(projectId);
      return { tasks };
    }

    // Legacy: widget may still call get_active_tasks
    case 'get_active_tasks': {
      const sessionId = args.session_id as string | undefined;
      const tasks = await db.getActiveTasks(sessionId);
      return { tasks };
    }

    case 'add_task': {
      const task = await db.addTask({
        title: args.title as string,
        notes: args.notes as string | undefined,
        due_date: args.due_date as string | undefined,
        recurrence: args.recurrence as string | undefined,
        task_type: args.task_type as 'action' | 'plan' | 'recurring' | undefined,
        project_id: args.project_id as string | undefined,
        kickoff_note: args.kickoff_note as string | undefined,
      });
      const log = await db.logAction({ tool_name: 'add_task', task_id: task.id, title: task.title, detail: task.due_date ?? undefined });
      return { ...task, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    // Legacy: widget or older clients may still call activate_task
    case 'activate_task': {
      const task = await db.activateTask(args.task_id as string, args.session_id as string);
      if (!task) throw new Error('Task not found');
      return task;
    }

    case 'complete_task': {
      const result = await db.completeTask(args.task_id as string);
      if (!result) throw new Error('Task not found');
      const log = await db.logAction({
        tool_name: 'complete_task',
        task_id: result.completed.id,
        title: result.completed.title,
        detail: result.next ? `→ recurs ${result.next.due_date}` : undefined,
      });
      return { ...result, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'snooze_task': {
      const task = await db.snoozeTask(args.task_id as string, args.until as string);
      if (!task) throw new Error('Task not found');
      const log = await db.logAction({ tool_name: 'snooze_task', task_id: task.id, title: task.title, detail: args.until as string });
      return { ...task, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'update_task': {
      const { task_id, ...updates } = args as { task_id: string } & Parameters<DB['updateTask']>[1];
      // When reopening via status, also clear snoozed_until for parity with reopen_task
      if (updates.status === 'pending' && updates.snoozed_until === undefined) {
        updates.snoozed_until = null;
      }
      const task = await db.updateTask(task_id, updates);
      if (!task) throw new Error('Task not found');
      const log = await db.logAction({ tool_name: 'update_task', task_id: task.id, title: task.title });
      return { ...task, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    // Legacy alias
    case 'reopen_task': {
      const task = await db.reopenTask(args.task_id as string);
      if (!task) throw new Error('Task not found');
      const log = await db.logAction({ tool_name: 'reopen_task', task_id: task.id, title: task.title });
      return { ...task, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'delete_task': {
      const toDelete = await db.getTask(args.task_id as string);
      if (!toDelete) throw new Error('Task not found');
      const log = await db.logAction({ tool_name: 'delete_task', task_id: toDelete.id, title: toDelete.title });
      await db.deleteTask(toDelete.id);
      return { deleted: true, task_id: toDelete.id, title: toDelete.title, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'create_project': {
      const project = await db.createProject({
        title: args.title as string,
        kickoff_note: args.kickoff_note as string | undefined,
      });

      // Associate any provided task IDs with the new project
      const taskIds = args.task_ids as string[] | undefined;
      if (taskIds && taskIds.length > 0) {
        await Promise.all(
          taskIds.map(id => db.updateTask(id, { project_id: project.id }))
        );
      }

      const log = await db.logAction({ tool_name: 'create_project', title: project.title, detail: taskIds?.length ? `${taskIds.length} tasks` : undefined });
      return { project, linked_task_count: taskIds?.length ?? 0, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'update_project': {
      const { project_id, ...updates } = args;
      const project = await db.updateProject(project_id as string, updates as Parameters<DB['updateProject']>[1]);
      if (!project) throw new Error('Project not found');
      return { project };
    }

    case 'link_tasks': {
      const [fromTask, toTask] = await Promise.all([
        db.getTask(args.from_task_id as string),
        db.getTask(args.to_task_id as string),
      ]);
      await db.linkTasks(
        args.from_task_id as string,
        args.to_task_id as string,
        args.link_type as 'blocks' | 'related' | 'supersedes'
      );
      const fromTitle = fromTask?.title ?? args.from_task_id as string;
      const toTitle = toTask?.title ?? args.to_task_id as string;
      const log = await db.logAction({ tool_name: 'link_tasks', title: `${fromTitle} → ${toTitle}`, detail: args.link_type as string });
      return {
        linked: true,
        from_task_id: args.from_task_id,
        from_task_title: fromTask?.title,
        to_task_id: args.to_task_id,
        to_task_title: toTask?.title,
        link_type: args.link_type,
        action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail },
      };
    }

    case 'update_kickoff_note': {
      const entityType = args.entity_type as 'task' | 'project';
      const entityId = args.entity_id as string;
      const kickoffNote = args.kickoff_note as string;

      if (entityType === 'task') {
        const task = await db.updateTask(entityId, { kickoff_note: kickoffNote });
        if (!task) throw new Error('Task not found');
        return { updated: true, entity_type: 'task', entity_id: entityId };
      } else {
        const project = await db.updateProject(entityId, { kickoff_note: kickoffNote });
        if (!project) throw new Error('Project not found');
        return { updated: true, entity_type: 'project', entity_id: entityId };
      }
    }

    case 'update_preference': {
      await db.setPreference(args.key as string, args.value as string);
      return { updated: true, key: args.key, value: args.value };
    }

    case 'get_action_log': {
      const entries = await db.getActionLog();
      return { entries };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function handleMcpRequest(request: Request, db: DB, env: Env): Promise<Response> {
  if (request.method === 'GET') {
    // Streamable HTTP: GET opens an SSE stream for server-initiated messages.
    return new Response('event: endpoint\ndata: /mcp\n\n', {
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
        serverInfo: { name: 'alongside', version: '1.0.0' },
      });

    case 'tools/list':
      return mcpResponse(body.id, { tools: TOOLS });

    case 'resources/list':
      return mcpResponse(body.id, { resources: UI_RESOURCES });

    case 'resources/read': {
      const params = body.params as { uri: string };
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
        const result = await handleToolCall(params.name, params.arguments || {}, db);
        const toolDef = TOOLS.find(t => t.name === params.name) as { _meta?: Record<string, unknown> } | undefined;
        const meta = toolDef?._meta ? { _meta: toolDef._meta } : {};
        return mcpResponse(body.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          ...meta,
        });
      } catch (e) {
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
