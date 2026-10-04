import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { handleApiRequest } from '../src/api';
import { handleMcpRequest, TOOLS, ADMIN_TOOLS } from '../src/mcp';
import { ADMIN_TOOL_NAMES, DEPRECATED_ALIASES, TOOL_ANNOTATIONS } from '../src/toolSurface';
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

describe('MCP tool tiers (phase A)', () => {
  it('annotates every default tool and nothing is left unclassified', () => {
    expect(TOOLS.length).toBe(39);
    for (const tool of TOOLS) expect(tool.annotations, tool.name).toBeDefined();
    expect(Object.keys(TOOL_ANNOTATIONS).sort()).toEqual(TOOLS.map(tool => tool.name).sort());
  });

  it('marks reads read-only and only delete/apply/restore destructive', () => {
    const byName = Object.fromEntries(TOOLS.map(tool => [tool.name, tool.annotations]));
    for (const name of ['get_capabilities', 'resolve_time', 'list_tasks', 'get_entity', 'preview_changes', 'export_workspace', 'get_workspace_snapshot', 'get_action_log', 'show_tasks']) {
      expect(byName[name], name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect(TOOLS.filter(tool => tool.annotations.destructiveHint).map(tool => tool.name).sort())
      .toEqual(['apply_changes', 'delete_project', 'delete_task', 'restore_workspace']);
    expect(byName.start_session).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const tool of TOOLS) expect(tool.annotations.openWorldHint).toBe(false);
  });

  it('keeps every moved tool on the default list as a deprecated alias with unchanged schema', () => {
    for (const name of Object.keys(DEPRECATED_ALIASES)) {
      const alias = TOOLS.find(tool => tool.name === name)!;
      const original = ADMIN_TOOLS.find(tool => tool.name === name);
      expect(alias.description, name).toMatch(/^Deprecated alias\./);
      if (original) expect(alias.inputSchema).toEqual(original.inputSchema);
    }
    expect(TOOLS.filter(tool => tool.description.startsWith('Deprecated alias.')).map(tool => tool.name).sort()).toEqual(Object.keys(DEPRECATED_ALIASES).sort());
  });

  it('lists exactly the admin set on /mcp/admin with original descriptions', async () => {
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

  it('still serves deprecated aliases on the default endpoint', async () => {
    const snapshot = await call('/mcp', 'default', 'tools/call', { name: 'get_workspace_snapshot', arguments: {} });
    expect(snapshot.result.structuredContent.cursor).toBeDefined();
    const exported = await call('/mcp', 'default', 'tools/call', { name: 'export_planning_settings', arguments: {} });
    expect(exported.result.structuredContent).toMatchObject({ kind: 'planning_settings' });
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
      expect(body.result.structuredContent.toolSurface).toEqual({ version: 1, commandCatalog: 1, adminEndpoint: '/mcp/admin' });
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
