import { useAppState } from '../../hooks/useAppState';
import { buildBlocksMap, buildBlockedByMap } from '../../utils/linkMaps';
import { AddBar } from '../common/AddBar';
import { EmptyState } from '../common/EmptyState';
import { CompactCard } from '../task/CompactCard';
import { TaskStack } from '../task/TaskStack';
import { createTaskAction, completeTaskAction } from '../../context/actions';
import { pushNav } from '../../hooks/useHistory';
import type { Task } from '../../types';

export function AllView() {
  const { state, dispatch } = useAppState();
  const today = new Date().toISOString().split('T')[0];
  const config = { apiBase: state.apiBase, authToken: state.authToken };

  async function handleAdd(title: string) {
    await createTaskAction(title, config, dispatch);
  }

  async function handleComplete(id: string) {
    const msg = await completeTaskAction(id, config, dispatch);
    if (msg) dispatch({ type: 'SET_TOAST', message: msg });
  }

  function handleDetail(id: string) {
    dispatch({ type: 'SET_DETAIL', id });
    pushNav({ view: state.currentView, detailId: id, editId: null });
  }

  const taskMap = Object.fromEntries(state.tasks.map(t => [t.id, t]));
  const blocksMap = buildBlocksMap(state.links);
  const blockedByMap = buildBlockedByMap(state.links);

  // Group by project
  const byProject: Record<string, Task[]> = {};
  for (const t of state.tasks) {
    const key = t.project_id ?? '__none__';
    if (!byProject[key]) byProject[key] = [];
    byProject[key].push(t);
  }

  const sections: { title: string; tasks: Task[] }[] = [];
  for (const project of state.projects) {
    if (byProject[project.id]?.length) {
      sections.push({ title: project.title, tasks: byProject[project.id] });
    }
  }
  if (byProject['__none__']?.length) {
    sections.push({ title: 'No project', tasks: byProject['__none__'] });
  }

  return (
    <>
      <AddBar onAdd={handleAdd} />
      {sections.length === 0 ? (
        <EmptyState message="No tasks yet. Add one above." />
      ) : (
        sections.map(({ title, tasks }) => (
          <ProjectSection
            key={title}
            title={title}
            tasks={tasks}
            today={today}
            taskMap={taskMap}
            blocksMap={blocksMap}
            blockedByMap={blockedByMap}
            showDone={state.showDone}
            onShowDone={v => dispatch({ type: 'SET_SHOW_DONE', value: v })}
            onComplete={handleComplete}
            onDetail={handleDetail}
          />
        ))
      )}
    </>
  );
}

interface SectionProps {
  title: string;
  tasks: Task[];
  today: string;
  taskMap: Record<string, Task>;
  blocksMap: Record<string, Set<string>>;
  blockedByMap: Record<string, Set<string>>;
  showDone: boolean;
  onShowDone: (v: boolean) => void;
  onComplete: (id: string) => void;
  onDetail: (id: string) => void;
}

function ProjectSection({
  title, tasks, today, taskMap, blocksMap, blockedByMap,
  showDone, onShowDone, onComplete, onDetail,
}: SectionProps) {
  const nonDone = tasks.filter(t => t.status !== 'done');
  const done = tasks.filter(t => t.status === 'done');
  const sectionIds = new Set(nonDone.map(t => t.id));

  const blockedInSection = new Set(
    nonDone
      .filter(t => {
        const blockers = blockedByMap[t.id];
        return blockers && [...blockers].some(bid => sectionIds.has(bid));
      })
      .map(t => t.id),
  );

  const roots = nonDone.filter(t => !blockedInSection.has(t.id));
  const rendered = new Set<string>();

  const items: React.ReactNode[] = roots.map(root => {
    if (rendered.has(root.id)) return null;
    rendered.add(root.id);

    const chain: Task[] = [];
    let currentId = root.id;
    while (true) {
      const nextId = [...(blocksMap[currentId] ?? [])].find(
        id => sectionIds.has(id) && !rendered.has(id),
      );
      if (!nextId) break;
      const next = taskMap[nextId];
      if (!next) break;
      chain.push(next);
      rendered.add(nextId);
      currentId = nextId;
    }

    if (chain.length === 0) {
      return (
        <CompactCard
          key={root.id}
          task={root}
          today={today}
          onComplete={onComplete}
          onDetail={onDetail}
        />
      );
    }

    return (
      <TaskStack
        key={root.id}
        root={root}
        blocked={chain}
        today={today}
        onComplete={onComplete}
        onDetail={onDetail}
      />
    );
  });

  // Overflow (cross-section blocks)
  nonDone.filter(t => !rendered.has(t.id)).forEach(t => {
    items.push(
      <CompactCard key={t.id} task={t} today={today} onComplete={onComplete} onDetail={onDetail} />,
    );
  });

  const nonDoneCount = nonDone.length;
  const label = nonDoneCount > 0 ? `${title} (${nonDoneCount})` : title;

  return (
    <div className="project-section">
      <h2>{label}</h2>
      {items}
      {done.length > 0 && (
        showDone ? (
          <>
            {done.map(t => (
              <CompactCard key={t.id} task={t} today={today} onComplete={onComplete} onDetail={onDetail} />
            ))}
            <span className="done-toggle" onClick={() => onShowDone(false)}>Hide done</span>
          </>
        ) : (
          <span className="done-toggle" onClick={() => onShowDone(true)}>{done.length} done</span>
        )
      )}
    </div>
  );
}
