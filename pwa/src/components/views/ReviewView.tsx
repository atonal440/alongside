import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useAppState } from '../../hooks/useAppState';
import { completeTaskAction, focusTaskAction } from '../../context/actions';
import { pushNav } from '../../hooks/useHistory';
import { projectTitle } from '../../utils/design';
import { suggestQueue } from '../../utils/suggestQueue';
import type { Task } from '../../types';

function isActiveFocus(task: { focused_until: string | null }): boolean {
  return !!task.focused_until && task.focused_until > new Date().toISOString();
}

function hasExpiredFocus(task: { focused_until: string | null }): boolean {
  return !!task.focused_until && task.focused_until <= new Date().toISOString();
}

export function ReviewView() {
  const { state, dispatch } = useAppState();
  const today = new Date().toISOString().split('T')[0];
  const config = { apiBase: state.apiBase, authToken: state.authToken };
  const focused = state.tasks
    .filter(isActiveFocus)
    .sort((a, b) => (b.focused_until ?? '').localeCompare(a.focused_until ?? ''));
  const focusedIds = new Set(focused.map(task => task.id));
  const doneToday = state.tasks
    .filter(task => task.status === 'done' && task.updated_at.startsWith(today))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const carryForward = state.tasks
    .filter(task => task.status !== 'done' && !focusedIds.has(task.id) && (task.session_log || hasExpiredFocus(task)))
    .slice(0, 4);
  const nextTask = useMemo(() => {
    return suggestQueue(state.tasks, today, state.cardSeen)
      .find(task => !focusedIds.has(task.id)) ?? null;
  }, [focusedIds, state.cardSeen, state.tasks, today]);

  function handleEdit(id: string) {
    dispatch({ type: 'SET_EDITING', id });
    pushNav({ view: 'review', detailId: null, editId: id });
  }

  function openTask(id: string) {
    dispatch({ type: 'SET_DETAIL', id });
    pushNav({ view: 'review', detailId: id, editId: null });
  }

  async function handleComplete(id: string) {
    const msg = await completeTaskAction(id, config, dispatch);
    if (msg) dispatch({ type: 'SET_TOAST', message: msg });
  }

  async function handleFocus(id: string) {
    await focusTaskAction(id, config, dispatch);
    dispatch({ type: 'SET_VIEW', view: 'suggest' });
    pushNav({ view: 'suggest', detailId: null, editId: null });
  }

  const isEmpty = focused.length === 0 && doneToday.length === 0 && carryForward.length === 0 && !nextTask;
  const focusSummary = focused.length === 0
    ? 'No active focus right now.'
    : focused.length === 1
      ? 'One task is still in focus.'
      : `${focused.length} tasks are still in focus.`;

  if (isEmpty) {
    return (
      <section className="review-view">
        <div className="review-header">
          <div className="review-kicker">Review</div>
          <h1>Nothing to close out yet.</h1>
          <p>Focus a task from Today, finish something, or capture a note when there is work to carry forward.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="review-view">
      <div className="review-header">
        <div className="review-kicker">Review</div>
        <h1>Close the loop.</h1>
        <p>{doneToday.length} done today. {focusSummary}</p>
      </div>

      <div className="review-grid">
        <ReviewPanel title="Current Focus">
          {focused.length > 0 ? focused.map(task => (
            <ReviewTask
              key={task.id}
              task={task}
              projectName={projectTitle(task, state.projects)}
              primaryLabel="Mark complete"
              onPrimary={() => void handleComplete(task.id)}
              secondaryLabel="Edit notes"
              onSecondary={() => handleEdit(task.id)}
              onOpen={() => openTask(task.id)}
            />
          )) : (
            <div className="review-empty">No task is focused.</div>
          )}
        </ReviewPanel>

        <ReviewPanel title="Done Today">
          {doneToday.length > 0 ? doneToday.slice(0, 4).map(task => (
            <ReviewTask
              key={task.id}
              task={task}
              projectName={projectTitle(task, state.projects)}
              primaryLabel="Edit notes"
              onPrimary={() => handleEdit(task.id)}
              onOpen={() => openTask(task.id)}
            />
          )) : <div className="review-empty">Nothing completed yet today.</div>}
        </ReviewPanel>

        <ReviewPanel title="Carry Forward">
          {carryForward.length > 0 ? carryForward.map(task => (
            <ReviewTask
              key={task.id}
              task={task}
              projectName={projectTitle(task, state.projects)}
              primaryLabel={task.session_log ? 'Edit carry-forward note' : 'Add carry-forward note'}
              onPrimary={() => handleEdit(task.id)}
              onOpen={() => openTask(task.id)}
            />
          )) : <div className="review-empty">No carry-forward notes queued.</div>}
        </ReviewPanel>

        <ReviewPanel title="Next Suggestion">
          {nextTask ? (
            <ReviewTask
              task={nextTask}
              projectName={projectTitle(nextTask, state.projects)}
              primaryLabel="Focus next"
              onPrimary={() => void handleFocus(nextTask.id)}
              secondaryLabel="Open"
              onSecondary={() => openTask(nextTask.id)}
              onOpen={() => openTask(nextTask.id)}
            />
          ) : (
            <div className="review-empty">No ready suggestion.</div>
          )}
        </ReviewPanel>
      </div>
    </section>
  );
}

function ReviewPanel({ title, children }: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="review-panel">
      <div className="review-panel-title">{title}</div>
      {children}
    </section>
  );
}

function ReviewTask({ task, projectName, primaryLabel, secondaryLabel, onPrimary, onSecondary, onOpen }: {
  task: Task;
  projectName: string;
  primaryLabel: string;
  secondaryLabel?: string;
  onPrimary: () => void;
  onSecondary?: () => void;
  onOpen: () => void;
}) {
  return (
    <article className="review-task">
      <button className="review-task-main" onClick={onOpen}>
        <span className="review-task-project">{projectName}</span>
        <span className="review-task-title">{task.title}</span>
        {task.session_log && <span className="review-task-note">{task.session_log}</span>}
      </button>
      <div className="review-task-actions">
        <button className="btn-skip" onClick={onPrimary}>{primaryLabel}</button>
        {secondaryLabel && onSecondary && <button className="btn-skip" onClick={onSecondary}>{secondaryLabel}</button>}
      </div>
    </article>
  );
}
