import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/mcp';

describe('MCP tool metadata', () => {
  it('describes defer_task until as an ISO timestamp', () => {
    const tool = TOOLS.find(candidate => candidate.name === 'defer_task');
    expect(tool).toBeDefined();

    const inputSchema = tool?.inputSchema as {
      properties?: Record<string, { description?: string }>;
    };

    expect(tool?.description).toContain('ISO timestamp');
    expect(inputSchema.properties?.kind?.description).toContain('timestamp');
    expect(inputSchema.properties?.until?.description).toContain('ISO 8601 timestamp');
  });
});
