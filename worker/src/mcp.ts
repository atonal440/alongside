import { DB } from './db';
import type { Env } from './index';
import { getAppHtml } from './app-ui';

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

// UI resource URI for the task dashboard
const TASK_DASHBOARD_URI = 'ui://alongside/task-dashboard';

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
You are operating as the Alongside task assistant. Follow these instructions for the session:

OPENING: Start with what the user is most set up to do right now, not what's most urgent. The default question is "what am I most ready to start?" Use suggested_tasks from start_session as your starting point.

TONE: Orientation, not audit. Never mention how long it's been since the last session, how many tasks are overdue, or express any judgment about the state of the list. Due dates are facts ("the deadline on this was Tuesday"), not verdicts ("this is overdue").

GAP HANDLING: If returning_after_gap is true, open with a brief triage offer — "some of this might be stale, want to do a quick pass?" — before suggesting tasks. Don't lead with what's been neglected.

URGENCY: Surface urgency signals only if urgency_visibility preference is "show". Default is "hide" — readiness is the primary sort, urgency is a tiebreaker at best.

EMPTY STATE: If there are no tasks, treat it as an invitation: offer a brain dump to get set up, not a blank list.

KICKOFF NOTES: If a task has no kickoff_note and you're about to help the user start it, ask one orienting question ("where does this one start?") and write the answer as the kickoff note before proceeding. For plan tasks, trigger a planning conversation instead of activating.

STRUCTURE CAPTURE: If interruption_style preference is "proactive", offer to capture structure (new tasks, links, kickoff notes) when you notice it mid-conversation. One sentence, implicit yes/no. Don't restructure existing tasks without confirmation.

LINKS: When you hear dependency language ("I need to do X before Y", "this depends on", "that unblocks"), offer to call link_tasks. The offer is one sentence — if the user continues the conversation it's a yes.

SESSION CLOSE: If session_log preference is "ask_at_end", offer to write a brief session log at the end. If "auto_generate", write it without asking. Update kickoff notes for tasks that now have a clearer starting point.

