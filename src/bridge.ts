import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer, request, Server } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { atomicWrite } from './storage';
import { ToolResult } from './api';
import { failure, WorkerError } from './types';
import { contains, worktreeRoot } from './workspaces';

export interface Descriptor { schema: 1; id: string; pid: number; port: number; token: string; roots: string[]; createdAt: string }
export class BridgeHost {
  private server?: Server;
  private file?: string;
  async start(registry: string, roots: string[], invoke: (name: string, args: unknown, signal: AbortSignal, cwd?: string) => Promise<ToolResult>): Promise<void> {
    roots = await Promise.all(roots.map(root => fs.realpath(root)));
    const token = randomBytes(32).toString('hex');
    const server = createServer((req, res) => {
      const expected = Buffer.from(`Bearer ${token}`);
      const received = Buffer.from(req.headers.authorization || '');
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        res.writeHead(401).end(); return;
      }
      if (req.headers.origin || req.headers.host !== `127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`) {
        res.writeHead(403).end(); return;
      }
      if (req.method !== 'POST' || req.url !== '/invoke' || req.headers['content-type'] !== 'application/json') {
        res.writeHead(404).end(); return;
      }
      let body = '';
      let bytes = 0;
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) {
          controller.abort();
        }
      });
      req.on('error', () => controller.abort());
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1_000_000) {
          res.writeHead(413).end(); req.destroy(); return;
        }
        body += chunk;
      });
      req.on('end', () => {
        if (bytes > 1_000_000) {
          return;
        }
        void (async () => {
          try {
            const input = JSON.parse(body) as { name: string; args: unknown; cwd?: string };
            if (!input || typeof input.name !== 'string') {
              res.writeHead(400).end(); return;
            }
            const cwd = input.cwd ? await fs.realpath(input.cwd) : roots[0];
            if (!roots.some(root => contains(root, cwd)) && !await worktreeRoot(cwd, roots)) {
              res.writeHead(403).end(); return;
            }
            const result = await invoke(input.name, input.args, controller.signal, cwd);
            if (!res.destroyed) {
              res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result));
            }
          } catch (error) {
            if (!res.destroyed) {
              res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: failure(error) }) }] }));
            }
          }
        })();
      });
    });
    server.requestTimeout = 35_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject); resolve();
      });
    });
    this.server = server;
    const descriptor: Descriptor = { schema: 1, id: randomUUID(), pid: process.pid, port: (server.address() as import('node:net').AddressInfo).port, token, roots, createdAt: new Date().toISOString() };
    this.file = path.join(registry, `${descriptor.id}.json`);
    try {
      await atomicWrite(this.file, JSON.stringify(descriptor));
    } catch (error) {
      await this.close(); throw error;
    }
  }
  async close(): Promise<void> {
    if (this.file) {
      await fs.rm(this.file, { force: true }); this.file = undefined;
    }
    if (this.server) {
      const server = this.server; this.server = undefined;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
}

export async function discover(registry: string, cwd: string, ownerRoot?: string): Promise<Descriptor> {
  let entries: string[];
  try {
    entries = await fs.readdir(registry);
  } catch {
    throw new WorkerError('host_unavailable', 'Open a trusted VS Code workspace with Codex Subagent enabled.');
  }
  const candidates: { descriptor: Descriptor; score: number }[] = [];
  const realCwd = await fs.realpath(cwd);
  for (const entry of entries) {
    if (!/^[a-f0-9-]+\.json$/.test(entry)) {
      continue;
    }
    try {
      const d = JSON.parse(await fs.readFile(path.join(registry, entry), 'utf8')) as Descriptor;
      if (d.schema !== 1 || typeof d.id !== 'string' || !/^[a-f0-9-]{36}$/.test(d.id) || !Number.isInteger(d.pid) || d.pid <= 0 || !Number.isInteger(d.port) || d.port < 1 || d.port > 65535 || !/^[a-f0-9]{64}$/.test(d.token) || !Array.isArray(d.roots)) {
        continue;
      }
      if (ownerRoot !== undefined && !d.roots.includes(ownerRoot)) {
        continue;
      }
      try {
        process.kill(d.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          continue;
        }
      }
      const matches = d.roots.filter(root => {
        const rel = path.relative(root, realCwd); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
      });
      if (matches.length) {
        candidates.push({ descriptor: d, score: Math.max(...matches.map(r => r.length)) });
      } else if (await worktreeRoot(realCwd, d.roots)) {
        candidates.push({ descriptor: d, score: 0 });
      }
    } catch { /* Ignore stale or incomplete registry entries. */ }
  }
  candidates.sort((a, b) => b.score - a.score || a.descriptor.id.localeCompare(b.descriptor.id));
  if (!candidates.length) {
    throw new WorkerError('host_unavailable', `No worker host matches ${cwd}. Open this workspace or its Git repository in VS Code.`);
  }
  // Several checkouts can discover a new, not-yet-owned worktree. Pick one
  // deterministically to claim it; its exact-root descriptor wins future calls.
  if (candidates.length > 1 && candidates[0].score > 0 && candidates[0].score === candidates[1].score) {
    throw new WorkerError('ambiguous_host', 'Multiple worker hosts match this workspace. Close duplicate windows.');
  }
  return candidates[0].descriptor;
}

export async function forward(registry: string, cwd: string, name: string, args: unknown, signal?: AbortSignal, ownerRoot?: string): Promise<ToolResult> {
  // A multi-folder window can attach to different owners for each folder. Route
  // explicit roots at the relay boundary, rather than asking the cwd's owner to
  // operate on a folder that isn't open in that owner's window.
  if (ownerRoot === undefined && args && typeof args === 'object' && 'workspaceRoot' in args && typeof args.workspaceRoot === 'string' && path.isAbsolute(args.workspaceRoot)) {
    try {
      await discover(registry, args.workspaceRoot); cwd = args.workspaceRoot;
    } catch (error) {
      if (failure(error).code !== 'host_unavailable' && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      // Let the original workspace host return its normal scope validation error.
    }
  }
  // Once a broker found a locked store, fallback discovery is no longer valid:
  // another checkout (including this broker) cannot proxy its own request again.
  const descriptor = await discover(registry, cwd, ownerRoot);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name, args, cwd });
    const req = request({ hostname: '127.0.0.1', port: descriptor.port, path: '/invoke', method: 'POST', agent: false, signal, headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let content = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        content += chunk; if (content.length > 10_000_000) {
          req.destroy(new Error('Oversized bridge response'));
        }
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new WorkerError('bridge_unavailable', `Worker host returned HTTP ${res.statusCode}. Reopen VS Code; retry mutations with the SAME requestId.`, true)); return;
        }
        try {
          resolve(JSON.parse(content) as ToolResult);
        } catch {
          reject(new WorkerError('bridge_protocol', 'Invalid bridge response.'));
        }
      });
    });
    req.setTimeout(32_000, () => req.destroy(new Error('Bridge timed out. Retry with the SAME requestId; work continues in VS Code.')));
    req.on('error', error => reject(new WorkerError('bridge_unavailable', `${error.message} Work may already be accepted. Retry with the SAME requestId.`, true)));
    req.end(body);
  });
}
