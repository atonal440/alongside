import { describe, test, expect } from 'vitest';
import { deriveTaskFlow, TASK_FLOW_CHART } from '../../src/utils/taskFlow';
import type { TaskFlowContext } from '../../src/utils/taskFlow';
import { makeTask, makeLink, makeProject } from '../helpers/fixtures';

const TODAY = '2026-06-09';
const NOW = '2026-06-09T12:00:00.000Z';
const FAR_FUTURE_ISO = '2099-12-31T00:00:00.000Z';

function ctx(overrides: Partial<TaskFlowContext> = {}): TaskFlowContext {
  return { today: TODAY, nowIso: NOW, projects: [], links: [], ...overrides };
}

describe('deriveTaskFlow — mode precedence', () => {
  test('done task → mode "done"', () => {
    const task = makeTask({ status: 'done' });
    expect(deriveTaskFlow(task, ctx()).mode).toBe('done');
  });

  test('focused task → mode "focused"', () => {
    const task = makeTask({ focused_until: FAR_FUTURE_ISO });
    expect(deriveTaskFlow(task, ctx()).mode).toBe('focused');
  });

  test('someday task → mode "someday"', () => {
    const task = makeTask({ defer_kind: 'someday' });
    expect(deriveTaskFlow(task, ctx()).mode).toBe('someday');
  });

  test('deferred task → mode "deferred"', () => {
    const task = makeTask({ defer_kind: 'until', defer_until: FAR_FUTURE_ISO });
    expect(deriveTaskFlow(task, ctx()).mode).toBe('deferred');
  });

  test('blocked task → mode "blocked"', () => {
    const task = makeTask({ id: 't_target' });
    const blocker = makeTask({ id: 't_blocker', status: 'pending' });
    const link = makeLink({ from_task_id: 't_blocker', to_task_id: 't_target', link_type: 'blocks' });
    expect(deriveTaskFlow(task, ctx({ links: [link], tasks: [task, blocker] })).mode).toBe('blocked');
  });

  test('plain pending task → mode "ready"', () => {
    expect(deriveTaskFlow(makeTask(), ctx()).mode).toBe('ready');
  });

  test('done wins over focused', () => {
    const task = makeTask({ status: 'done', focused_until: FAR_FUTURE_ISO });
    expect(deriveTaskFlow(task, ctx()).mode).toBe('done');
  });

  // Guard against accidentally threading context.today (date-only string) into isFocused/isDeferred
  // instead of nowIso. A date-only string '2026-06-09' sorts *before* '2026-06-09T09:00:00.000Z'
  // so the comparison would wrongly read the expired focus as still active.
  test('focus expired earlier the same day → mode "ready", not "focused"', () => {
    const task = makeTask({ focused_until: '2026-06-09T09:00:00.000Z' }); // expired at 09:00
    expect(deriveTaskFlow(task, ctx()).mode).toBe('ready');               // nowIso is 12:00
  });

  test('defer expired earlier the same day → mode "ready", not "deferred"', () => {
    const task = makeTask({ defer_kind: 'until', defer_until: '2026-06-09T09:00:00.000Z' });
    expect(deriveTaskFlow(task, ctx()).mode).toBe('ready');
  });
});

describe('deriveTaskFlow — actions per surface', () => {
  test('done task on list → no primary action, no secondary actions', () => {
    const flow = deriveTaskFlow(makeTask({ status: 'done' }), ctx({ surface: 'list' }));
    expect(flow.primaryAction).toBeUndefined();
    expect(flow.secondaryActions).toHaveLength(0);
  });

  test('ready task on list → primary is focus', () => {
    const flow = deriveTaskFlow(makeTask(), ctx({ surface: 'list' }));
    expect(flow.primaryAction?.id).toBe('focus');
  });

  test('ready task on detail → primary is focus, has complete/defer/edit/delete', () => {
    const flow = deriveTaskFlow(makeTask(), ctx({ surface: 'detail' }));
    expect(flow.primaryAction?.id).toBe('focus');
    const ids = flow.secondaryActions.map(a => a.id);
    expect(ids).toContain('complete');
    expect(ids).toContain('defer');
    expect(ids).toContain('edit');
    expect(ids).toContain('delete');
  });

  test('focused task on focus surface → primary is complete', () => {
    const task = makeTask({ focused_until: FAR_FUTURE_ISO });
    const flow = deriveTaskFlow(task, ctx({ surface: 'focus' }));
    expect(flow.primaryAction?.id).toBe('complete');
  });

  test('someday task on queue → primary is reopen', () => {
    const task = makeTask({ defer_kind: 'someday' });
    const flow = deriveTaskFlow(task, ctx({ surface: 'queue' }));
    expect(flow.primaryAction?.id).toBe('reopen');
  });

  test('ready task on focus surface → primary is focus', () => {
    const flow = deriveTaskFlow(makeTask(), ctx({ surface: 'focus' }));
    expect(flow.primaryAction?.id).toBe('focus');
  });

  test('ready task on queue surface → primary is focus', () => {
    const flow = deriveTaskFlow(makeTask(), ctx({ surface: 'queue' }));
    expect(flow.primaryAction?.id).toBe('focus');
  });
});

