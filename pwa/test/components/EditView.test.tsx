// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTask } from '../helpers/fixtures';
import { renderWithState } from '../helpers/renderWithState';
import { EditView } from '../../src/components/views/EditView';
import { resetIdb } from '../helpers/idb';
import { closeDb } from '../../src/idb/db';

vi.mock('../../src/context/actions', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/context/actions')>();
  return {
    ...original,
    updateTaskAction: vi.fn(),
    deleteTaskAction: vi.fn(),
    createLinkAction: vi.fn(),
    deleteLinkAction: vi.fn(),
  };
});

import { updateTaskAction } from '../../src/context/actions';

const TASK = makeTask({ id: 't_edit01', title: 'Write tests', recurrence: null, due_date: null });

beforeEach(async () => {
  closeDb();
  await resetIdb();
  vi.clearAllMocks();
});

function renderEditView() {
  return renderWithState(<EditView />, {
    tasks: [TASK],
    editingTaskId: TASK.id,
  });
}

describe('EditView — valid form', () => {
  test('saving a valid form calls updateTaskAction with typed patch', async () => {
    renderEditView();
    const titleInput = screen.getByLabelText(/title/i);
    fireEvent.change(titleInput, { target: { value: 'Updated title' } });
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(updateTaskAction).toHaveBeenCalledOnce();
    const [, patch] = (updateTaskAction as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(patch.title).toBe('Updated title');
  });

  test('saving with empty notes sets notes: null in patch', async () => {
    renderEditView();
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(updateTaskAction).toHaveBeenCalledOnce();
    const [, patch] = (updateTaskAction as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(patch.notes).toBeNull();
  });
});

describe('EditView — validation errors', () => {
  test('clearing the title shows inline error and does NOT call updateTaskAction', async () => {
    renderEditView();
    const titleInput = screen.getByLabelText(/title/i);
    fireEvent.change(titleInput, { target: { value: '' } });
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(updateTaskAction).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  test('has no recurrence field: repeating work is a duty, not a task field', () => {
    renderEditView();
    expect(screen.queryByLabelText(/recurrence/i)).toBeNull();
  });
});
