import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { atomicWrite, Mutex } from './storage';
import { abortable } from './async';
import { ChangeContent, Session, Tool, WorkerError, WorkspaceTools } from './types';

const schemas = {
  read_file: z.object({ path: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100_000).default(20_000) }).strict(),
  list_files: z.object({ path: z.string().default('.'), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100) }).strict(),
  search_files: z.object({ query: z.string().min(1).max(1000), path: z.string().default('.'), limit: z.number().int().min(1).max(200).default(50) }).strict(),
  write_file: z.object({ path: z.string().min(1), content: z.string().max(500_000), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).or(z.literal('new')) }).strict(),
  create_directory: z.object({ path: z.string().min(1) }).strict(),
  patch_file: z.object({ path: z.string().min(1), expectedHash: z.string().regex(/^[a-f0-9]{64}$/), oldText: z.string().min(1).max(500_000), newText: z.string().max(500_000) }).strict(),
  delete_file: z.object({ path: z.string().min(1), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  rename_file: z.object({ path: z.string().min(1), target: z.string().min(1), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  run_command: z.object({ command: z.string().min(1).max(4000), path: z.string().default('.'), timeoutMs: z.number().int().min(1000).max(120_000).default(60_000) }).strict()
};
const descriptions: Record<keyof typeof schemas, string> = {
  read_file: 'Read a UTF-8 workspace file in character pages. Returns SHA-256 of the full file for optimistic writes; use nextOffset for more.',
  list_files: 'List a workspace directory (one level), with pagination. Symlinks are not followed.',
  search_files: 'Search literal text recursively in workspace UTF-8 files. Bounded search excludes symlinks, hidden directories, dependencies and build output; reports truncation.',
  write_file: 'Create or replace a workspace file. Requires expectedHash from read_file, or "new" for a new file. Never overwrites modified content or dirty editors. Protected configuration directories cannot be written.',
  create_directory: 'Create a workspace directory. Its parent must already exist. Existing directories succeed without modification. Protected configuration paths and symlinks are rejected.',
  patch_file: 'Replace exactly one occurrence of oldText with newText in a file, using its current SHA-256 hash. Ambiguous or stale edits fail. Changes are reviewable in VS Code.',
  delete_file: 'Delete a workspace file only if its current hash matches expectedHash. A recoverable before-image is saved for the worker change review.',
  rename_file: 'Rename a workspace file to a new path. Requires its current expectedHash and a nonexistent destination. The parent directory must exist.',
  run_command: 'Run a shell command only after the user approves the exact command in VS Code. No Codex sandbox or approval is inherited. Output is bounded; cancelled commands may have partial side effects.'
};
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const skipped = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor']);

export interface FileToolOptions {
  canWrite: () => boolean;
  allowShell: () => boolean;
  checkDocument?: (file: string) => void;
  approveCommand?: (command: string, cwd: string, signal: AbortSignal) => Promise<boolean>;
  readOpenText?: (file: string) => string | undefined;
  applyChange?: (change: ChangeContent, expectedHash: string) => Promise<void>;
  recordChange?: (session: Session, change: ChangeContent) => Promise<void>;
  finishChange?: (session: Session, change: ChangeContent) => Promise<void>;
}

export class FileTools implements WorkspaceTools {
  private writes = new Mutex();
  private constructor(readonly roots: string[], private readonly options: FileToolOptions) {}
  get workspaceRoot(): string {
    return this.roots[0];
  }
  forSession(session: Session): FileTools {
    if (!session.workspaceRoot || session.workspaceRoot === this.roots[0]) {
      return this;
    }
    if (!this.roots.includes(session.workspaceRoot)) {
      throw new WorkerError('workspace_changed', 'This worker’s original root was removed. Add it back before resuming; relative paths will not be redirected.');
    }
    const scoped = new FileTools([session.workspaceRoot, ...this.roots.filter(r => r !== session.workspaceRoot)], this.options);
    scoped.writes = this.writes;
    return scoped;
  }
  static async create(roots: string[], options: FileToolOptions): Promise<FileTools> {
    return new FileTools(await Promise.all(roots.map(root => fs.realpath(root))), options);
  }
  definitions(permission: Session['permission']): Tool[] {
    return (Object.keys(schemas) as (keyof typeof schemas)[]).filter(name => {
      if (['write_file', 'create_directory', 'patch_file', 'delete_file', 'rename_file'].includes(name)) {
        return permission === 'workspace-write' && this.options.canWrite();
      }
      if (name === 'run_command') {
        return permission === 'workspace-write' && this.options.allowShell();
      }
      return true;
    }).map(name => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name]) }));
  }
  private contains(file: string): boolean {
    return this.roots.some(root => {
      const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    });
  }
  private async resolve(input: string, write = false): Promise<string> {
    if (input.includes('\0')) {
      throw new WorkerError('invalid_path', 'NUL in path.');
    }
    const candidate = path.resolve(this.roots[0], input);
    if (!this.contains(candidate)) {
      throw new WorkerError('outside_workspace', 'Path is outside the workspace roots.');
    }
    // Reject symlinks in every component, including links that point back inside.
    const root = this.roots.filter(root => candidate === root || candidate.startsWith(root + path.sep)).sort((a, b) => b.length - a.length)[0];
    const segments = path.relative(root, candidate).split(path.sep).filter(Boolean);
    if (write && segments.some(segment => ['.git', '.codex', '.vscode'].includes(segment))) {
      throw new WorkerError('protected_path', 'Worker writes to .git, .codex and .vscode are disabled.');
    }
    let current = root;
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) {
          throw new WorkerError('symlink', 'Symlink paths are not supported.');
        }
      } catch (error) {
        if (write && i === segments.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          break;
        }
        throw error;
      }
    }
    return candidate;
  }
  private async text(file: string): Promise<string> {
    const open = this.options.readOpenText?.(file);
    if (open !== undefined) {
      return open;
    }
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 2_000_000) {
      throw new WorkerError('file_limit', 'Only regular files up to 2 MB can be read.');
    }
    const data = await fs.readFile(file);
    if (data.length > 2_000_000 || data.includes(0)) {
      throw new WorkerError('file_limit', 'Binary or oversized file.');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  }
  async execute(name: string, input: Record<string, unknown>, permission: Session['permission'], signal: AbortSignal, session?: Session): Promise<string> {
    signal.throwIfAborted();
    if (name === 'read_file') {
      const args = schemas.read_file.parse(input);
      const file = await this.resolve(args.path);
      const text = await this.text(file);
      const end = args.offset + args.limit;
      return JSON.stringify({ path: file, hash: hash(text), content: text.slice(args.offset, end), totalCharacters: text.length, nextOffset: end < text.length ? end : null });
    }
    if (name === 'list_files') {
      const args = schemas.list_files.parse(input);
      const file = await this.resolve(args.path);
      const entries = (await fs.readdir(file, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      const end = args.offset + args.limit;
      return JSON.stringify({ path: file, entries: entries.slice(args.offset, end).map(e => ({ name: e.name, type: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file' })), nextOffset: end < entries.length ? end : null });
    }
    if (name === 'search_files') {
      const args = schemas.search_files.parse(input);
      const start = await this.resolve(args.path);
      const results: { path: string; line: number; text: string }[] = [];
      const queue = [start];
      let visited = 0;
      let truncated = false;
      while (queue.length) {
        signal.throwIfAborted();
        const next = await this.resolve(queue.shift()!);
        if (++visited > 2000 || results.length >= args.limit) {
          truncated = true; break;
        }
        const stat = await fs.stat(next);
        if (stat.isDirectory()) {
          const entries = await fs.readdir(next, { withFileTypes: true });
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isSymbolicLink() || entry.name.startsWith('.') || skipped.has(entry.name)) {
              continue;
            }
            if (queue.length >= 4000) {
              truncated = true; break;
            }
            queue.push(path.join(next, entry.name));
          }
        } else if (stat.isFile() && stat.size <= 200_000) {
          let content: string;
          try {
            content = await this.text(next);
          } catch {
            continue;
          }
          const lines = content.split('\n');
          for (let line = 0; line < lines.length; line++) {
            if (lines[line].includes(args.query)) {
              results.push({ path: next, line: line + 1, text: lines[line].slice(0, 1000) });
              if (results.length >= args.limit) {
                truncated = true; break;
              }
            }
          }
        }
      }
      return JSON.stringify({ results, truncated, visited });
    }
    if (name === 'create_directory') {
      if (permission !== 'workspace-write' || !this.options.canWrite()) {
        throw new WorkerError('permission_denied', 'Workspace writes are disabled.');
      }
      const args = schemas.create_directory.parse(input);
      return this.writes.run(async () => {
        signal.throwIfAborted();
        const directory = await this.resolve(args.path, true);
        try {
          await fs.mkdir(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await fs.lstat(directory)).isDirectory()) {
            throw error;
          }
        }
        return JSON.stringify({ path: directory, created: true });
      });
    }
    if (name === 'write_file') {
      if (permission !== 'workspace-write' || !this.options.canWrite()) {
        throw new WorkerError('permission_denied', 'Workspace writes are disabled.');
      }
      const args = schemas.write_file.parse(input);
      return this.writes.run(async () => {
        signal.throwIfAborted();
        const file = await this.resolve(args.path, true);
        this.options.checkDocument?.(file);
        const existing = await fs.lstat(file).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
          } throw error;
        });
        const before = existing ? await this.text(file) : null;
        if (args.expectedHash === 'new') {
          if (existing) {
            throw new WorkerError('file_conflict', 'File exists; read it before replacing it.');
          }
          // Exclusive creation prevents a concurrent creator being overwritten.
        } else {
          if (!existing || !existing.isFile() || existing.nlink > 1 || hash(before!) !== args.expectedHash) {
            throw new WorkerError('file_conflict', 'File changed, is hard-linked, or is missing. Read it again.');
          }
          signal.throwIfAborted();
        }
        const change = await this.saveChange({ path: file, kind: 'write', before, after: args.content }, args.expectedHash, signal, session);
        return JSON.stringify({ path: file, hash: hash(change.after!), bytes: Buffer.byteLength(change.after!), changeId: change.id });
      });
    }
    if (name === 'patch_file') {
      const args = schemas.patch_file.parse(input);
      const file = await this.resolve(args.path, true);
      const before = await this.text(file);
      if (hash(before) !== args.expectedHash) {
        throw new WorkerError('file_conflict', 'File changed. Read again before patching.');
      }
      const first = before.indexOf(args.oldText);
      if (first < 0 || before.indexOf(args.oldText, first + 1) >= 0) {
        throw new WorkerError('patch_conflict', 'oldText must match exactly once. Supply more surrounding context.');
      }
      return this.execute('write_file', { path: file, expectedHash: args.expectedHash, content: before.slice(0, first) + args.newText + before.slice(first + args.oldText.length) }, permission, signal, session);
    }
    if (name === 'delete_file' || name === 'rename_file') {
      if (permission !== 'workspace-write' || !this.options.canWrite()) {
        throw new WorkerError('permission_denied', 'Workspace writes are disabled.');
      }
      const args = name === 'delete_file' ? schemas.delete_file.parse(input) : schemas.rename_file.parse(input);
      return this.writes.run(async () => {
        const file = await this.resolve(args.path, true);
        this.options.checkDocument?.(file);
        const stat = await fs.lstat(file);
        const before = await this.text(file);
        if (!stat.isFile() || stat.nlink > 1 || hash(before) !== args.expectedHash) {
          throw new WorkerError('file_conflict', 'File changed or is not an independent regular file.');
        }
        const target = 'target' in args && typeof args.target === 'string' ? await this.resolve(args.target, true) : undefined;
        if (target && await fs.lstat(target).catch(() => undefined)) {
          throw new WorkerError('file_conflict', 'Rename destination already exists.');
        }
        const change = await this.saveChange({ path: file, target, kind: name === 'rename_file' ? 'rename' : 'delete', before, after: name === 'rename_file' ? before : null }, args.expectedHash, signal, session);
        return JSON.stringify({ path: file, target, changeId: change.id, changed: true });
      });
    }
    if (name === 'run_command') {
      if (permission !== 'workspace-write' || !this.options.allowShell() || !this.options.approveCommand) {
        throw new WorkerError('permission_denied', 'Shell commands are disabled.');
      }
      const args = schemas.run_command.parse(input);
      const cwd = await this.resolve(args.path);
      if (!(await fs.stat(cwd)).isDirectory()) {
        throw new WorkerError('invalid_path', 'Command path must be a directory.');
      }
      const approved = await abortable(this.options.approveCommand(args.command, cwd, signal), signal);
      signal.throwIfAborted();
      if (!approved || !this.options.allowShell()) {
        throw new WorkerError('command_denied', 'User declined the command.');
      }
      return this.command(args.command, cwd, args.timeoutMs, signal);
    }
    throw new WorkerError('unknown_tool', `Unknown worker tool: ${name}`);
  }
  private async saveChange(content: Pick<ChangeContent, 'path' | 'target' | 'kind' | 'before' | 'after'>, expectedHash: string, signal: AbortSignal, session?: Session): Promise<ChangeContent> {
    const change: ChangeContent = { ...content, id: randomUUID(), state: 'pending', createdAt: new Date().toISOString() };
    if (session) {
      await this.options.recordChange?.(session, change);
    }
    signal.throwIfAborted();
    if (this.options.applyChange) {
      await this.options.applyChange(change, expectedHash);
      if (change.kind === 'write') {
        // Includes formatting/save participants and unsaved editor content.
        change.after = await this.text(change.path);
      }
    } else if (change.kind === 'write') {
      if (change.before === null) {
        await fs.writeFile(change.path, change.after!, { flag: 'wx', mode: 0o644 });
      } else {
        const stat = await fs.stat(change.path); await atomicWrite(change.path, change.after!, stat.mode % 0o1000);
      }
    } else if (change.kind === 'delete') {
      await fs.unlink(change.path);
    } else {
      // Exclusive destination creation avoids silently replacing a concurrent file.
      await fs.link(change.path, change.target!); await fs.unlink(change.path);
    }
    change.state = 'applied';
    if (session) {
      await this.options.finishChange?.(session, change);
    }
    return change;
  }
  private command(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const windows = process.platform === 'win32';
      const child = spawn(windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh', windows ? ['/d', '/s', '/c', command] : ['-c', command], { cwd, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let truncated = false;
      let timedOut = false;
      const collect = (chunk: Buffer): void => {
        output += chunk.toString(); if (output.length > 100_000) {
          output = output.slice(-100_000); truncated = true;
        }
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      let force: NodeJS.Timeout | undefined;
      let terminating = false;
      let closed = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let spawnError: Error | undefined;
      const finish = (): void => {
        if (!closed || force) {
          return;
        }
        clearTimeout(timer); signal.removeEventListener('abort', terminate);
        if (spawnError) {
          reject(spawnError);
        } else {
          resolve(JSON.stringify({ exitCode, signal: exitSignal, timedOut, cancelled: signal.aborted, truncated, output, note: timedOut || signal.aborted ? 'Command may have partial side effects. Inspect state before repeating.' : undefined }));
        }
      };
      const terminate = (): void => {
        if (terminating) {
          return;
        }
        terminating = true;
        const kill = (s: NodeJS.Signals): void => {
          try {
            if (!windows && child.pid) {
              process.kill(-child.pid, s);
            } else {
              child.kill(s);
            }
          } catch { /* Process already exited. */ }
        };
        kill('SIGTERM');
        // The shell can close before descendants that ignore SIGTERM. Keep the
        // group kill and this promise alive through the entire grace period.
        force = setTimeout(() => {
          kill('SIGKILL'); force = undefined; finish();
        }, 1000);
      };
      signal.addEventListener('abort', terminate, { once: true });
      const timer = setTimeout(() => {
        timedOut = true; terminate();
      }, timeoutMs);
      child.on('error', error => {
        spawnError = error;
        if (!child.pid) {
          closed = true; finish();
        }
      });
      child.on('close', (code, killedBy) => {
        closed = true; exitCode = code; exitSignal = killedBy; finish();
      });
      if (signal.aborted) {
        terminate();
      }
    });
  }
}