describe('deriveTaskFlow — relationships', () => {
  test('blockedBy comes from blocks links pointing to this task', () => {
    const task = makeTask({ id: 't_target' });
    const blocker = makeTask({ id: 't_blocker', status: 'pending' });
    const link = makeLink({ from_task_id: 't_blocker', to_task_id: 't_target', link_type: 'blocks' });
    const flow = deriveTaskFlow(task, ctx({ links: [link], tasks: [task, blocker] }));
    expect(flow.relationships.blockedBy).toEqual(['t_blocker']);
  });

  test('unlocks comes from blocks links originating from this task', () => {
    const task = makeTask({ id: 't_blocker' });
    const link = makeLink({ from_task_id: 't_blocker', to_task_id: 't_other', link_type: 'blocks' });
    const flow = deriveTaskFlow(task, ctx({ links: [link] }));
    expect(flow.relationships.unlocks).toEqual(['t_other']);
  });

  test('related links do not appear in blockedBy or unlocks', () => {
    const task = makeTask({ id: 't_target' });
    const link = makeLink({ from_task_id: 't_other', to_task_id: 't_target', link_type: 'related' });
    const flow = deriveTaskFlow(task, ctx({ links: [link] }));
    expect(flow.relationships.blockedBy).toHaveLength(0);
    expect(flow.relationships.unlocks).toHaveLength(0);
  });
});

describe('deriveTaskFlow — metaLabel', () => {
  test('deferred with defer_until → "Until <month day>"', () => {
    const task = makeTask({ defer_kind: 'until', defer_until: '2026-12-25T00:00:00.000Z' });
    const flow = deriveTaskFlow(task, ctx());
    // metaLabel should be "Until Dec 25" (locale-formatted)
    expect(flow.metaLabel).toMatch(/Until/);
    expect(flow.metaLabel).toMatch(/25/);
  });

  test('someday → "Someday"', () => {
    expect(deriveTaskFlow(makeTask({ defer_kind: 'someday' }), ctx()).metaLabel).toBe('Someday');
  });

  test('ready → null', () => {
    expect(deriveTaskFlow(makeTask(), ctx()).metaLabel).toBeNull();
  });

  test('focused → null', () => {
    const task = makeTask({ focused_until: FAR_FUTURE_ISO });
    expect(deriveTaskFlow(task, ctx()).metaLabel).toBeNull();
  });
});

describe('deriveTaskFlow — project info', () => {
  test('project found → returns project title and color', () => {
    const p = makeProject({ id: 'p_1', title: 'My project' });
    const task = makeTask({ project_id: 'p_1' });
    const flow = deriveTaskFlow(task, ctx({ projects: [p] }));
    expect(flow.projectLabel).toBe('My project');
    expect(flow.projectColor).toBeTruthy();
  });

  test('no project → "No project"', () => {
    expect(deriveTaskFlow(makeTask(), ctx()).projectLabel).toBe('No project');
  });
});

describe('TASK_FLOW_CHART sanity', () => {
  test('last entry is "ready" (fallback)', () => {
    expect(TASK_FLOW_CHART.at(-1)?.mode).toBe('ready');
  });

  test('all 6 modes are covered', () => {
    const modes = TASK_FLOW_CHART.map(d => d.mode);
    expect(modes).toContain('done');
    expect(modes).toContain('focused');
    expect(modes).toContain('someday');
    expect(modes).toContain('deferred');
    expect(modes).toContain('blocked');
    expect(modes).toContain('ready');
  });
});
