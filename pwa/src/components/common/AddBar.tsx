import { useState, type KeyboardEvent } from 'react';

interface Props {
  onAdd: (title: string) => void;
}

export function AddBar({ onAdd }: Props) {
  const [value, setValue] = useState('');

  function submit() {
    const title = value.trim();
    if (title) {
      onAdd(title);
      setValue('');
    }
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
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKey}
      />
      <button onClick={submit}>Add</button>
    </div>
  );
}
