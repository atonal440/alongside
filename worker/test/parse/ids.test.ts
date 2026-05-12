import { describe, expect, it } from 'vitest';
import { parseOAuthCode, parseProjectId, parseTaskId } from '@shared/parse';

describe('id parsers', () => {
  it('parses task and project id formats', () => {
    expect(parseTaskId('t_x7k2m').ok).toBe(true);
    expect(parseTaskId('T_X7K2M').ok).toBe(false);
    expect(parseTaskId('task_x7k2m').ok).toBe(false);
    expect(parseTaskId('t_').ok).toBe(false);

    expect(parseProjectId('p_x7k2m').ok).toBe(true);
    expect(parseProjectId('project_x7k2m').ok).toBe(false);
  });

  it('parses one-shot OAuth code format', () => {
    expect(parseOAuthCode('0123456789abcdef0123456789abcdef').ok).toBe(true);
    expect(parseOAuthCode('short').ok).toBe(false);
  });
});
