import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { handleApiRequest } from '../src/api';
import { handleMcpRequest, TOOLS, ADMIN_TOOLS } from '../src/mcp';
import { ADMIN_TOOL_NAMES, TOOL_ANNOTATIONS } from '../src/toolSurface';
import { sqliteD1 } from './helpers/sqliteD1';

const rpc = (path: string, method: string, params?: unknown) =>
  new Request(`https://alongside.test${path}`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

async function call(path: string, surface: 'default' | 'admin', method: string, params?: unknown) {
  const { sql, d1 } = sqliteD1();
  try {
    const response = await handleMcpRequest(rpc(path, method, params), new DB(d1), { DB: d1, AUTH_TOKEN: 't' }, surface);
    return await response.json() as { result?: any; error?: any };
  } finally { sql.close(); }
}

const DEFAULT_TOOLS = [
  'add_task', 'apply_changes', 'complete_task', 'defer_task', 'describe_commands', 'find', 'focus_task', 'get_capabilities',
  'get_context', 'get_history', 'preview_changes', 'resolve_time', 'show_tasks', 'update_task',
];

describe('MCP tool tiers', () => {
  it('lists exactly the neutral tool set on /mcp, every tool annotated', () => {
    expect(TOOLS.map(tool => tool.name).sort()).toEqual(DEFAULT_TOOLS);
    for (const tool of TOOLS) expect(tool.annotations, tool.name).toBeDefined();
    for (const tool of ADMIN_TOOLS) expect(tool.annotations, tool.name).toBeDefined();
    expect(Object.keys(TOOL_ANNOTATIONS).sort()).toEqual([...new Set([...TOOLS, ...ADMIN_TOOLS].map(tool => tool.name))].sort());
  });

  it('marks reads read-only and only apply and restore destructive', () => {
    const byName = Object.fromEntries([...TOOLS, ...ADMIN_TOOLS].map(tool => [tool.name, tool.annotations]));
    for (const name of ['get_capabilities', 'resolve_time', 'find', 'get_context', 'get_history', 'preview_changes', 'export_workspace', 'get_workspace_snapshot', 'show_tasks']) {
      expect(byName[name], name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect([...TOOLS, ...ADMIN_TOOLS].filter(tool => tool.annotations.destructiveHint).map(tool => tool.name).sort())
      .toEqual(['apply_changes', 'restore_workspace']);
    for (const tool of [...TOOLS, ...ADMIN_TOOLS]) expect(tool.annotations.openWorldHint).toBe(false);
  });

  it('lists exactly the admin set on /mcp/admin ', async () => {
    const listed = (await call('/mcp/admin', 'admin', 'tools/list')).result.tools as { name: string; description: string; annotations: unknown }[];
    expect(listed.map(tool => tool.name).sort()).toEqual([...ADMIN_TOOL_NAMES].sort());
    for (const tool of listed) { expect(tool.description).not.toMatch(/^Deprecated alias/); expect(tool.annotations).toBeDefined(); }
    expect(listed.find(tool => tool.name === 'restore_workspace')!.annotations).toMatchObject({ destructiveHint: true });
  });

  it('serves admin tools on admin and refuses everyday tools there', async () => {
    const snapshot = await call('/mcp/admin', 'admin', 'tools/call', { name: 'get_workspace_snapshot', arguments: {} });
    expect(snapshot.result.structuredContent.cursor).toMatchObject({ epoch: expect.any(Number), sequence: expect.any(Number) });
    const refused = await call('/mcp/admin', 'admin', 'tools/call', { name: 'add_task', arguments: { title: 'x' } });
    expect(refused.error?.message).toMatch(/Unknown tool/);
    expect((await call('/mcp/admin', 'admin', 'resources/list')).result.resources).toEqual([]);
  });

  it('refuses tools removed from the default endpoint', async () => {
    for (const name of ['start_session', 'list_tasks', 'list_projects', 'get_ready_tasks', 'show_project', 'get_action_log', 'get_entity', 'reopen_task', 'delete_task', 'create_project', 'link_tasks', 'update_preference',
      'get_workspace_snapshot', 'get_workspace_delta', 'get_entity_version', 'export_workspace', 'restore_workspace', 'export_planning_settings', 'preview_legacy_dates']) {
      const refused = await call('/mcp', 'default', 'tools/call', { name, arguments: {} });
      expect(refused.error?.message, name).toMatch(/Unknown tool/);
    }
  });

  it('sends neutral server instructions in initialize on the default endpoint only', async () => {
    const init = await call('/mcp', 'default', 'initialize');
    expect(init.result.instructions).toContain('does not prescribe a workflow');
    expect((await call('/mcp/admin', 'admin', 'initialize')).result.instructions).toBeUndefined();
  });

  it('reports the tool surface in capabilities', async () => {
    const { sql, d1 } = sqliteD1();
    try {
      const response = await handleMcpRequest(rpc('/mcp', 'tools/call', { name: 'get_capabilities', arguments: {} }), new DB(d1), { DB: d1, AUTH_TOKEN: 't' });
      const body = await response.json() as any;
      expect(body.result.structuredContent.toolSurface).toEqual({ version: 5, commandCatalog: 2, adminEndpoint: '/mcp/admin' });
    } finally { sql.close(); }
  });

  it('keeps REST routes for the sync reads that left the LLM surface', async () => {
    const { sql, d1 } = sqliteD1();
    try {
      const db = new DB(d1);
      for (const [method, path, body] of [
        ['GET', '/api/v2/sync/snapshot', undefined],
        ['POST', '/api/v2/sync/delta', { cursor: { epoch: 0, sequence: 0 } }],
        ['POST', '/api/v2/entity-version', { entity: 'task', id: 't_missing' }],
      ] as const) {
        const request = new Request(`https://alongside.test${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
        const response = await handleApiRequest(request, new URL(request.url), db);
        expect(response.status, path).toBe(200);
      }
    } finally { sql.close(); }
  });
});
