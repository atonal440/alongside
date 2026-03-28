import { DB } from './db';
import type { Env } from './index';
import { signUrl } from './sign';

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

const TOOLS = [
  {
    name: 'list_tasks',
    description: 'Returns tasks filtered by status. Default: pending + active.',
    inputSchema: {
      type: 'object',
      properties: {
        statuses: {
          type: 'array',
          items: { type: 'string', enum: ['pending', 'active', 'done', 'snoozed'] },
          description: 'Filter by these statuses. Defaults to ["pending", "active"].',
        },
      },
    },
  },
  {
    name: 'get_active_tasks',
    description: 'Returns only active tasks for the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Optional session ID to filter by.' },
      },
    },
  },
  {
    name: 'add_task',
    description: 'Creates a new pending task.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title.' },
        notes: { type: 'string', description: 'Optional notes.' },
        due_date: { type: 'string', description: 'Optional ISO 8601 date (e.g. 2026-03-28).' },
        recurrence: { type: 'string', description: 'Optional iCal RRULE (e.g. FREQ=WEEKLY;INTERVAL=1).' },
      },
      required: ['title'],
    },
  },
  {
    name: 'activate_task',
    description: 'Sets a task to active status and records the session ID.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to activate.' },
        session_id: { type: 'string', description: 'The current session ID.' },
      },
      required: ['task_id', 'session_id'],
    },
  },
  {
    name: 'complete_task',
    description: 'Marks a task as done. If it has a recurrence rule, creates the next occurrence automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to complete.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'snooze_task',
    description: 'Snoozes a task until a given date.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to snooze.' },
        until: { type: 'string', description: 'ISO 8601 date to snooze until.' },
      },
      required: ['task_id', 'until'],
    },
  },
  {
    name: 'update_task',
    description: 'Edits a task\'s title, notes, due date, or recurrence.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to update.' },
        title: { type: 'string' },
        notes: { type: 'string' },
        due_date: { type: 'string' },
        recurrence: { type: 'string' },
      },
      required: ['task_id'],
    },
  },
];

async function handleToolCall(name: string, args: Record<string, unknown>, db: DB, baseUrl: string, secret: string) {
  switch (name) {
    case 'list_tasks': {
      const statuses = (args.statuses as string[]) || ['pending', 'active'];
      return await db.listTasks(statuses);
    }

    case 'get_active_tasks': {
      const sessionId = args.session_id as string | undefined;
      const tasks = await db.getActiveTasks(sessionId);
      const path = `/ui/active${sessionId ? `?session=${sessionId}` : ''}`;
      const signedUrl = await signUrl(baseUrl, path, secret);
      return {
        tasks,
        ui: { type: 'iframe', url: signedUrl },
      };
    }

    case 'add_task': {
      return await db.addTask({
        title: args.title as string,
        notes: args.notes as string | undefined,
        due_date: args.due_date as string | undefined,
        recurrence: args.recurrence as string | undefined,
      });
    }

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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function handleMcpRequest(request: Request, db: DB, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await request.json<McpRequest>();
  const baseUrl = new URL(request.url).origin;

  switch (body.method) {
    case 'initialize':
      return mcpResponse(body.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'alongside', version: '1.0.0' },
      });

    case 'tools/list':
      return mcpResponse(body.id, { tools: TOOLS });

    case 'tools/call': {
      const params = body.params as { name: string; arguments?: Record<string, unknown> };
      try {
        const result = await handleToolCall(params.name, params.arguments || {}, db, baseUrl, env.AUTH_TOKEN);
        return mcpResponse(body.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return mcpError(body.id, -32000, msg);
      }
    }

    // Notifications have no id and expect no response, but over HTTP we must return something
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
        headers: { 'Content-Type': 'application/json' },
      });

    default:
      return mcpError(body.id, -32601, `Method not found: ${body.method}`);
  }
}
