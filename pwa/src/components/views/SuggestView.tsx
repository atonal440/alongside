import { useEffect, useState } from 'react';
import { useAppState } from '../../hooks/useAppState';
import { suggestQueue } from '../../utils/suggestQueue';
import { EmptyState } from '../common/EmptyState';
import { SearchBar } from '../common/SearchBar';
import { TaskCard } from '../task/TaskCard';
import { DeferMenu, type DeferChoice } from '../task/DeferMenu';
import { createTaskAction, completeTaskAction, deferTaskAction, focusTaskAction, clearDeferAction, updateTaskAction } from '../../context/actions';
import { pushNav } from '../../hooks/useHistory';
import { deriveTaskFlow, type TaskFlowActionId } from '../../utils/taskFlow';
import type { Project, Task, TaskLink } from '../../types';

export function SuggestView() {
  const { state, dispatch } = useAppState();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [deferOpenForTaskId, setDeferOpenForTaskId] = useState<string | null>(null);
  const today = new Date().toISOString().split('T')[0];
  const queue = suggestQueue(state.tasks, today, state.links);
  const config = { apiBase: state.apiBase, authToken: state.authToken };
  const selectedTask = selectedTaskId ? queue.find(t => t.id === selectedTaskId) : null;
  const task = selectedTask ?? queue[0];
  const flow = task ? deriveTaskFlow(task, {
    today,
    projects: state.projects,
    links: state.links,
    tasks: state.tasks,
    surface: 'focus',
    selected: true,
  }) : null;
  const focused = flow?.mode === 'focused';

  useEffect(() => {
    if (selectedTaskId && !queue.some(t => t.id === selectedTaskId)) {
      setSelectedTaskId(null);
    }
  }, [queue, selectedTaskId]);

  async function handleAdd(title: string) {
    await createTaskAction(title, config, dispatch);
  }

  async function handleDone(id: string) {
    const msg = await completeTaskAction(id, config, dispatch);
    if (msg) dispatch({ type: 'SET_TOAST', message: msg });
  }

  async function handleStart(id: string) {
    await focusTaskAction(id, config, dispatch);
    setSelectedTaskId(id);
  }

  async function handleUnfocus(id: string) {
    await updateTaskAction(id, { focused_until: null }, config, dispatch);
  }

  async function handleDefer(id: string, choice: DeferChoice) {
    if (choice.kind === 'someday') {
      await deferTaskAction(id, 'someday', null, config, dispatch);
    } else {
      await deferTaskAction(id, 'until', choice.untilIso, config, dispatch);
    }
    setSelectedTaskId(null);
    setDeferOpenForTaskId(null);
  }

  async function handleReopen(id: string) {
    await clearDeferAction(id, config, dispatch);
  }

  function handleEdit(id: string) {
    dispatch({ type: 'SET_EDITING', id });
    pushNav({ view: state.currentView, detailId: null, editId: id });
  }

  function handlePickQueueTask(id: string) {
    setSelectedTaskId(id);
  }

  function handleOpenTask(id: string) {
    dispatch({ type: 'SET_DETAIL', id });
    pushNav({ view: state.currentView, detailId: id, editId: null });
  }

  function handleOpenProject(id: string) {
    dispatch({ type: 'SET_PROJECT_FILTER', id });
    dispatch({ type: 'SET_VIEW', view: 'all' });
    pushNav({ view: 'all', detailId: null, editId: null });
  }

  function handleCommandAction(id: string, action: TaskFlowActionId) {
    switch (action) {
      case 'focus':
        void handleStart(id);
        break;
      case 'complete':
        void handleDone(id);
        break;
      case 'defer':
        // The DeferMenu is rendered alongside the focused card and only
        // appears when deferOpenForTaskId === task.id (the displayed task).
        // When defer is triggered for a different queue task via the
        // command palette, switch the focused card to that task first so
        // the menu has somewhere to render.
        setSelectedTaskId(id);
        setDeferOpenForTaskId(id);
        break;
      case 'reopen':
        void handleReopen(id);
        break;
      case 'edit':
        handleEdit(id);
        break;
      case 'unfocus':
        void handleUnfocus(id);
        break;
      case 'delete':
        break;
    }
  }

  function handleTaskAction(action: TaskFlowActionId) {
    if (!task) return;
    switch (action) {
      case 'defer':
        setDeferOpenForTaskId(task.id);
        break;
      case 'reopen':
        void handleReopen(task.id);
        break;
      case 'focus':
        void handleStart(task.id);
        break;
      case 'complete':
        void handleDone(task.id);
        break;
      case 'unfocus':
        void handleUnfocus(task.id);
        break;
      case 'edit':
        handleEdit(task.id);
        break;
      case 'delete':
        break;
    }
  }

  if (!task || !flow) {
    return (
      <div className="focus-view">
        <section className="main-column">
          <SearchBar
            tasks={state.tasks}
            projects={state.projects}
            onCreateTask={handleAdd}
            onOpenTask={handleOpenTask}
            onOpenProject={handleOpenProject}
            onTaskAction={handleCommandAction}
          />
          <EmptyState message="All clear. Add something with search." />
        </section>
        <QueuePanel queue={[]} currentId={null} today={today} projects={state.projects} links={state.links} tasks={state.tasks} doneToday={0} onPick={handlePickQueueTask} />
      </div>
    );
  }

  return (
    <div className={`focus-view${focused ? ' focused-mode' : ''}`}>
      <section className="main-column">
        <SearchBar
          tasks={state.tasks}
          projects={state.projects}
          onCreateTask={handleAdd}
          onOpenTask={handleOpenTask}
          onOpenProject={handleOpenProject}
          onTaskAction={handleCommandAction}
        />
        <div className={`today-stage ${focused ? 'focused' : 'idle'}`}>
          <div className={`focus-card-wrap ${focused ? 'promoted' : 'docked'}`}>
                <CardContextStrip
                  focused={focused}
                  queueCount={queue.length}
                  dueTodayCount={state.tasks.filter(t => t.status !== 'done' && t.due_date === today).length}
                />
                    <TaskCard
                      flow={flow}
                      onAction={handleTaskAction}
                    />
                    {deferOpenForTaskId === task.id && (
                      <DeferMenu
                        onChoose={(choice) => handleDefer(task.id, choice)}
                        onCancel={() => setDeferOpenForTaskId(null)}
                      />
                    )}
                  </div>
        </div>
      </section>
      <QueuePanel
        queue={queue}
        currentId={task.id}
        today={today}
        projects={state.projects}
        links={state.links}
        tasks={state.tasks}
        doneToday={state.tasks.filter(t => t.status === 'done' && t.updated_at.startsWith(today)).length}
        focused={focused}
        onPick={handlePickQueueTask}
      />
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning.';
  if (hour < 18) return 'Good afternoon.';
  return 'Good evening.';
}

function CardContextStrip({ focused, queueCount, dueTodayCount }: {
  focused: boolean;
  queueCount: number;
  dueTodayCount: number;
}) {
  if (focused) {
    const upNext = Math.max(0, queueCount - 1);
    return (
      <div className="card-context-strip focused">
        <span className="context-title">In focus.</span>
        <span className="context-meta">{upNext} up next.</span>
      </div>
    );
  }

  return (
    <div className="card-context-strip">
      <span className="context-title">{greeting()}</span>
      <span className="context-meta">{queueCount} ready, {dueTodayCount} due today.</span>
    </div>
  );
}

function QueuePanel({ queue, currentId, today, projects, links, tasks, doneToday, focused, onPick }: {
  queue: Task[];
  currentId: string | null;
  today: string;
  projects: Project[];
  links: TaskLink[];
  tasks: Task[];
  doneToday: number;
  focused?: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <aside className={`queue-panel${focused ? ' quiet' : ''}`}>
      <div className="queue-heading">
        <span>{focused ? 'Up next' : 'Ready queue'}</span>
        <span>{queue.length}</span>
      </div>
      <div className="queue-list">
        {queue.map(task => {
          const flow = deriveTaskFlow(task, {
            today,
            projects,
            links,
            tasks,
            surface: 'queue',
            selected: task.id === currentId,
          });
          return (
            <button key={task.id} className={`queue-item${task.id === currentId ? ' current' : ''}`} onClick={() => onPick(task.id)}>
              <span className="queue-project">
                <span className="queue-dot" style={{ background: flow.projectColor }} />
                {flow.projectLabel}
              </span>
              <span className="queue-title">{flow.title}</span>
              <span className="queue-meta">
                <span>{flow.statusLabel}</span>
                {!flow.metaLabel && <span>{flow.readiness}</span>}
              </span>
              {flow.metaLabel ? (
                <span className="dep-badge blocked-by">{flow.metaLabel}</span>
              ) : (
                <span className="score-track"><span className="score-fill" style={{ width: `${flow.readiness}%` }} /></span>
              )}
            </button>
          );
        })}
      </div>
      <div className="done-today">Done today: {doneToday}</div>
    </aside>
  );
}
