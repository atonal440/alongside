import { useAppState } from '../../hooks/useAppState';
import { suggestQueue } from '../../utils/suggestQueue';
import { AddBar } from '../common/AddBar';
import { EmptyState } from '../common/EmptyState';
import { TaskCard } from '../task/TaskCard';
import { createTaskAction, completeTaskAction, activateTaskAction } from '../../context/actions';
import { pushNav } from '../../hooks/useHistory';

export function SuggestView() {
  const { state, dispatch } = useAppState();
  const today = new Date().toISOString().split('T')[0];
  const queue = suggestQueue(state.tasks, today, state.cardSeen);
  const config = { apiBase: state.apiBase, authToken: state.authToken };

  async function handleAdd(title: string) {
    await createTaskAction(title, config, dispatch);
  }

  async function handleDone(id: string) {
    const msg = await completeTaskAction(id, config, dispatch);
    if (msg) dispatch({ type: 'SET_TOAST', message: msg });
  }

  async function handleStart(id: string) {
    await activateTaskAction(id, config, dispatch);
  }

  function handleEdit(id: string) {
    dispatch({ type: 'SET_EDITING', id });
    pushNav({ view: state.currentView, detailId: null, editId: id });
  }

  if (queue.length === 0) {
    return (
      <>
        <AddBar onAdd={handleAdd} />
        <EmptyState message="All clear! Add something above." />
      </>
    );
  }

  const task = queue[0];
  const rest = queue.length - 1;
  const isActive = task.status === 'active';

  return (
    <>
      <AddBar onAdd={handleAdd} />
      <div className="card-view">
        <TaskCard
          task={task}
          today={today}
          isActive={isActive}
          onSkip={isActive ? undefined : () => dispatch({ type: 'CARD_SEEN', id: task.id })}
          onStart={isActive ? undefined : () => handleStart(task.id)}
          onDone={() => handleDone(task.id)}
          onNext={isActive ? () => dispatch({ type: 'CARD_SEEN', id: task.id }) : undefined}
          onEdit={handleEdit}
        />
        <div className="card-actions" />
        <div className="card-counter">{rest > 0 ? `${rest} more` : 'Last one'}</div>
      </div>
    </>
  );
}
