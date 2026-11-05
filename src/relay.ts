import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpInstructions, mcpTools } from './api';
import { forward } from './bridge';
import { failure } from './types';

async function main(): Promise<void> {
  const registry = process.argv[process.argv.indexOf('--registry') + 1];
  if (!process.argv.includes('--registry') || !registry) {
    throw new Error('Usage: relay.js --registry <extension bridge directory>');
  }
  const server = new Server({ name: 'codex-subagent', version: '0.2.0' }, { capabilities: { tools: {}, logging: {} }, instructions: mcpInstructions });
  const tracked = new Map<string, { state: string; workspaceRoot?: string }>();
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: mcpTools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (!mcpTools.some(tool => tool.name === request.params.name)) {
        throw new Error('Unknown MCP tool.');
      }
      const result = await forward(registry, process.cwd(), request.params.name, request.params.arguments || {}, extra.signal);
      if (!result.isError && ['subagent_spawn', 'subagent_send', 'subagent_resume'].includes(request.params.name)) {
        const worker = JSON.parse(result.content[0].text) as { id: string; state: string; workspaceRoot?: string };
        tracked.set(worker.id, { state: worker.state, workspaceRoot: worker.workspaceRoot });
      }
      return result;
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: failure(error) }) }] };
    }
  });
  // Discovery happens per call, so a VS Code reload never pins an obsolete token/port.
  await server.connect(new StdioServerTransport());
  let polling = false;
  const timer = setInterval(() => {
    if (polling || !tracked.size) {
      return;
    }
    polling = true;
    void (async () => {
      for (const [id, old] of tracked) {
        try {
          const result = await forward(registry, process.cwd(), 'subagent_status', { id, outputLimit: 4000, workspaceRoot: old.workspaceRoot });
          if (result.isError) {
            continue;
          }
          const worker = JSON.parse(result.content[0].text) as { id: string; state: string; title: string; output: string };
          if (!['queued', 'running'].includes(worker.state)) {
            tracked.delete(id);
            if (worker.state !== old.state || worker.state === 'completed') {
              await server.sendLoggingMessage({ level: worker.state === 'failed' ? 'warning' : 'info', logger: 'codex-subagent', data: { event: 'worker_stopped', ...worker } }).catch(() => undefined);
            }
          }
        } catch { /* Host reload; retain tracked workers until reconnection. */ }
      }
    })().finally(() => {
      polling = false;
    });
  }, 2000);
  timer.unref();
  process.stdin.on('end', () => {
    clearInterval(timer);
    void server.close();
  });
}
void main().catch(error => {
  process.stderr.write(`Codex Subagent relay: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
});
