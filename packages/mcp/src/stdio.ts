#!/usr/bin/env -S node --experimental-strip-types
/**
 * MCP stdio entrypoint.
 *
 *   DEVANALYTICS_API_KEY=dva_... DEVANALYTICS_BASE_URL=https://... devanalytics-mcp
 *
 * Use a token whose role is `viewer` so the credential itself cannot write,
 * independently of the tools exposed here.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DevAnalytics } from '@devanalytics/sdk';
import { buildTools, findMutatingTools } from './server.js';

const apiKey = process.env.DEVANALYTICS_API_KEY;
if (!apiKey) {
  process.stderr.write('DEVANALYTICS_API_KEY is required.\n');
  process.exit(1);
}

const client = new DevAnalytics({
  apiKey,
  ...(process.env.DEVANALYTICS_BASE_URL ? { baseUrl: process.env.DEVANALYTICS_BASE_URL } : {}),
});

const tools = buildTools(client);
const mutating = findMutatingTools(tools);
if (mutating.length > 0) {
  // Fail closed: a mutating tool must never reach an agent from this server.
  process.stderr.write(`Refusing to start: mutating tools present (${mutating.join(', ')}).\n`);
  process.exit(1);
}

const server = new McpServer({ name: 'devanalytics', version: '0.1.0' });

for (const tool of tools) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.schema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: Record<string, unknown>) => {
      try {
        const result = await tool.handler(args ?? {});
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `${tool.name} failed: ${(err as Error).message}` }],
        };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
process.stderr.write(`DevAnalytics MCP server ready with ${tools.length} read-only tools.\n`);
