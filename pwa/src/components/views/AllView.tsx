import { useMemo, useState } from 'react';
import { useAppState } from '../../hooks/useAppState';
import { buildBlocksMap, buildBlockedByMap } from '../../utils/linkMaps';
import {
  createTaskAction,
  completeTaskAction,
  deferTaskAction,
  deleteTaskAction,
  clearDeferAction,
  focusTaskAction,
  updateTaskAction,
} from '../../context/actions';
import { pushNav } from '../../hooks/useHistory';
import { Markdown } from '../common/Markdown';
import {
  isBlocked,
  isDeferred,
  isSomeday,
  projectTitle,
  taskSort,
} from '../../utils/design';
import { DeferMenu, type DeferChoice } from '../task/DeferMenu';
import { deriveTaskFlow, type TaskFlowAction, type TaskFlowActionId } from '../../utils/taskFlow';
import type { StatusFilter } from '../../context/reducer';
import type { Project, Task, TaskLink } from '../../types';

type SortMode = 'readiness' | 'due' | 'project';

export function AllView() {
  const { state, dispatch } = useAppState();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('readiness');
  const [deferTargetId, setDeferTargetId] = useState<string | null>(null);
  const today = new Date().toISOString().split('T')[0];
  const config = { apiBase: state.apiBase, authToken: state.authToken };
  const selectedProject = state.selectedProjectId
    ? state.projects.find(project => project.id === state.selectedProjectId)
    : null;

  const taskMap = useMemo(() => Object.fromEntries(state.tasks.map(t => [t.id, t])), [state.tasks]);
  const blocksMap = useMemo(() => buildBlocksMap(state.links), [state.links]);
  const blockedByMap = useMemo(() => buildBlockedByMap(state.links), [state.links]);

  const matchingTasks = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return state.tasks
      .filter(t => !state.selectedProjectId || t.project_id === state.selectedProjectId)
      .filter(t => !lower || `${t.title} ${projectTitle(t, state.projects)}`.toLowerCase().includes(lower));
  }, [query, state.projects, state.selectedProjectId, state.tasks]);

  const filterCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { ready: 0, deferred: 0, someday: 0, done: 0 };
    for (const t of matchingTasks) {
      if (t.status === 'done') counts.done += 1;
      else if (isSomeday(t)) counts.someday += 1;
      else if (isDeferred(t)) counts.deferred += 1;
      else counts.ready += 1;
    }
    return counts;
  }, [matchingTasks]);

  const filteredTasks = useMemo(() => {
    return matchingTasks.filter(t => {
      switch (state.statusFilter) {
        case 'done': return t.status === 'done';
        case 'someday': return t.status !== 'done' && isSomeday(t);
        case 'deferred': return t.status !== 'done' && !isSomeday(t) && isDeferred(t);
        case 'ready': return t.status !== 'done' && !isDeferred(t);
      }
    });
  }, [matchingTasks, state.statusFilter]);

  const sortedTasks = useMemo(() => {
    return [...filteredTasks].sort((a, b) => {
      if (sort === 'due') {
        return (a.due_date ?? '9999-99-99').localeCompare(b.due_date ?? '9999-99-99')
          || taskSort(a, b, today, state.links, state.tasks);
      }
      if (sort === 'project') {
        return projectTitle(a, state.projects).localeCompare(projectTitle(b, state.projects))
          || taskSort(a, b, today, state.links, state.tasks);
      }
      return taskSort(a, b, today, state.links, state.tasks);
    });
  }, [filteredTasks, sort, state.links, state.projects, state.tasks, today]);

  const readyTasks = state.statusFilter === 'ready'
    ? sortedTasks.filter(t => !isBlocked(t, state.links, state.tasks))
    : sortedTasks;
  const blockedTasks = state.statusFilter === 'ready'
    ? sortedTasks.filter(t => isBlocked(t, state.links, state.tasks))
    : [];
  const selectedTask = state.detailTaskId ? taskMap[state.detailTaskId] : (readyTasks[0] ?? blockedTasks[0]);

  async function handleAdd(title: string) {
    await createTaskAction(title, config, dispatch);
  }

  async function handleComplete(id: string) {
    const msg = await completeTaskAction(id, config, dispatch);
    if (msg) dispatch({ type: 'SET_TOAST', message: msg });
  }

  function handleSelect(id: string) {
    dispatch({ type: 'SET_DETAIL', id });
    pushNav({ view: state.currentView, detailId: id, editId: null });
  }

  async function handleFocus(id: string) {
    await focusTaskAction(id, config, dispatch);
    dispatch({ type: 'SET_PROJECT_FILTER', id: null });
    dispatch({ type: 'SET_VIEW', view: 'suggest' });
    pushNav({ view: 'suggest', detailId: null, editId: null });
  }

  async function handleDelete(id: string) {
    await deleteTaskAction(id, config, dispatch);
    dispatch({ type: 'SET_DETAIL', id: null });
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
    setDeferTargetId(null);
  }

  async function handleReopen(id: string) {
    await clearDeferAction(id, config, dispatch);
  }

  function handleEdit(id: string) {
    dispatch({ type: 'SET_EDITING', id });
    pushNav({ view: state.currentView, detailId: id, editId: id });
  }

  return (
    <div className="all-view">
      <aside className="task-list-col">
        <div className="list-header">
          <div className="list-title">{selectedProject ? selectedProject.title : 'All Tasks'}</div>
          <div className="list-search">
            <span>/</span>
            <input
              className="list-search-input"
              placeholder="Filter tasks..."
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && query.trim()) {
                  handleAdd(query.trim());
                  setQuery('');
                }
              }}
            />
          </div>
          <div className="list-status-filter" role="tablist" aria-label="Status filter">
            {(['ready', 'deferred', 'someday', 'done'] as const).map(filter => (
              <button
                key={filter}
                className={`status-chip${state.statusFilter === filter ? ' active' : ''}`}
                onClick={() => dispatch({ type: 'SET_STATUS_FILTER', filter })}
              >
                {filter}
                <span className="status-chip-count">{filterCounts[filter]}</span>
              </button>
            ))}
          </div>
          <div className="list-sort" role="tablist" aria-label="Task sort">
            {(['readiness', 'due', 'project'] as const).map(mode => (
              <button
                key={mode}
                className={`sort-btn${sort === mode ? ' active' : ''}`}
                onClick={() => setSort(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        <div className="list-scroll">
          {state.statusFilter === 'ready' ? (
            <>
              <TaskGroup
                label="Ready"
                tasks={readyTasks}
                today={today}
                selectedId={selectedTask?.id}
                projects={state.projects}
                links={state.links}
                allTasks={state.tasks}
                blocksMap={blocksMap}
                onSelect={handleSelect}
              />
              <TaskGroup
                label="Blocked"
                tasks={blockedTasks}
                today={today}
                selectedId={selectedTask?.id}
                projects={state.projects}
                links={state.links}
                allTasks={state.tasks}
                blocksMap={blocksMap}
                onSelect={handleSelect}
              />
            </>
          ) : (
            <TaskGroup
              label={STATUS_FILTER_LABELS[state.statusFilter]}
              tasks={readyTasks}
              today={today}
              selectedId={selectedTask?.id}
              projects={state.projects}
              links={state.links}
              allTasks={state.tasks}
              blocksMap={blocksMap}
              onSelect={handleSelect}
            />
          )}
        </div>
      </aside>

      <DetailPanel
        task={selectedTask}
        today={today}
        projects={state.projects}
        links={state.links}
        allTasks={state.tasks}
        taskMap={taskMap}
        blocksMap={blocksMap}
        blockedByMap={blockedByMap}
        deferTargetId={deferTargetId}
        onSelect={handleSelect}
        onFocus={handleFocus}
        onComplete={handleComplete}
        onUnfocus={handleUnfocus}
        onDeferRequest={(id) => setDeferTargetId(id)}
        onDeferChoose={handleDefer}
        onDeferCancel={() => setDeferTargetId(null)}
        onReopen={handleReopen}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
    </div>
  );
}

const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  ready: 'Ready',
  deferred: 'Deferred',
  someday: 'Someday',
  done: 'Done',
};

function TaskGroup({ label, tasks, today, selectedId, projects, links, allTasks, blocksMap, onSelect }: {
  label: string;
  tasks: Task[];
  today: string;
  selectedId?: string;
  projects: Project[];
  links: TaskLink[];
  allTasks: Task[];
  blocksMap: Record<string, Set<string>>;
  onSelect: (id: string) => void;
}) {
  if (tasks.length === 0) return null;

  return (
    <>
      <div className="list-group-label">{label}</div>
      {tasks.map(task => {
        const flow = deriveTaskFlow(task, {
          today,
          projects,
          links,
          tasks: allTasks,
          surface: 'list',
          selected: selectedId === task.id,
        });
        const blocks = blocksMap[task.id]?.size ?? 0;
        const blocked = isBlocked(task, links, allTasks);
        return (
          <button
            key={task.id}
            className={`list-item${selectedId === task.id ? ' selected' : ''}${blocked ? ' blocked-item' : ''}`}
            onClick={() => onSelect(task.id)}
          >
            <span className="list-item-eyebrow">
              <span className="list-item-dot" style={{ background: flow.projectColor }} />
              <span className="list-item-project">{flow.projectLabel}</span>
              <span className="list-item-due">{flow.dueLabel}</span>
            </span>
            <span className="list-item-title">{flow.title}</span>
            <span className="list-item-meta">
              {blocks > 0 && <span className="dep-badge blocks">Blocks {blocks}</span>}
              {flow.metaLabel ? (
                <span className="dep-badge blocked-by">{flow.metaLabel}</span>
              ) : (
                <>
                  <span className="score-track"><span className="score-fill" style={{ width: `${flow.readiness}%` }} /></span>
                  <span className="score-num">{flow.readiness}</span>
                </>
              )}
            </span>
          </button>
        );
      })}
    </>
  );
}

function DetailPanel({ task, today, projects, links, allTasks, taskMap, blocksMap, blockedByMap, deferTargetId, onSelect, onFocus, onComplete, onUnfocus, onDeferRequest, onDeferChoose, onDeferCancel, onReopen, onEdit, onDelete }: {
  task?: Task;
  today: string;
  projects: Project[];
  links: TaskLink[];
  allTasks: Task[];
  taskMap: Record<string, Task>;
  blocksMap: Record<string, Set<string>>;
  blockedByMap: Record<string, Set<string>>;
  deferTargetId: string | null;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  onComplete: (id: string) => void;
  onUnfocus: (id: string) => void;
  onDeferRequest: (id: string) => void;
  onDeferChoose: (id: string, choice: DeferChoice) => void;
  onDeferCancel: () => void;
  onReopen: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (!task) {
    return (
      <section className="detail-panel">
        <div className="detail-scroll">
          <div className="empty">No tasks yet.</div>
        </div>
      </section>
    );
  }

  const currentTask = task;
  const blockedBy = [...(blockedByMap[currentTask.id] ?? [])]
    .map(id => taskMap[id])
    .filter((blocker): blocker is Task => !!blocker && blocker.status !== 'done');
  const blocking = [...(blocksMap[currentTask.id] ?? [])].map(id => taskMap[id]).filter(Boolean);
  const flow = deriveTaskFlow(currentTask, { today, projects, links, tasks: allTasks, surface: 'detail', selected: true });

  function handleAction(action: TaskFlowActionId) {
    switch (action) {
      case 'focus':
        onFocus(currentTask.id);
        break;
      case 'complete':
        onComplete(currentTask.id);
        break;
      case 'edit':
        onEdit(currentTask.id);
        break;
      case 'delete':
        onDelete(currentTask.id);
        break;
      case 'unfocus':
        onUnfocus(currentTask.id);
        break;
      case 'defer':
        onDeferRequest(currentTask.id);
        break;
      case 'reopen':
        onReopen(currentTask.id);
        break;
    }
  }

  return (
    <section className="detail-panel">
      <div className="detail-breadcrumb">
        <span className="breadcrumb-item current">All Tasks</span>
        <span className="breadcrumb-sep">&gt;</span>
        <span className="breadcrumb-item current">{task.title}</span>
      </div>

      <div className="detail-scroll">
        {blockedBy.length > 0 && (
          <DependencySection label="Waiting on" tasks={blockedBy} onSelect={onSelect} />
        )}

        <div className="detail-heading">
          <div className="detail-meta">
            <span className="list-item-dot" style={{ background: flow.projectColor }} />
            {flow.projectLabel}
            {flow.dueLabel && <span>- {flow.dueLabel}</span>}
          </div>
          <h1 className="detail-title">{flow.title}</h1>
        </div>

        <div className="notes-card">
          {flow.kickoff ? (
            <div className="notes-kickoff">{flow.kickoff}</div>
          ) : (
            <button className="notes-placeholder" onClick={() => onEdit(currentTask.id)}>+ Add a starting point...</button>
          )}
          <div className="notes-rule" />
          {flow.notePreview ? (
            <Markdown src={flow.notePreview} />
          ) : (
            <div className="notes-empty">No notes yet.</div>
          )}
        </div>

        {blocking.length > 0 && (
          <DependencySection label="Unlocks" tasks={blocking} onSelect={onSelect} />
        )}
      </div>

      <div className="detail-action-bar">
        {flow.primaryAction && <FlowActionButton action={flow.primaryAction} onAction={handleAction} />}
        {flow.secondaryActions.map(action => (
          <FlowActionButton key={action.id} action={action} onAction={handleAction} />
        ))}
      </div>
      {deferTargetId === currentTask.id && (
        <DeferMenu
          onChoose={(choice) => onDeferChoose(currentTask.id, choice)}
          onCancel={onDeferCancel}
        />
      )}
    </section>
  );
}

function FlowActionButton({ action, onAction }: {
  action: TaskFlowAction;
  onAction: (id: TaskFlowActionId) => void;
}) {
  const className = action.tone === 'primary'
    ? 'btn-act'
    : action.tone === 'danger'
      ? 'btn-delete'
      : 'btn-skip';

  return (
    <button className={className} onClick={() => onAction(action.id)}>
      {action.label}
    </button>
  );
}

function DependencySection({ label, tasks, onSelect }: {
  label: string;
  tasks: Task[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="dependency-section">
      <div className="dep-section-label">{label}</div>
      {tasks.map(task => (
        <button key={task.id} className="dependency-card" onClick={() => onSelect(task.id)}>
          <span>{task.title}</span>
          <span>-&gt;</span>
        </button>
      ))}
    </div>
  );
}
