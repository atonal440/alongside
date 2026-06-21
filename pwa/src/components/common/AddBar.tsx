import { useState, type KeyboardEvent } from 'react';
import type { NonEmptyString } from '@shared/parse';
import { parseQuickAddTitle } from '../../domain/taskForm';

interface Props {
  onAdd: (title: NonEmptyString<200>) => void;
}

export function AddBar({ onAdd }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const result = parseQuickAddTitle(value);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    onAdd(result.value);
    setValue('');
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') submit();
  }

  return (
    <div className="add-bar">
      <input
        type="text"
        placeholder="Add a task..."
        value={value}
        onChange={e => { setValue(e.target.value); if (error) setError(null); }}
        onKeyDown={handleKey}
        aria-describedby={error ? 'add-bar-error' : undefined}
      />
      <button onClick={submit}>Add</button>
      {error && <span id="add-bar-error" className="add-bar-error" role="alert">{error}</span>}
    </div>
  );
}
