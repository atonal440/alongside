import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Project, Task } from '../../types';
import { projectColor, projectTitle } from '../../utils/design';
import type { TaskFlowActionId } from '../../utils/taskFlow';

interface Props {
  tasks: Task[];
  projects: Project[];
  onCreateTask: (title: string) => void;
  onOpenTask: (id: string) => void;
  onOpenProject: (id: string) => void;
  onTaskAction: (id: string, action: TaskFlowActionId) => void;
}

type CommandResult =
  | { id: string; kind: 'task'; group: string; task: Task; title: string; meta: string }
  | { id: string; kind: 'project'; group: string; project: Project; title: string; meta: string }
  | { id: string; kind: 'create'; group: string; title: string; meta: string }
  | { id: string; kind: 'action'; group: string; task: Task; action: TaskFlowActionId; title: string; meta: string };

export function SearchBar({ tasks, projects, onCreateTask, onOpenTask, onOpenProject, onTaskAction }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [actionTaskId, setActionTaskId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lowerQuery = query.trim().toLowerCase();

  const matchingTasks = useMemo(() => {
    if (!lowerQuery) return tasks.filter(t => t.status !== 'done').slice(0, 3);
    return tasks
      .filter(t => `${t.title} ${projectTitle(t, projects)}`.toLowerCase().includes(lowerQuery))
      .slice(0, 5);
  }, [lowerQuery, projects, tasks]);

  const matchingProjects = useMemo(() => {
    if (!lowerQuery) return projects.slice(0, 3);
    return projects.filter(p => p.title.toLowerCase().includes(lowerQuery)).slice(0, 3);
  }, [lowerQuery, projects]);

  const actionTask = useMemo(() => {
    return matchingTasks.find(task => task.id === actionTaskId) ?? matchingTasks[0] ?? null;
  }, [actionTaskId, matchingTasks]);

  const results = useMemo<CommandResult[]>(() => {
    const taskResults: CommandResult[] = matchingTasks.map(task => ({
      id: `task:${task.id}`,
      kind: 'task',
      group: lowerQuery ? 'Tasks' : 'Recent',
      task,
      title: task.title,
      meta: projectTitle(task, projects),
    }));

    const actionResults: CommandResult[] = actionTask ? [
      { id: `action:${actionTask.id}:focus`, kind: 'action', group: 'Actions', task: actionTask, action: 'focus', title: 'Focus', meta: actionTask.title },
      { id: `action:${actionTask.id}:complete`, kind: 'action', group: 'Actions', task: actionTask, action: 'complete', title: 'Done', meta: actionTask.title },
      { id: `action:${actionTask.id}:defer`, kind: 'action', group: 'Actions', task: actionTask, action: 'defer', title: 'Defer', meta: actionTask.title },
      { id: `action:${actionTask.id}:edit`, kind: 'action', group: 'Actions', task: actionTask, action: 'edit', title: 'Edit', meta: actionTask.title },
    ] : [];

    const projectResults: CommandResult[] = matchingProjects.map(project => ({
      id: `project:${project.id}`,
      kind: 'project',
      group: 'Projects',
      project,
      title: project.title,
      meta: 'Open project',
    }));

    const createResult: CommandResult[] = query.trim()
      ? [{ id: `create:${query.trim()}`, kind: 'create', group: 'Create', title: `Add task "${query.trim()}"`, meta: 'New task' }]
      : [];

    return [...taskResults, ...actionResults, ...projectResults, ...createResult];
  }, [actionTask, lowerQuery, matchingProjects, matchingTasks, projects, query]);

  useEffect(() => {
    function handleKey(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
      }
      if (event.key === 'Escape') setOpen(false);
    }

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    setActiveIndex(0);
    setActionTaskId(matchingTasks[0]?.id ?? null);
  }, [lowerQuery, matchingTasks]);

  useEffect(() => {
    if (activeIndex >= results.length) setActiveIndex(Math.max(0, results.length - 1));
  }, [activeIndex, results.length]);

  function createTask() {
    const title = query.trim();
    if (!title) return;
    onCreateTask(title);
    setQuery('');
    setOpen(false);
  }

  function activate(result: CommandResult | undefined) {
    if (!result) {
      createTask();
      return;
    }

    switch (result.kind) {
      case 'task':
        onOpenTask(result.task.id);
        break;
      case 'project':
        onOpenProject(result.project.id);
        break;
      case 'create':
        createTask();
        return;
      case 'action':
        onTaskAction(result.task.id, result.action);
        break;
    }

    setQuery('');
    setOpen(false);
  }

  function moveActive(delta: number) {
    if (results.length === 0) return;
    setActiveIndex(index => {
      const next = (index + delta + results.length) % results.length;
      const result = results[next];
      if (result?.kind === 'task') setActionTaskId(result.task.id);
      return next;
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      activate(results[activeIndex]);
    }
  }

  return (
    <div className="search-wrap">
      <div
        className={`search-bar${open ? ' open' : ''}`}
        onClick={() => {
          setOpen(true);
          inputRef.current?.focus();
        }}
      >
        <span className="search-icon">/</span>
        <input
          ref={inputRef}
          className="search-input"
          placeholder="Search tasks, projects, or add something new..."
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <span className="search-hint"><span className="kbd">Cmd</span><span className="kbd">K</span><span className="kbd">Enter</span></span>
      </div>

      {open && (
        <div className="search-dropdown">
          {results.length === 0 && <div className="sdrop-empty">No commands available</div>}
          {results.map((result, index) => (
            <CommandResultRow
              key={result.id}
              result={result}
              active={index === activeIndex}
              showGroup={index === 0 || results[index - 1].group !== result.group}
              onHover={() => {
                setActiveIndex(index);
                if (result.kind === 'task') setActionTaskId(result.task.id);
              }}
              onActivate={() => activate(result)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CommandResultRow({ result, active, showGroup, onHover, onActivate }: {
  result: CommandResult;
  active: boolean;
  showGroup: boolean;
  onHover: () => void;
  onActivate: () => void;
}) {
  const swatchColor = result.kind === 'task'
    ? projectColor(result.task.project_id)
    : result.kind === 'project'
      ? projectColor(result.project.id)
      : result.kind === 'action'
        ? 'var(--accent)'
        : 'var(--ink-4)';

  return (
    <>
      {showGroup && <div className="sdrop-group-label">{result.group}</div>}
      <button
        className={`sdrop-result${active ? ' active' : ''}`}
        onMouseEnter={onHover}
        onClick={onActivate}
      >
        <span className="sdrop-swatch" style={{ background: swatchColor }} />
        <span className="sdrop-title">{result.title}</span>
        <span className={result.kind === 'action' || result.kind === 'project' ? 'sdrop-tag' : 'sdrop-sub'}>{result.meta}</span>
      </button>
    </>
  );
}
