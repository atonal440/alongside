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

const TOOLS = [
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
    _meta: uiMeta(TASK_DASHBOARD_URI),
  },
  {
    name: 'add_task',
    description: 'Creates a new task in pending status. Use when the user mentions something they need to do, wants to remember, or asks you to track. For recurring tasks, set both due_date (first occurrence) and recurrence (the pattern). Completing a recurring task automatically creates the next occurrence.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short, actionable task title.' },
        notes: { type: 'string', description: 'Additional context, details, or links.' },
        due_date: { type: 'string', description: 'When it\'s due, as ISO 8601 date (e.g. 2026-03-28). Omit for undated tasks.' },
        recurrence: { type: 'string', description: 'iCal RRULE for repeating tasks. Examples: FREQ=DAILY, FREQ=WEEKLY;INTERVAL=2, FREQ=MONTHLY, FREQ=YEARLY. Requires due_date to be set.' },
      },
      required: ['title'],
    },
    _meta: uiMeta(TASK_DASHBOARD_URI),
  },
  {
    name: 'complete_task',
    description: 'Marks a task as done. If the task has a recurrence rule, automatically creates the next occurrence with the updated due date. The response includes the completed task and, if recurring, the newly created next task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID (e.g. t_Ab12x).' },
      },
      required: ['task_id'],
    },
    _meta: uiMeta(TASK_DASHBOARD_URI, { visibility: ['app'] }),
  },
  {
    name: 'snooze_task',
    description: 'Postpones a task so it disappears from active lists until the given date. Use when the user says "not now", "remind me later", "deal with this next week", etc. The task status changes to snoozed and reappears when the snooze date arrives.',
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
    description: 'Edits one or more fields on an existing task. Use to rename, add notes, change the due date, or modify the recurrence pattern. Only the fields you include will be changed; omitted fields stay as-is.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID (e.g. t_Ab12x).' },
        title: { type: 'string', description: 'New title.' },
        notes: { type: 'string', description: 'New notes (replaces existing).' },
        due_date: { type: 'string', description: 'New due date (ISO 8601).' },
        recurrence: { type: 'string', description: 'New recurrence rule (iCal RRULE).' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'delete_task',
    description: 'Permanently removes a task. Use when the user wants to get rid of a task entirely, not just complete it. Cannot be undone. Prefer complete_task for tasks that were actually done.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID (e.g. t_Ab12x).' },
      },
      required: ['task_id'],
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
      const task = await db.updateTask(task_id as string, updates as { title?: string; notes?: string; due_date?: string; recurrence?: string });
      if (!task) throw new Error('Task not found');
      return task;
    }

    case 'delete_task': {
      const deleted = await db.deleteTask(args.task_id as string);
      if (!deleted) throw new Error('Task not found');
      return { deleted: true, task_id: args.task_id };
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
