import { useMemo, useState } from 'react';
import { marked } from 'marked';
import { useAppState } from '../../hooks/useAppState';
import { buildBlocksMap, buildBlockedByMap } from '../../utils/linkMaps';
import { createTaskAction, completeTaskAction, deleteTaskAction, focusTaskAction, updateTaskAction } from '../../context/actions';
import { pushNav } from '../../hooks/useHistory';
import {
  isBlocked,
  projectTitle,
  taskSort,
} from '../../utils/design';
import { deriveTaskFlow, type TaskFlowAction, type TaskFlowActionId } from '../../utils/taskFlow';
import type { Project, Task, TaskLink } from '../../types';

type SortMode = 'readiness' | 'due' | 'project';

function Markdown({ src }: { src: string }) {
  const html = marked(src, { breaks: true }) as string;
  return <div className="detail-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function AllView() {
  const { state, dispatch } = useAppState();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('readiness');
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

  const sortedTasks = useMemo(() => {
    const tasks = state.showDone ? matchingTasks : matchingTasks.filter(t => t.status !== 'done');
    return [...tasks].sort((a, b) => {
      if (sort === 'due') {
        return (a.due_date ?? '9999-99-99').localeCompare(b.due_date ?? '9999-99-99') || taskSort(a, b, today, state.links);
      }
      if (sort === 'project') {
        return projectTitle(a, state.projects).localeCompare(projectTitle(b, state.projects)) || taskSort(a, b, today, state.links);
      }
      return taskSort(a, b, today, state.links);
    });
  }, [matchingTasks, sort, state.links, state.projects, state.showDone, today]);

  const readyTasks = sortedTasks.filter(t => !isBlocked(t, state.links) && t.status !== 'done');
  const blockedTasks = sortedTasks.filter(t => isBlocked(t, state.links) && t.status !== 'done');
  const doneTasks = sortedTasks.filter(t => t.status === 'done');
  const hiddenDoneCount = matchingTasks.filter(t => t.status === 'done').length;
  const selectedTask = state.detailTaskId ? taskMap[state.detailTaskId] : (readyTasks[0] ?? blockedTasks[0] ?? doneTasks[0]);

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

  async function handleSnooze(id: string) {
    const snoozedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await updateTaskAction(id, { focused_until: null, snoozed_until: snoozedUntil }, config, dispatch);
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
          <TaskGroup
            label="Ready"
            tasks={readyTasks}
            today={today}
            selectedId={selectedTask?.id}
            projects={state.projects}
            links={state.links}
            blocksMap={blocksMap}
            blockedByMap={blockedByMap}
            onSelect={handleSelect}
          />
          <TaskGroup
            label="Blocked"
            tasks={blockedTasks}
            today={today}
            selectedId={selectedTask?.id}
            projects={state.projects}
            links={state.links}
            blocksMap={blocksMap}
            blockedByMap={blockedByMap}
            onSelect={handleSelect}
          />
          {hiddenDoneCount > 0 && (
            <>
              <button className="done-toggle" onClick={() => dispatch({ type: 'SET_SHOW_DONE', value: !state.showDone })}>
                {state.showDone ? 'Hide done' : `Show ${hiddenDoneCount} done`}
              </button>
              {state.showDone && (
                <TaskGroup
                  label="Done"
                  tasks={doneTasks}
                  today={today}
                  selectedId={selectedTask?.id}
                  projects={state.projects}
                  links={state.links}
                  blocksMap={blocksMap}
                  blockedByMap={blockedByMap}
                  onSelect={handleSelect}
                />
              )}
            </>
          )}
        </div>
      </aside>

      <DetailPanel
        task={selectedTask}
        today={today}
        projects={state.projects}
        links={state.links}
        taskMap={taskMap}
        blocksMap={blocksMap}
        blockedByMap={blockedByMap}
        onSelect={handleSelect}
        onFocus={handleFocus}
        onComplete={handleComplete}
        onUnfocus={handleUnfocus}
        onSnooze={handleSnooze}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
    </div>
  );
}

function TaskGroup({ label, tasks, today, selectedId, projects, links, blocksMap, blockedByMap, onSelect }: {
  label: string;
  tasks: Task[];
  today: string;
  selectedId?: string;
  projects: Project[];
  links: TaskLink[];
  blocksMap: Record<string, Set<string>>;
  blockedByMap: Record<string, Set<string>>;
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
          surface: 'list',
          selected: selectedId === task.id,
        });
        const blocks = blocksMap[task.id]?.size ?? 0;
        const blocked = (blockedByMap[task.id]?.size ?? 0) > 0;
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
              {blocked && <span className="dep-badge blocked-by">{flow.statusLabel}</span>}
              {!blocked && task.status !== 'done' && (
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

function DetailPanel({ task, today, projects, links, taskMap, blocksMap, blockedByMap, onSelect, onFocus, onComplete, onUnfocus, onSnooze, onEdit, onDelete }: {
  task?: Task;
  today: string;
  projects: Project[];
  links: TaskLink[];
  taskMap: Record<string, Task>;
  blocksMap: Record<string, Set<string>>;
  blockedByMap: Record<string, Set<string>>;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  onComplete: (id: string) => void;
  onUnfocus: (id: string) => void;
  onSnooze: (id: string) => void;
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
  const blockedBy = [...(blockedByMap[currentTask.id] ?? [])].map(id => taskMap[id]).filter(Boolean);
  const blocking = [...(blocksMap[currentTask.id] ?? [])].map(id => taskMap[id]).filter(Boolean);
  const flow = deriveTaskFlow(currentTask, { today, projects, links, surface: 'detail', selected: true });

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
      case 'snooze':
        onSnooze(currentTask.id);
        break;
      case 'skip':
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
