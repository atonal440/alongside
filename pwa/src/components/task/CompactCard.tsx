import type { Task } from '../../types';
import { taskMetaString } from './TaskMeta';

interface Props {
  task: Task;
  today: string;
  cssClass?: string;
  onComplete?: (id: string) => void;
  onDetail?: (id: string) => void;
}

export function CompactCard({ task, today, cssClass = '', onComplete, onDetail }: Props) {
  const done = task.status === 'done';
  const label = task.status === 'active' ? 'In progress' : '';
  const meta = taskMetaString(task, today);

  return (
    <div className={`compact-card${done ? ' done' : ''}${cssClass ? ` ${cssClass}` : ''}`}>
      <input
        type="checkbox"
        className="cc-check"
        checked={done}
        onChange={() => onComplete?.(task.id)}
        onClick={e => e.stopPropagation()}
      />
      <div className="cc-body" onClick={() => onDetail?.(task.id)}>
        {label && <div className="cc-label">{label}</div>}
        <div className="cc-title">{task.title}</div>
        {meta && <div className="cc-meta">{meta}</div>}
      </div>
    </div>
  );
}
