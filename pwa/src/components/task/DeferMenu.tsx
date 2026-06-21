import { useState } from 'react';
import type { DeferInput } from '../../domain/taskMutations';
import type { IsoDateTime } from '@shared/parse';

interface Props {
  onChoose: (choice: DeferInput) => void;
  onCancel: () => void;
  taskTitle?: string;
}

function isoForDaysFromNow(days: number): IsoDateTime {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d.toISOString() as IsoDateTime;
}

export function DeferMenu({ onChoose, onCancel, taskTitle }: Props) {
  const [pickingDate, setPickingDate] = useState(false);
  const [date, setDate] = useState('');

  function pickDays(days: number) {
    onChoose({ kind: 'until', until: isoForDaysFromNow(days) });
  }

  function submitPickedDate() {
    if (!date) return;
    onChoose({
      kind: 'until',
      until: new Date(`${date}T09:00:00`).toISOString() as IsoDateTime,
    });
  }

  return (
    <div className="defer-menu" role="dialog" aria-label={taskTitle ? `Defer ${taskTitle}` : 'Defer this task'}>
      <div className="defer-menu-title">{taskTitle ? `Defer "${taskTitle}" until...` : 'Defer until...'}</div>
      <div className="defer-menu-options">
        <button className="defer-option" onClick={() => pickDays(1)}>Tomorrow</button>
        <button className="defer-option" onClick={() => pickDays(7)}>Next week</button>
        <button className="defer-option" onClick={() => pickDays(14)}>2 weeks</button>
        <button className="defer-option" onClick={() => onChoose({ kind: 'someday' })}>Someday</button>
        {!pickingDate ? (
          <button className="defer-option ghost" onClick={() => setPickingDate(true)}>Pick date…</button>
        ) : (
          <div className="defer-date-row">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="defer-date-input"
              autoFocus
            />
            <button className="defer-option" onClick={submitPickedDate} disabled={!date}>Set</button>
          </div>
        )}
      </div>
      <div className="defer-menu-footer">
        <button className="defer-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
