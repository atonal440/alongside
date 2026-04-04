import type { Task } from '../../types';
import { taskMetaString } from './TaskMeta';

interface Props {
  task: Task;
  today: string;
  /** Show "Mark done" + "Next" buttons (active task in suggest view) */
  isActive?: boolean;
  onSkip?: () => void;
  onStart?: () => void;
  onDone?: () => void;
  onNext?: () => void;
  onEdit?: (id: string) => void;
  /** Extra style for session view stacking */
  style?: React.CSSProperties;
}

export function TaskCard({
  task, today, isActive, onSkip, onStart, onDone, onNext, onEdit, style,
}: Props) {
  const meta = taskMetaString(task, today);

  return (
    <div className="task-card" style={style}>
      {meta && <div className="card-label">{meta}</div>}
      <div className="card-title">{task.title}</div>
      {task.notes && <div className="card-notes">{task.notes}</div>}
      {task.kickoff_note && <div className="card-kickoff">{task.kickoff_note}</div>}
      {onEdit && (
        <button className="card-edit-link" onClick={() => onEdit(task.id)}>Edit ›</button>
      )}
      <div className="card-actions">
        {isActive ? (
          <>
            <button className="btn-skip" onClick={onDone}>Mark done</button>
            <button className="btn-act" onClick={onNext}>Next ›</button>
          </>
        ) : (
          <>
            {onSkip && <button className="btn-skip" onClick={onSkip}>Skip →</button>}
            {onStart && <button className="btn-act" onClick={onStart}>Start this</button>}
            {onDone && !onStart && <button className="btn-act" onClick={onDone}>Mark done</button>}
          </>
        )}
      </div>
    </div>
  );
}
