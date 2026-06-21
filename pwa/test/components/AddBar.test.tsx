// @vitest-environment jsdom
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddBar } from '../../src/components/common/AddBar';
import type { NonEmptyString } from '@shared/parse';

describe('AddBar', () => {
  test('Enter on whitespace-only input does nothing', async () => {
    const onAdd = vi.fn();
    render(<AddBar onAdd={onAdd} />);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '   {Enter}');
    expect(onAdd).not.toHaveBeenCalled();
  });

  test('valid title on Enter fires onAdd with branded title and clears input', async () => {
    const onAdd = vi.fn();
    render(<AddBar onAdd={onAdd} />);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'Buy groceries{Enter}');
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onAdd).toHaveBeenCalledWith('Buy groceries');
    expect((input as HTMLInputElement).value).toBe('');
  });

  test('valid title via Add button fires onAdd', async () => {
    const onAdd = vi.fn();
    render(<AddBar onAdd={onAdd} />);
    await userEvent.type(screen.getByRole('textbox'), 'Buy eggs');
    await userEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(onAdd).toHaveBeenCalledWith('Buy eggs');
  });

  test('pasting a 201-char title shows error and does not fire onAdd', async () => {
    const onAdd = vi.fn();
    render(<AddBar onAdd={onAdd} />);
    const longTitle = 'a'.repeat(201);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, `${longTitle}{Enter}`);
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  test('error clears when user starts typing after a failure', async () => {
    const onAdd = vi.fn();
    render(<AddBar onAdd={onAdd} />);
    // Trigger error
    await userEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // Start typing to clear
    await userEvent.type(screen.getByRole('textbox'), 'h');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('onAdd parameter is typed as NonEmptyString<200> (compile-time check)', () => {
    // This test merely verifies the prop shape compiles.
    const onAdd = (_title: NonEmptyString<200>) => {};
    expect(() => render(<AddBar onAdd={onAdd} />)).not.toThrow();
  });
});
