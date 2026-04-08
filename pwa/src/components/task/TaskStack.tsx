import { useState } from 'react';
import { taskMetaString } from './TaskMeta';
import type { Task } from '../../types';

interface Props {
  root: Task;
  blocked: Task[];
  today: string;
  onComplete: (id: string) => void;
  onDetail: (id: string) => void;
}

export function TaskStack({ root, blocked, today, onComplete, onDetail }: Props) {
  const [open, setOpen] = useState(false);
  const meta = taskMetaString(root, today);

  return (
    <div className="stack-card">
      <div className="stack-root">
        <input
          type="checkbox"
          className="cc-check"
          checked={root.status === 'done'}
          onChange={() => onComplete(root.id)}
          onClick={e => e.stopPropagation()}
        />
        <div className="stack-root-body" onClick={() => onDetail(root.id)}>
          {root.status === 'active' && <div className="cc-label">In progress</div>}
          <div className="stack-root-title">{root.title}</div>
          {meta && <div className="cc-meta">{meta}</div>}
        </div>
      </div>

      {open && (
        <div className="stack-linked">
          {blocked.map(t => (
            <div key={t.id} className="stack-link-row" onClick={() => onDetail(t.id)}>
              <span className="stack-link-title">{t.title}</span>
              <span className="stack-link-arrow">›</span>
            </div>
          ))}
        </div>
      )}

      <button className="stack-footer" onClick={() => setOpen(o => !o)}>
        {open ? `▾ ${blocked.length} linked` : `▸ ${blocked.length} linked`}
      </button>
    </div>
  );
}
