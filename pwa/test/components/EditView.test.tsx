// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTask } from '../helpers/fixtures';
import { renderWithState } from '../helpers/renderWithState';
import { EditView } from '../../src/components/views/EditView';
import { resetIdb } from '../helpers/idb';
import { idbPutTask } from '../../src/idb/tasks';
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
  await idbPutTask(TASK);
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
    const [, patch] = (updateTaskAction as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(patch.title).toBe('Updated title');
  });

  test('saving with empty notes sets notes: null in patch', async () => {
    renderEditView();
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(updateTaskAction).toHaveBeenCalledOnce();
    const [, patch] = (updateTaskAction as ReturnType<typeof vi.fn>).mock.calls[0];
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

  test('recurrence without due date shows inline error and does NOT call updateTaskAction', async () => {
    const task = makeTask({ id: 't_edit02', recurrence: 'FREQ=WEEKLY;INTERVAL=1', due_date: null });
    await idbPutTask(task);
    renderWithState(<EditView />, {
      tasks: [task],
      editingTaskId: task.id,
    });
    // The form initially has recurrence set — clearing due date should block save
    // Alternatively select recurrence while no due date is set
    // In the current form, recurrence is a <select>. Picking a value without due date should error.
    const recurrenceSelect = screen.getByLabelText(/recurrence/i);
    fireEvent.change(recurrenceSelect, { target: { value: 'FREQ=DAILY;INTERVAL=1' } });
    // Ensure due date is empty (default is '' for task with due_date: null)
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(updateTaskAction).not.toHaveBeenCalled();
    const alerts = screen.getAllByRole('alert');
    const recurrenceError = alerts.find(el => el.textContent?.match(/due date/i));
    expect(recurrenceError).toBeDefined();
  });

  test('fixing a recurrence error then saving calls updateTaskAction', async () => {
    renderEditView();
    const recurrenceSelect = screen.getByLabelText(/recurrence/i);
    fireEvent.change(recurrenceSelect, { target: { value: 'FREQ=WEEKLY;INTERVAL=1' } });
    // Save without due date → error
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(updateTaskAction).not.toHaveBeenCalled();
    // Now add a due date
    const dueDateInput = screen.getByLabelText(/due date/i);
    fireEvent.change(dueDateInput, { target: { value: '2026-07-15' } });
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(updateTaskAction).toHaveBeenCalledOnce();
  });
});
