import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { unpack } from './runtime';
import { ToolResult } from './api';

export async function checkConnection(executable: string, relay: string, registry: string, cwd: string): Promise<unknown> {
  const client = new Client({ name: 'codex-subagent-setup-check', version: '0.2.0' });
  const transport = new StdioClientTransport({ command: executable, args: [relay, '--registry', registry], cwd, env: { ...process.env as Record<string, string>, ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe' });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const tools = await client.listTools();
    const health = await client.callTool({ name: 'subagent_health', arguments: {} }, undefined, { timeout: 15_000 });
    return { handshake: 'passed', toolCount: tools.tools.length, host: unpack(health as ToolResult) };
  } finally {
    await client.close();
  }
}
