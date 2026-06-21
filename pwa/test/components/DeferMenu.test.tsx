// @vitest-environment jsdom
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeferMenu } from '../../src/components/task/DeferMenu';
import type { DeferInput } from '../../src/domain/taskMutations';

describe('DeferMenu', () => {
  test('choosing Someday emits { kind: "someday" } with no until field', async () => {
    const onChoose = vi.fn<(choice: DeferInput) => void>();
    render(<DeferMenu onChoose={onChoose} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /someday/i }));
    expect(onChoose).toHaveBeenCalledOnce();
    const choice = onChoose.mock.calls[0]![0] as DeferInput;
    expect(choice.kind).toBe('someday');
    expect('until' in choice).toBe(false);
  });

  test('choosing Tomorrow emits { kind: "until", until: IsoDateTime }', async () => {
    const onChoose = vi.fn<(choice: DeferInput) => void>();
    render(<DeferMenu onChoose={onChoose} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /tomorrow/i }));
    expect(onChoose).toHaveBeenCalledOnce();
    const choice = onChoose.mock.calls[0]![0] as DeferInput;
    expect(choice.kind).toBe('until');
    if (choice.kind !== 'until') return;
    expect(typeof choice.until).toBe('string');
    expect(choice.until).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('picking a custom date emits { kind: "until", until } with that date', async () => {
    const onChoose = vi.fn<(choice: DeferInput) => void>();
    render(<DeferMenu onChoose={onChoose} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /pick date/i }));
    const dateInput = screen.getByDisplayValue('');
    fireEvent.change(dateInput, { target: { value: '2026-08-01' } });
    await userEvent.click(screen.getByRole('button', { name: /^set$/i }));
    expect(onChoose).toHaveBeenCalledOnce();
    const choice = onChoose.mock.calls[0]![0] as DeferInput;
    expect(choice.kind).toBe('until');
    if (choice.kind !== 'until') return;
    expect(choice.until).toContain('2026-08-01');
  });

  test('Set button is disabled when no date is picked', async () => {
    render(<DeferMenu onChoose={() => {}} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /pick date/i }));
    const setButton = screen.getByRole('button', { name: /^set$/i });
    expect(setButton).toBeDisabled();
  });

  test('Cancel button calls onCancel', async () => {
    const onCancel = vi.fn();
    render(<DeferMenu onChoose={() => {}} onCancel={onCancel} taskTitle="My task" />);
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test('dialog has accessible label including task title', () => {
    render(<DeferMenu onChoose={() => {}} onCancel={() => {}} taskTitle="Review PR" />);
    expect(screen.getByRole('dialog', { name: /review pr/i })).toBeInTheDocument();
  });
});
