import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { DB } from '../src/db';
import { handleMcpRequest, TOOLS } from '../src/mcp';
import { getAppHtml } from '../src/app-ui';
import { sqliteD1 } from './helpers/sqliteD1';

/**
 * Run the task widget's real script against the real MCP handler through a fake host: the widget
 * posts JSON-RPC to window.parent, the host answers it from handleMcpRequest, and the DOM is a
 * minimal stub. This pins the tool names and argument shapes the widget depends on.
 */
function mountWidget(d1: D1Database, db: DB) {
  const script = [...getAppHtml().matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()![1]!;
  const toolCalls: { name: string; arguments: any }[] = [];
  const failing = new Set<string>();
  const listeners: Record<string, ((event: any) => void)[]> = {};
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { id, innerHTML: '', listeners: {} as Record<string, any>, classList: { add() {}, remove() {} },
      addEventListener(type: string, fn: any) { this.listeners[type] = fn; } });
    return elements.get(id);
  };
  const deliver = (data: unknown) => setTimeout(() => (listeners.message ?? []).forEach(fn => fn({ data })), 0);
  const window = {
    parent: { postMessage(message: any) {
      if (message.method === 'tools/call') {
        toolCalls.push(message.params);
        if (failing.has(message.params.name)) { deliver({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ text: 'refused' }] } }); return; }
        void handleMcpRequest(new Request('https://t/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: message.params }) }), db, { DB: d1, AUTH_TOKEN: 't' })
          .then(r => r.json()).then((body: any) => deliver({ jsonrpc: '2.0', id: message.id, ...(body.error ? { error: body.error } : { result: body.result }) }));
      } else if (message.id !== undefined && message.method === 'ui/initialize') deliver({ jsonrpc: '2.0', id: message.id, result: {} });
    } },
    addEventListener(type: string, fn: any) { (listeners[type] ??= []).push(fn); },
  };
  const document = {
    getElementById: element,
    createElement: () => ({ set textContent(v: string) { (this as any)._t = v; }, get innerHTML() { return String((this as any)._t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }),
    documentElement: { style: { setProperty() {} } }, head: { appendChild() {} }, body: { scrollWidth: 400, scrollHeight: 300 },
  };
  const errors: unknown[] = [];
  vm.runInNewContext(script, { window, document, requestAnimationFrame: (fn: () => void) => fn(), console: { error: (...a: unknown[]) => errors.push(a), warn() {} }, setTimeout, clearTimeout, Date, Map, Promise, Array, Object, String, JSON }, { timeout: 5000 });
  return {
    toolCalls, errors, failing, root: element('root'), toast: () => element('toast').innerHTML as string,
    show: (tasks: unknown[], projects = {}) => deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { tasks, projects } } }),
    tick: () => new Promise(resolve => setTimeout(resolve, 30)),
    toggle: async (id: string, checked: boolean) => {
      const box = { type: 'checkbox', dataset: { id }, checked, disabled: false, closest: () => ({ classList: { add() {}, remove() {} } }) };
      await element('root').listeners.change({ target: box });
      return box;
    },
  };
}
const sleep = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));

describe('task widget', () => {
  it('only calls tools that exist and are not deprecated or slated for removal', () => {
    const script = getAppHtml();
    const names = [...script.matchAll(/(?:rpcRequest\('tools\/call'|callTool)\(?,?\s*\{?\s*name:\s*'([a-z_]+)'|callTool\('([a-z_]+)'/g)].map(m => m[1] ?? m[2]!);
    expect(names.length).toBeGreaterThan(0);
    for (const name of new Set(names)) {
      const tool = TOOLS.find(t => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.description, name).not.toMatch(/^Deprecated/);
    }
    expect(script).not.toContain("'list_tasks'");
    expect(script).not.toContain("'reopen_task'");
  });

  it('refreshes through find and completes through complete_task, including a recurring task the calendar engine has adopted', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const a = await db.addTask({ title: 'Plain' });
      const b = await db.addTask({ title: 'Weekly', due_date: '2026-10-05', recurrence: 'FREQ=WEEKLY' });
      const widget = mountWidget(d1, db);
      await sleep();
      widget.show([a, b]);
      await sleep();
      expect(widget.root.innerHTML).toContain('Plain');
      await widget.toggle(a.id, true);
      await sleep();
      expect(widget.toolCalls.map(c => c.name)).toEqual(['complete_task', 'find']);
      expect(widget.toolCalls[1]!.arguments).toMatchObject({ entity: 'task', filter: { statuses: ['pending', 'done'] } });
      expect((await db.getTask(a.id))?.status).toBe('done');
      expect(widget.root.innerHTML).toMatch(/Plain[\s\S]*status-done/);
      await widget.toggle(b.id, true);
      await sleep();
      // The find above adopted the weekly task into a duty, so completion creates no successor; the calendar does.
      expect(widget.toast()).toBe('');
      expect(widget.errors).toEqual([]);
    } finally { sql.close(); }
  });

  it('reopens through preview_changes then apply_changes with the pinned envelope', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const task = await db.addTask({ title: 'Finished' });
      await db.completeTask(task.id);
      const widget = mountWidget(d1, db);
      await sleep();
      widget.show([{ ...(await db.getTask(task.id))! }]);
      await sleep();
      await widget.toggle(task.id, false);
      await sleep();
      expect(widget.toolCalls.map(c => c.name)).toEqual(['preview_changes', 'apply_changes', 'find']);
      expect(widget.toolCalls[0]!.arguments).toMatchObject({ intent: true, actor: 'user', commands: [{ kind: 'task.reopen', id: task.id }] });
      expect(widget.toolCalls[1]!.arguments.commandId).toMatch(/^c_/);
      expect(widget.toolCalls[1]!.arguments.commands[0]).toMatchObject({ kind: 'task.reopen', id: task.id, expectedRevision: expect.any(Number) });
      expect((await db.getTask(task.id))?.status).toBe('pending');
      expect(widget.errors).toEqual([]);
    } finally { sql.close(); }
  });

  it('follows find cursors until every displayed task is found', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const tasks = [];
      for (let i = 0; i < 205; i++) tasks.push(await db.addTask({ title: `T${String(i).padStart(3, '0')}`, due_date: `2027-01-01` }));
      const last = tasks[0]!;                                               // oldest task: last in find's newest-first order
      const widget = mountWidget(d1, db);
      await sleep();
      widget.show([last]);
      await sleep();
      await widget.toggle(last.id, true);
      await sleep(200);
      const finds = widget.toolCalls.filter(c => c.name === 'find');
      expect(finds).toHaveLength(2);                                          // 205 tasks, 200 per page
      expect(finds.slice(1).every(c => typeof c.arguments.cursor === 'string')).toBe(true);
      expect(widget.root.innerHTML).toContain(last.title);
      expect(widget.root.innerHTML).toContain('status-done');
    } finally { sql.close(); }
  });

  it('restores the checkbox and reports the error when the server refuses', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const task = await db.addTask({ title: 'Stubborn' });
      const widget = mountWidget(d1, db);
      await sleep();
      widget.show([task]);
      await sleep();
      widget.failing.add('complete_task');
      const box = await widget.toggle(task.id, true);
      expect(box.disabled).toBe(false);
      expect(box.checked).toBe(false);                                   // put back to where it was before the click
      expect(widget.errors.length).toBe(1);
      expect((await db.getTask(task.id))?.status).toBe('pending');
    } finally { sql.close(); }
  });
});
