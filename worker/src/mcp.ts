import { DB } from './db';
import type { Task, Project } from '@shared/types';
import type { Env } from './index';
import { getAppHtml, getActionLogHtml } from './app-ui';
import { materializeDueDuties, dateAtMidnightInTz, todayInTz, getUserTimezone, computeNextFire, isValidTimezone } from './duties';

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

function isValidDutyOffsetDays(value: unknown): value is number {
  return Number.isInteger(value) && Number.isFinite(value);
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

const SESSION_INSTRUCTIONS = `
You are the Alongside task assistant.

OPENING: Lead with readiness, not urgency. If focused_tasks is non-empty, those are already front-of-mind — start there. Otherwise start from suggested_tasks — "what are you most ready to start?"

FOCUS: Use focus_task to put 1-2 tasks front-of-mind. Focus decays automatically (default 3 hours) so there's nothing to clean up. Offer to focus tasks at session start if none are focused.

TONE: Orient, don't audit. Never comment on gaps, overdue counts, or task neglect. Due dates are facts, not judgments.

GAP: If returning_after_gap is true, offer a quick triage before suggesting tasks.

URGENCY: Only surface urgency if urgency_visibility is "show". Default sort is readiness.

EMPTY STATE: No tasks? Offer a brain dump to get started.

KICKOFF NOTES: If a task lacks a kickoff_note, ask one orienting question and save the answer before starting. For plan tasks, run a planning conversation instead.

STRUCTURE: If interruption_style is "proactive", offer to capture tasks, links, or kickoff notes noticed mid-conversation. Don't restructure without confirmation.

LINKS: When you hear dependency language ("need X before Y"), offer to link_tasks.

SESSION CLOSE: If session_log is "ask_at_end", offer to write one. If "auto_generate", write it. Update kickoff notes for tasks with clearer starting points.

PREFERENCES: When the user states a preference, call update_preference immediately — no confirmation needed.
`.trim();

const TOOLS = [
  {
    name: 'start_session',
    description: 'Call at the start of every session. Returns ready tasks, preferences, and session instructions.',
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
    description: 'Returns unblocked tasks sorted by readiness score. Prefer over list_tasks when asked what to work on.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Filter to a specific project.' },
      },
    },
  },
  {
    name: 'add_task',
    description: 'Creates a one-shot task in pending status. Use add_duty for anything that should repeat. Set task_type "plan" for tasks needing a planning conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short, actionable title.' },
        notes: { type: 'string', description: 'Additional context or links.' },
        due_date: { type: 'string', description: 'ISO 8601 date. Omit for undated.' },
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
    description: 'Marks a task done. For tasks materialized from a duty, the duty\'s schedule advances independently — completing this task does not create the next instance.',
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
    name: 'defer_task',
    description: 'Hides a task. Use kind="until" with an ISO date to defer temporarily, or kind="someday" to defer indefinitely.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        kind: { type: 'string', enum: ['until', 'someday'], description: '"until" reappears at the given date; "someday" hides indefinitely.' },
        until: { type: 'string', description: 'ISO 8601 date. Required when kind="until".' },
      },
      required: ['task_id', 'kind'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'update_task',
    description: 'Updates fields on an existing task. Only included fields change. To change a recurring task\'s schedule, edit the parent duty via update_duty (look up duty_id on the task).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        title: { type: 'string' },
        notes: { type: 'string', description: 'Replaces existing notes.' },
        status: { type: 'string', enum: ['pending'], description: 'Use complete_task for "done", defer_task to defer, focus_task to put front-of-mind. Only valid value is "pending" (to reset a task).' },
        due_date: { type: 'string', description: 'ISO 8601 date.' },
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
        task_id: { type: 'string' },
        hours: { type: 'number', description: 'How long to keep focus. Defaults to 3.' },
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
        from_task_id: { type: 'string' },
        to_task_id: { type: 'string' },
        link_type: { type: 'string', enum: ['blocks', 'related'], description: 'Defaults to "blocks".' },
      },
      required: ['from_task_id', 'to_task_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'add_duty',
    description: 'Creates a recurring task template that materializes into real tasks on a schedule. Use this for anything that should repeat. Replaces task-level recurrence.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title used for each materialized task.' },
        notes: { type: 'string', description: 'Carried onto each materialized task.' },
        kickoff_note: { type: 'string', description: 'Re-entry note for each materialized task. Auto-updated from session_log on completion.' },
        recurrence: { type: 'string', description: 'iCal RRULE. Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY (+INTERVAL).' },
        first_fire_date: { type: 'string', description: 'YYYY-MM-DD. The first day this duty should materialize a task. Defaults to today (user tz).' },
        due_offset_days: { type: 'number', description: 'Days between fire date and the materialized task\'s due_date. Defaults to 0.' },
        task_type: { type: 'string', enum: ['action', 'plan'] },
        project_id: { type: 'string' },
      },
      required: ['title', 'recurrence'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'list_duties',
    description: 'Lists all duties (active and paused). Each duty\'s next_fire_at indicates when it will next materialize.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_duty',
    description: 'Updates a duty\'s template fields or schedule. Editing recurrence does not change next_fire_at — pass next_fire_at explicitly (or first_fire_date) to reschedule.',
    inputSchema: {
      type: 'object',
      properties: {
        duty_id: { type: 'string' },
        title: { type: 'string' },
        notes: { type: 'string' },
        kickoff_note: { type: 'string' },
        recurrence: { type: 'string' },
        first_fire_date: { type: 'string', description: 'YYYY-MM-DD. Replaces next_fire_at with midnight on this date in user tz.' },
        due_offset_days: { type: 'number' },
        task_type: { type: 'string', enum: ['action', 'plan'] },
        project_id: { type: 'string' },
        active: { type: 'boolean', description: 'false to pause without deleting.' },
      },
      required: ['duty_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'delete_duty',
    description: 'Permanently deletes a duty. Tasks already materialized from it are kept (their duty_id is cleared).',
    inputSchema: {
      type: 'object',
      properties: {
        duty_id: { type: 'string' },
      },
      required: ['duty_id'],
    },
    _meta: uiMeta(ACTION_LOG_URI),
  },
  {
    name: 'update_preference',
    description: 'Sets a user preference. Call immediately when the user states one.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: ['sort_by', 'urgency_visibility', 'kickoff_nudge', 'session_log', 'interruption_style', 'planning_prompt', 'timezone'] },
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
    case 'show_tasks': {
      await materializeDueDuties(db, new Date().toISOString());
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
      await materializeDueDuties(db, new Date().toISOString());
      const project = await db.getProject(args.project_id as string);
      if (!project) throw new Error('Project not found');
      const allTasks = await db.listAllTasks(['pending']);
      const tasks = allTasks.filter(t => t.project_id === args.project_id);
      return { project, tasks };
    }

    case 'start_session': {
      await db.seedDefaultPreferences();
      await materializeDueDuties(db, new Date().toISOString());
      const [readyTasks, focusedTasks, preferences, lastSessionAt] = await Promise.all([
        db.listReadyTasks(),
        db.listFocusedTasks(),
        db.getAllPreferences(),
        db.getPreference('last_session_at'),
      ]);

      const returningAfterGap = lastSessionAt
        ? (Date.now() - new Date(lastSessionAt).getTime()) > 7 * 86400000
        : false;

      await db.setPreference('last_session_at', new Date().toISOString());

      return {
        focused_tasks: focusedTasks,
        suggested_tasks: readyTasks.slice(0, 3),
        preferences,
        returning_after_gap: returningAfterGap,
        instructions: SESSION_INSTRUCTIONS,
      };
    }

    case 'list_projects': {
      const status = ((args.status as string) || 'active') as Project['status'];
      const projects = await db.listProjects(status);
      return { projects };
    }

    case 'list_tasks': {
      await materializeDueDuties(db, new Date().toISOString());
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
      await materializeDueDuties(db, new Date().toISOString());
      const projectId = args.project_id as string | undefined;
      const tasks = await db.listReadyTasks(projectId);
      return { tasks };
    }

    case 'add_task': {
      const task = await db.addTask({
        title: args.title as string,
        notes: args.notes as string | undefined,
        due_date: args.due_date as string | undefined,
        recurrence: args.recurrence as string | undefined,
        task_type: args.task_type as 'action' | 'plan' | undefined,
        project_id: args.project_id as string | undefined,
        kickoff_note: args.kickoff_note as string | undefined,
      });
      const log = await db.logAction({ tool_name: 'add_task', task_id: task.id, title: task.title, detail: task.due_date ?? undefined });
      return { ...task, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'complete_task': {
      await materializeDueDuties(db, new Date().toISOString());
      const result = await db.completeTask(args.task_id as string);
      if (!result) throw new Error('Task not found');
      const log = await db.logAction({
        tool_name: 'complete_task',
        task_id: result.completed.id,
        title: result.completed.title,
      });
      return { ...result, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'defer_task': {
      const kind = args.kind as 'until' | 'someday';
      if (kind !== 'until' && kind !== 'someday') throw new Error('kind must be "until" or "someday"');
      const until = args.until as string | undefined;
      if (kind === 'until' && !until) throw new Error('until is required when kind="until"');
      const task = await db.deferTask(args.task_id as string, kind, until ?? null);
      if (!task) throw new Error('Task not found');
      const detail = kind === 'someday' ? 'someday' : (until ?? '');
      const log = await db.logAction({ tool_name: 'defer_task', task_id: task.id, title: task.title, detail });
      return { ...task, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'update_task': {
      const { task_id, ...updates } = args;
      const task = await db.updateTask(task_id as string, updates as Parameters<DB['updateTask']>[1]);
      if (!task) throw new Error('Task not found');
      const log = await db.logAction({ tool_name: 'update_task', task_id: task.id, title: task.title });
      return { ...task, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'reopen_task': {
      const task = await db.reopenTask(args.task_id as string);
      if (!task) throw new Error('Task not found');
      const log = await db.logAction({ tool_name: 'reopen_task', task_id: task.id, title: task.title });
      return { ...task, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'focus_task': {
      const hours = (args.hours as number) || 3;
      const focusedUntil = new Date(Date.now() + hours * 3600000).toISOString();
      const task = await db.updateTask(args.task_id as string, { focused_until: focusedUntil });
      if (!task) throw new Error('Task not found');
      const log = await db.logAction({ tool_name: 'focus_task', task_id: task.id, title: task.title, detail: `${hours}h` });
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
        notes: args.notes as string | undefined,
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

    case 'get_project_context': {
      const project = await db.getProject(args.project_id as string);
      if (!project) throw new Error('Project not found');
      const ready_tasks = await db.listReadyTasks(args.project_id as string);
      return { project, ready_tasks };
    }

    case 'update_project': {
      const { project_id, ...updates } = args;
      const project = await db.updateProject(project_id as string, updates as Parameters<DB['updateProject']>[1]);
      if (!project) throw new Error('Project not found');
      const log = await db.logAction({ tool_name: 'update_project', title: project.title });
      return { ...project, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'delete_project': {
      const toDelete = await db.getProject(args.project_id as string);
      if (!toDelete) throw new Error('Project not found');
      const log = await db.logAction({ tool_name: 'delete_project', title: toDelete.title });
      await db.deleteProject(toDelete.id);
      return { deleted: true, project_id: toDelete.id, title: toDelete.title, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'link_tasks': {
      const linkType = (args.link_type as string) || 'blocks';
      const [fromTask, toTask] = await Promise.all([
        db.getTask(args.from_task_id as string),
        db.getTask(args.to_task_id as string),
      ]);
      await db.linkTasks(
        args.from_task_id as string,
        args.to_task_id as string,
        linkType as 'blocks' | 'related'
      );
      const fromTitle = fromTask?.title ?? args.from_task_id as string;
      const toTitle = toTask?.title ?? args.to_task_id as string;
      const log = await db.logAction({ tool_name: 'link_tasks', title: `${fromTitle} → ${toTitle}`, detail: linkType });
      return {
        linked: true,
        from_task_id: args.from_task_id,
        from_task_title: fromTask?.title,
        to_task_id: args.to_task_id,
        to_task_title: toTask?.title,
        link_type: linkType,
        action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail },
      };
    }

    case 'unlink_tasks': {
      const unlinkType = (args.link_type as string) || 'blocks';
      await db.unlinkTasks(args.from_task_id as string, args.to_task_id as string, unlinkType as 'blocks' | 'related');
      const log = await db.logAction({ tool_name: 'unlink_tasks', title: 'Unlinked', detail: `${args.from_task_id} → ${args.to_task_id}` });
      return { unlinked: true, from_task_id: args.from_task_id, to_task_id: args.to_task_id, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'add_duty': {
      const tz = await getUserTimezone(db);
      const today = todayInTz(tz);
      const firstFireDate = (args.first_fire_date as string | undefined) ?? today;
      const nextFireAt = dateAtMidnightInTz(firstFireDate, tz);
      const recurrence = args.recurrence as string;
      if (args.due_offset_days !== undefined && !isValidDutyOffsetDays(args.due_offset_days)) {
        throw new Error('due_offset_days must be an integer');
      }
      // Validate the RRULE up front so a typo doesn't silently pause the duty
      // on its first cron tick.
      if (!computeNextFire(recurrence, nextFireAt, tz)) {
        throw new Error(`Unsupported recurrence "${recurrence}". Use FREQ=DAILY|WEEKLY|MONTHLY|YEARLY (+INTERVAL).`);
      }
      const duty = await db.addDuty({
        title: args.title as string,
        notes: args.notes as string | undefined,
        kickoff_note: args.kickoff_note as string | undefined,
        task_type: args.task_type as 'action' | 'plan' | undefined,
        project_id: args.project_id as string | undefined,
        recurrence,
        due_offset_days: args.due_offset_days as number | undefined,
        next_fire_at: nextFireAt,
      });
      const log = await db.logAction({
        tool_name: 'add_duty',
        title: duty.title,
        detail: `${duty.recurrence} from ${firstFireDate}`,
      });
      return { ...duty, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'list_duties': {
      await materializeDueDuties(db, new Date().toISOString());
      const duties = await db.listDuties();
      return { duties };
    }

    case 'update_duty': {
      const { duty_id, first_fire_date, ...rest } = args as Record<string, unknown> & { duty_id: string; first_fire_date?: string };
      const updates: Parameters<DB['updateDuty']>[1] = { ...rest } as Parameters<DB['updateDuty']>[1];
      if (updates.due_offset_days !== undefined && !isValidDutyOffsetDays(updates.due_offset_days)) {
        throw new Error('due_offset_days must be an integer');
      }
      if (typeof first_fire_date === 'string' && first_fire_date.length > 0) {
        const tz = await getUserTimezone(db);
        updates.next_fire_at = dateAtMidnightInTz(first_fire_date, tz);
      }
      if (typeof updates.recurrence === 'string') {
        const tz = await getUserTimezone(db);
        const probe = updates.next_fire_at ?? (await db.getDuty(duty_id))?.next_fire_at;
        if (probe && !computeNextFire(updates.recurrence, probe, tz)) {
          throw new Error(`Unsupported recurrence "${updates.recurrence}".`);
        }
      }
      const duty = await db.updateDuty(duty_id, updates);
      if (!duty) throw new Error('Duty not found');
      const log = await db.logAction({ tool_name: 'update_duty', title: duty.title });
      return { ...duty, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'delete_duty': {
      const toDelete = await db.getDuty(args.duty_id as string);
      if (!toDelete) throw new Error('Duty not found');
      const log = await db.logAction({ tool_name: 'delete_duty', title: toDelete.title });
      await db.deleteDuty(toDelete.id);
      return { deleted: true, duty_id: toDelete.id, title: toDelete.title, action_log_entry: { tool_name: log.tool_name, title: log.title, detail: log.detail } };
    }

    case 'update_preference': {
      if (args.key === 'timezone') {
        if (typeof args.value !== 'string') {
          throw new Error('timezone must be an IANA timezone string.');
        }
        if (!isValidTimezone(args.value)) {
          throw new Error(`Unsupported timezone "${args.value}". Use an IANA timezone like "America/Los_Angeles".`);
        }
      }
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
