import { useAppState } from '../../hooks/useAppState';
import { completeTaskAction, focusTaskAction } from '../../context/actions';
import { pushNav } from '../../hooks/useHistory';
import { Markdown } from '../common/Markdown';
import { projectColor } from '../../utils/design';
import type { Task } from '../../types';

export function DetailView() {
  const { state, dispatch } = useAppState();
  const config = { apiBase: state.apiBase, authToken: state.authToken };
  const today = new Date().toISOString().split('T')[0];

  const taskOrUndef = state.tasks.find(t => t.id === state.detailTaskId);
  if (!taskOrUndef) return null;
  const task = taskOrUndef;

  const taskMap = Object.fromEntries(state.tasks.map(t => [t.id, t]));
  const projectMap = Object.fromEntries(state.projects.map(p => [p.id, p]));

  const blockedBy = state.links
    .filter(l => l.link_type === 'blocks' && l.to_task_id === task.id)
    .map(l => taskMap[l.from_task_id])
    .filter(Boolean) as Task[];

  const blocking = state.links
    .filter(l => l.link_type === 'blocks' && l.from_task_id === task.id)
    .map(l => taskMap[l.to_task_id])
    .filter(Boolean) as Task[];

  const related = state.links
    .filter(l => l.link_type === 'related' &&
      (l.from_task_id === task.id || l.to_task_id === task.id))
    .map(l => l.from_task_id === task.id ? taskMap[l.to_task_id] : taskMap[l.from_task_id])
    .filter(Boolean) as Task[];

  const projectName = task.project_id ? (projectMap[task.project_id]?.title ?? '') : '';

  const focused = !!task.focused_until && task.focused_until > new Date().toISOString();

  let statusLabel = '';
  if (focused) statusLabel = 'Focused';
  else if (task.defer_kind === 'someday') statusLabel = 'Someday';
  else if (task.defer_kind === 'until' && task.defer_until && task.defer_until > new Date().toISOString())
    statusLabel = `Deferred until ${task.defer_until.split('T')[0]}`;
  else if (task.due_date && task.due_date < today) statusLabel = `Overdue · ${task.due_date}`;

  async function handleDone() {
    const msg = await completeTaskAction(task.id, config, dispatch);
    if (msg) dispatch({ type: 'SET_TOAST', message: msg });
    dispatch({ type: 'SET_DETAIL', id: null });
  }

  async function handleStart() {
    await focusTaskAction(task.id, config, dispatch);
    dispatch({ type: 'SET_DETAIL', id: null });
  }

  function handleEdit() {
    dispatch({ type: 'SET_EDITING', id: task.id });
    pushNav({ view: state.currentView, detailId: task.id, editId: task.id });
  }

  function handleDetailLink(id: string) {
    dispatch({ type: 'SET_DETAIL', id });
    pushNav({ view: state.currentView, detailId: id, editId: null });
  }

  const projectLabel = projectName || 'No project';

  return (
    <section className="detail-panel detail-standalone">
      <div className="detail-breadcrumb">
        <button className="breadcrumb-button" onClick={() => history.back()}>Back</button>
        <span className="breadcrumb-sep">&gt;</span>
        <span className="breadcrumb-item current">{task.title}</span>
      </div>

      <div className="detail-scroll">
        {blockedBy.length > 0 && (
          <DependencySection label="Waiting on" tasks={blockedBy} onDetailLink={handleDetailLink} />
        )}

        <div className="detail-heading">
          <div className="detail-meta">
            <span className="list-item-dot" style={{ background: projectColor(task.project_id) }} />
            {projectLabel}
            {statusLabel && <span>- {statusLabel}</span>}
            {task.due_date && <span>- Due {task.due_date}</span>}
            {task.recurrence && <span>- Recurring</span>}
          </div>
          <h1 className="detail-title">{task.title}</h1>
        </div>

        <div className="notes-card">
          {task.kickoff_note ? (
            <div className="notes-kickoff">{task.kickoff_note}</div>
          ) : (
            <button className="notes-placeholder" onClick={handleEdit}>+ Add a starting point...</button>
          )}

          <div className="notes-rule" />

          {task.notes ? (
            <Markdown src={task.notes} />
          ) : (
            <div className="notes-empty">No notes yet.</div>
          )}

          {task.session_log && (
            <>
              <div className="notes-rule" />
              <div className="detail-section-label">Carry-forward note</div>
              <Markdown src={task.session_log} />
            </>
          )}
        </div>

        {blocking.length > 0 && (
          <DependencySection label="Unlocks" tasks={blocking} onDetailLink={handleDetailLink} />
        )}

        {related.length > 0 && (
          <DependencySection label="Related" tasks={related} onDetailLink={handleDetailLink} />
        )}
      </div>

      <div className="detail-action-bar">
        {!focused && task.status === 'pending' && (
          <>
            <button className="btn-act" onClick={handleStart}>Focus</button>
            <button className="btn-skip" onClick={handleDone}>Mark done</button>
          </>
        )}
        {focused && <button className="btn-act" onClick={handleDone}>Mark done</button>}
        <button className="btn-skip" onClick={handleEdit}>Edit notes</button>
      </div>
    </section>
  );
}

function DependencySection({ label, tasks, onDetailLink }: {
  label: string;
  tasks: Task[];
  onDetailLink: (id: string) => void;
}) {
  return (
    <div className="dependency-section">
      <div className="dep-section-label">{label}</div>
      {tasks.map(t => (
        <button key={t.id} className="dependency-card" onClick={() => onDetailLink(t.id)}>
          <span>{t.title}</span>
          <span>-&gt;</span>
        </button>
      ))}
    </div>
  );
}
