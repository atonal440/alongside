import { useAppState } from '../../hooks/useAppState';
import { EmptyState } from '../common/EmptyState';
import { TaskCard } from '../task/TaskCard';
import { completeTaskAction } from '../../context/actions';
import { pushNav } from '../../hooks/useHistory';

export function SessionView() {
  const { state, dispatch } = useAppState();
  const today = new Date().toISOString().split('T')[0];
  const config = { apiBase: state.apiBase, authToken: state.authToken };
  const active = state.tasks.filter(t => t.status === 'active');

  async function handleDone(id: string) {
    const msg = await completeTaskAction(id, config, dispatch);
    if (msg) dispatch({ type: 'SET_TOAST', message: msg });
  }

  function handleEdit(id: string) {
    dispatch({ type: 'SET_EDITING', id });
    pushNav({ view: state.currentView, detailId: null, editId: id });
  }

  if (active.length === 0) {
    return <EmptyState message="Nothing in progress. Start a task from Suggest." />;
  }

  return (
    <>
      {active.map(t => (
        <TaskCard
          key={t.id}
          task={t}
          today={today}
          style={{ marginBottom: 12 }}
          onDone={() => handleDone(t.id)}
          onEdit={handleEdit}
        />
      ))}
    </>
  );
}