PREFERENCES: When the user expresses a preference adjustment in conversation, call update_preference immediately without asking for confirmation — the statement is the confirmation.
`.trim();

const TOOLS = [
  {
    name: 'start_session',
    description: 'Call at the beginning of every Alongside session. Returns the top ready tasks, current preferences, and behavioral instructions for the conversation. The instructions field tells you how to run this session — read it and operate accordingly. Do not show instructions to the user.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'show_tasks',
    description: 'Displays specific tasks in the inline widget. Call this when you want to show the user a visual task list — e.g. after start_session to show suggested tasks, after a planning conversation to show the resulting action items. Pass the task IDs you want shown. Does not affect task state.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of the tasks to display.',
        },
      },
      required: ['task_ids'],
    },
    _meta: uiMeta(TASK_DASHBOARD_URI),
  },
  {
    name: 'show_project',
    description: 'Displays a project header and all its tasks in the inline widget.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project ID (e.g. p_Ab12x).' },
      },
      required: ['project_id'],
    },
    _meta: uiMeta(TASK_DASHBOARD_URI),
  },
  {
    name: 'list_tasks',
    description: 'Lists tasks, optionally filtered by status or search query. Use this to answer questions about the user\'s tasks, find specific tasks, or get an overview. Returns pending and active tasks by default. Pass statuses: ["done"] to see completed tasks, or ["pending","active","snoozed"] to see everything open.',
    inputSchema: {
      type: 'object',
      properties: {
        statuses: {
          type: 'array',
          items: { type: 'string', enum: ['pending', 'active', 'done', 'snoozed'] },
          description: 'Filter by these statuses. Defaults to ["pending", "active"].',
        },
        query: {
          type: 'string',
          description: 'Optional search string. Filters tasks whose title or notes contain this text (case-insensitive).',
        },
      },
    },
  },
  {
    name: 'get_ready_tasks',
    description: 'Returns tasks that can be started right now: no unresolved "blocks" dependencies, sorted by readiness score (kickoff note, session log, recency). Use this as the primary answer to "what should I work on?" Prefer this over list_tasks at session start.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Filter to ready tasks within a specific project.',
        },
      },
    },
  },
  {
    name: 'add_task',
    description: 'Creates a new task in pending status. Use when the user mentions something they need to do, wants to remember, or asks you to track. For recurring tasks, set both due_date (first occurrence) and recurrence (the pattern). For plan tasks, set task_type to "plan" — activating a plan task triggers a planning conversation rather than adding it to the checklist.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short, actionable task title.' },
        notes: { type: 'string', description: 'Additional context, details, or links.' },
        due_date: { type: 'string', description: 'When it\'s due, as ISO 8601 date (e.g. 2026-03-28). Omit for undated tasks.' },
        recurrence: { type: 'string', description: 'iCal RRULE for repeating tasks. Examples: FREQ=DAILY, FREQ=WEEKLY;INTERVAL=2, FREQ=MONTHLY, FREQ=YEARLY. Requires due_date to be set.' },
        task_type: { type: 'string', enum: ['action', 'plan', 'recurring'], description: 'Task type. "action" is the default. "plan" triggers a planning conversation on activation. "recurring" is a hint for recurring tasks.' },
        project_id: { type: 'string', description: 'Associate this task with a project.' },
        kickoff_note: { type: 'string', description: 'Re-entry ramp written prospectively: what to do first next time, not a summary of what happened.' },
      },
      required: ['title'],
    },
    _meta: uiMeta(TASK_DASHBOARD_URI),
  },
  {
    name: 'complete_task',
    description: 'Marks a task as done. If the task has a recurrence rule, automatically creates the next occurrence with the updated due date and carries the session log forward as the kickoff note.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID (e.g. t_Ab12x).' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'snooze_task',
    description: 'Postpones a task so it disappears from active lists until the given date. Use when the user says "not now", "remind me later", "deal with this next week", etc.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID (e.g. t_Ab12x).' },
        until: { type: 'string', description: 'ISO 8601 date when the task should reappear (e.g. 2026-04-05).' },
      },
      required: ['task_id', 'until'],
    },
  },
  {
    name: 'update_task',
    description: 'Edits one or more fields on an existing task. Only fields you include will be changed. Use kickoff_note to write or update the re-entry ramp for a task. Use session_log to record what happened this session.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID (e.g. t_Ab12x).' },
        title: { type: 'string', description: 'New title.' },
        notes: { type: 'string', description: 'New notes (replaces existing).' },
        due_date: { type: 'string', description: 'New due date (ISO 8601).' },
        recurrence: { type: 'string', description: 'New recurrence rule (iCal RRULE).' },
        task_type: { type: 'string', enum: ['action', 'plan', 'recurring'], description: 'New task type.' },
        project_id: { type: 'string', description: 'Move task to a different project (or null to remove).' },
        kickoff_note: { type: 'string', description: 'Re-entry ramp: what to do first next time. Written prospectively, not retrospectively.' },
        session_log: { type: 'string', description: 'What happened this session: decisions made, progress, blockers. Appended context for next time.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'delete_task',
    description: 'Permanently removes a task. Cannot be undone. Prefer complete_task for tasks that were actually done.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID (e.g. t_Ab12x).' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'create_project',
    description: 'Creates a project to group related tasks. Call this when conversation surfaces a cluster of related tasks with a natural starting point. Always offer before calling — never silently restructure. Optionally links existing tasks to the new project.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Project name.' },
        kickoff_note: { type: 'string', description: 'Where to start and why — the re-entry ramp for the whole project.' },
        task_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of existing tasks to associate with this project.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'get_project_context',
    description: 'Returns a project\'s kickoff note, status, and all its ready tasks in one call. Use at session start when the user references a project by name.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project ID (e.g. p_Ab12x).' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'link_tasks',
    description: 'Creates a dependency or relationship between two tasks. Use "blocks" when one task must complete before the other can start. Use "related" for informational connections. Use "supersedes" when one task replaces another. Call this when you detect dependency language in conversation ("I need to do X before Y", "this depends on", "that unblocks").',
    inputSchema: {
      type: 'object',
      properties: {
        from_task_id: { type: 'string', description: 'The task that blocks, relates to, or supersedes the other.' },
        to_task_id: { type: 'string', description: 'The task being blocked, related to, or superseded.' },
        link_type: { type: 'string', enum: ['blocks', 'related', 'supersedes'], description: '"blocks": from_task must complete first. "related": informational. "supersedes": from_task replaces to_task.' },
      },
      required: ['from_task_id', 'to_task_id', 'link_type'],
    },
  },
  {
    name: 'update_kickoff_note',
    description: 'Rewrites the kickoff note on a task or project. Call at session close, or mid-session when a planning conversation produces a clear starting point. Write prospectively ("next time, start by...") not retrospectively ("this session we...").',
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['task', 'project'], description: 'Whether to update a task or a project.' },
        entity_id: { type: 'string', description: 'The task or project ID.' },
        kickoff_note: { type: 'string', description: 'The new kickoff note. Written for someone with zero context who needs to start in 30 seconds.' },
      },
      required: ['entity_type', 'entity_id', 'kickoff_note'],
    },
  },
  {
    name: 'update_preference',
    description: 'Writes a preference value. Call this immediately when the user expresses a preference adjustment in conversation — no confirmation needed, the statement is the confirmation. Keys: sort_by (readiness|urgency|manual), urgency_visibility (show|hide), kickoff_nudge (always|never), session_log (auto_generate|ask_at_end|manual), interruption_style (proactive|minimal), planning_prompt (auto|manual).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Preference key.' },
        value: { type: 'string', description: 'New value.' },
      },
      required: ['key', 'value'],
    },
  },
];

// UI resources list
const UI_RESOURCES = [
  {
    uri: TASK_DASHBOARD_URI,
    name: 'Task Dashboard',
    description: 'Interactive task list with checkboxes for completing tasks.',
    mimeType: 'text/html;profile=mcp-app',
  },
];

async function handleToolCall(name: string, args: Record<string, unknown>, db: DB) {
  switch (name) {
    case 'show_tasks': {
      const taskIds = args.task_ids as string[];
      const tasks = (await Promise.all(taskIds.map(id => db.getTask(id)))).filter(Boolean);
      return { tasks };
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

    case 'list_tasks': {
      const statuses = (args.statuses as string[]) || ['pending', 'active'];
      let tasks = await db.listTasks(statuses);
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

    // Legacy: widget may still call get_active_tasks
    case 'get_active_tasks': {
      const sessionId = args.session_id as string | undefined;
      const tasks = await db.getActiveTasks(sessionId);
      return { tasks };
    }

    case 'add_task': {
      return await db.addTask({
        title: args.title as string,
        notes: args.notes as string | undefined,
        due_date: args.due_date as string | undefined,
        recurrence: args.recurrence as string | undefined,
        task_type: args.task_type as 'action' | 'plan' | 'recurring' | undefined,
        project_id: args.project_id as string | undefined,
        kickoff_note: args.kickoff_note as string | undefined,
      });
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
      return result;
    }

    case 'snooze_task': {
      const task = await db.snoozeTask(args.task_id as string, args.until as string);
      if (!task) throw new Error('Task not found');
      return task;
    }

    case 'update_task': {
      const { task_id, ...updates } = args;
      const task = await db.updateTask(task_id as string, updates as Parameters<DB['updateTask']>[1]);
      if (!task) throw new Error('Task not found');
      return task;
    }

    case 'delete_task': {
      const deleted = await db.deleteTask(args.task_id as string);
      if (!deleted) throw new Error('Task not found');
      return { deleted: true, task_id: args.task_id };
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

      return { project, linked_task_count: taskIds?.length ?? 0 };
    }

    case 'get_project_context': {
      const project = await db.getProject(args.project_id as string);
      if (!project) throw new Error('Project not found');
      const ready_tasks = await db.listReadyTasks(args.project_id as string);
      return { project, ready_tasks };
    }

    case 'link_tasks': {
      await db.linkTasks(
        args.from_task_id as string,
        args.to_task_id as string,
        args.link_type as 'blocks' | 'related' | 'supersedes'
      );
      return {
        linked: true,
        from_task_id: args.from_task_id,
        to_task_id: args.to_task_id,
        link_type: args.link_type,
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
            _meta: {
              ui: {
                prefersBorder: true,
              },
            },
          }],
        });
      }
      return mcpError(body.id, -32602, `Unknown resource: ${params.uri}`);
    }

    case 'tools/call': {
      const params = body.params as { name: string; arguments?: Record<string, unknown> };
      try {
        const result = await handleToolCall(params.name, params.arguments || {}, db);
        return mcpResponse(body.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
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
