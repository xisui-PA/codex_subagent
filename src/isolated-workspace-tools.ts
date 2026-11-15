import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { IsolatedViewIdentity, IsolatedViewPort, IsolatedViewState } from './isolated-view-port';
import type { IsolatedViewBinding } from './isolated-view-types';
import { fileToolSchemas } from './workspace-tools';
import { Session, Tool, WorkerError, WorkspaceTools } from './types';

const MAX_TEXT_BYTES = 2_000_000;
const mutations = new Set(['write_file', 'patch_file', 'create_directory', 'delete_file', 'rename_file']);
type FileToolName = keyof typeof fileToolSchemas;
const hashBytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function decode(bytes: Buffer): string {
  if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) {
    throw new WorkerError('file_limit', 'Binary or oversized file; text tools support UTF-8 files up to 2 MB.');
  }
  try {
    // Keep a UTF-8 BOM in the returned text and in subsequent patches.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new WorkerError('file_limit', 'This file is not valid UTF-8.');
  }
}

function lineEndings(text: string): 'crlf' | 'lf' | 'mixed' | 'none' {
  const plain = text.replace(/\r\n/g, '');
  if (plain.includes('\r') || (text.includes('\r\n') && plain.includes('\n'))) {
    return 'mixed';
  }
  return text.includes('\r\n') ? 'crlf' : text.includes('\n') ? 'lf' : 'none';
}

/** Shared by worker reads and coordinator inspection of sealed submissions. */
export async function executeViewRead(name: string, input: Record<string, unknown>, view: IsolatedViewState, guard: () => void): Promise<string> {
  guard();
  if (name === 'read_file') {
    const args = fileToolSchemas.read_file.parse(input);
    const file = await view.read(args.path);
    guard();
    const content = decode(file.bytes);
    const end = args.offset + args.limit;
    return JSON.stringify({ path: file.path, hash: file.hash, content: content.slice(args.offset, end), totalCharacters: content.length,
      nextOffset: end < content.length ? end : null, lineEndings: lineEndings(content), revision: view.revision });
  }
  if (name === 'list_files') {
    const args = fileToolSchemas.list_files.parse(input);
    const entries = view.tree.list(args.path);
    const end = args.offset + args.limit;
    return JSON.stringify({ path: view.tree.resolve(args.path), revision: view.revision,
      entries: entries.slice(args.offset, end).map(({ name: child, entry }) => ({ name: child, ...entry })),
      nextOffset: end < entries.length ? end : null });
  }
  if (name === 'search_files') {
    const args = fileToolSchemas.search_files.parse(input);
    const start = view.tree.resolve(args.path);
    if (start === undefined) {
      throw new WorkerError('not_found', 'Search path is absent from this revision.');
    }
    const queue = [start];
    const results: { path: string; line: number; text: string }[] = [];
    const skipped = { unsupported: 0, excluded: 0, binaryOrOversized: 0 };
    let visited = 0;
    let truncated = false;
    while (queue.length) {
      guard();
      if (visited >= 2000 || results.length >= args.limit) {
        truncated = true;
        break;
      }
      const key = queue.shift()!;
      visited += 1;
      const entry = view.tree.stat(key);
      if (key === '.' || entry?.type === 'directory') {
        queue.push(...view.tree.list(key).map(child => key === '.' ? child.name : `${key}/${child.name}`));
        continue;
      }
      if (!entry) {
        throw new WorkerError('isolation_corrupt', 'Search encountered a missing namespace entry.');
      }
      if (entry.type !== 'file') {
        skipped[entry.type] += 1;
        continue;
      }
      // Verify every visited file's content before deciding it is unsearchable.
      // Missing/corrupt snapshot bytes are errors, never silent search skips.
      const file = await view.read(key);
      guard();
      let content: string;
      try {
        content = decode(file.bytes);
      } catch (error) {
        if (!(error instanceof WorkerError) || error.code !== 'file_limit') {
          throw error;
        }
        skipped.binaryOrOversized += 1;
        continue;
      }
      const lines = content.split('\n');
      for (let at = 0; at < lines.length; at += 1) {
        if (lines[at].includes(args.query)) {
          results.push({ path: key, line: at + 1, text: lines[at].replace(/\r$/, '').slice(0, 500) });
          if (results.length === args.limit) {
            truncated = queue.length > 0 || at + 1 < lines.length;
            break;
          }
        }
      }
    }
    guard();
    return JSON.stringify({ results, skipped, visited, truncated, revision: view.revision });
  }
  throw new WorkerError('unknown_tool', `Unknown isolated read tool: ${name}`);
}

/** No filesystem or process access: every operation uses the same revision port. */
export class IsolatedWorkspaceTools implements WorkspaceTools {
  constructor(
    readonly workspaceRoot: string,
    private readonly port: IsolatedViewPort,
    private readonly binding: IsolatedViewBinding,
    private readonly identity: IsolatedViewIdentity,
    private readonly permission: Session['permission'],
    private readonly options: { canWrite: () => boolean; guard?: () => void }
  ) {}

  definitions(permission: Session['permission']): Tool[] {
    const descriptions: Record<FileToolName, string> = {
      read_file: 'Read UTF-8 content from this private revision; returns its full raw SHA-256 and line endings.',
      list_files: 'List the merged snapshot and private changes, including deletions and renames, with pagination.',
      search_files: 'Search literal text in this merged revision. Reports bounded traversal and unsupported or binary files.',
      write_file: 'Write only to the private overlay. Requires the current raw expectedHash, or new for an absent file.',
      patch_file: 'Patch one unique occurrence in the private overlay after verifying the full raw hash. Uniform LF/CRLF files preserve their style; mixed endings match exactly.',
      create_directory: 'Create a private directory. The parent must exist; protected paths are refused.',
      delete_file: 'Delete a private-view file only when its full raw hash matches expectedHash.',
      rename_file: 'Rename a private-view file without copying its bytes. Requires the current raw hash and an absent destination.',
      run_command: 'Unavailable for isolated views until physical runners exist. This never executes in the main workspace.'
    };
    return (Object.keys(fileToolSchemas) as FileToolName[]).filter(name =>
      !mutations.has(name) || (permission === 'workspace-write' && this.permission === 'workspace-write' && this.options.canWrite())
    ).map(name => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(fileToolSchemas[name]) }));
  }

  async execute(name: string, input: Record<string, unknown>, permission: Session['permission'], signal: AbortSignal, _session?: Session, authorize?: () => void): Promise<string> {
    const guard = (): void => {
      signal.throwIfAborted();
      this.options.guard?.();
      authorize?.();
      if (mutations.has(name) && (permission !== 'workspace-write' || this.permission !== 'workspace-write' || !this.options.canWrite())) {
        throw new WorkerError('permission_denied', 'Private view writes are disabled.');
      }
    };
    guard();
    if (name === 'run_command') {
      fileToolSchemas.run_command.parse(input);
      throw new WorkerError('isolated_shell_unavailable', 'Shell execution is unavailable for isolated workers until physical runners exist.');
    }
    if (!mutations.has(name)) {
      return this.port.withView(this.binding, this.identity, view => executeViewRead(name, input, view, guard), guard);
    }
    let result: Record<string, unknown> = {};
    const commit = await this.port.edit(this.binding, this.identity, async (view, put) => {
      guard();
      if (name === 'create_directory') {
        const args = fileToolSchemas.create_directory.parse(input);
        const delta = view.tree.mkdir(args.path);
        result = { path: Object.keys(delta)[0], created: true };
        return delta;
      }
      if (name === 'delete_file' || name === 'rename_file') {
        const args = name === 'delete_file' ? fileToolSchemas.delete_file.parse(input) : fileToolSchemas.rename_file.parse(input);
        const delta = 'target' in args && typeof args.target === 'string' ? view.tree.rename(args.path, args.target, args.expectedHash) : view.tree.delete(args.path, args.expectedHash);
        // Also verify retained bytes before publishing a deletion or rename.
        await view.read(args.path);
        guard();
        result = { path: view.tree.resolve(args.path), ...('target' in args ? { target: Object.keys(delta).find(key => delta[key] !== null) } : {}), changed: true };
        return delta;
      }
      const args = name === 'write_file' ? fileToolSchemas.write_file.parse(input) : fileToolSchemas.patch_file.parse(input);
      let content: string;
      if ('content' in args) {
        content = args.content;
      } else {
        const file = await view.read(args.path);
        guard();
        if (file.hash !== args.expectedHash) {
          throw new WorkerError('stale_hash', 'File changed; read its current private revision before patching.');
        }
        const before = decode(file.bytes);
        const eol = lineEndings(before);
        const normalize = (text: string): string => {
          const lf = text.replace(/\r\n/g, '\n');
          return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
        };
        const oldText = eol === 'lf' || eol === 'crlf' ? normalize(args.oldText) : args.oldText;
        const newText = eol === 'lf' || eol === 'crlf' ? normalize(args.newText) : args.newText;
        const at = before.indexOf(oldText);
        if (at < 0 || at !== before.lastIndexOf(oldText)) {
          throw new WorkerError('patch_conflict', 'oldText must match exactly once in the current file.');
        }
        content = before.slice(0, at) + newText + before.slice(at + oldText.length);
      }
      const bytes = Buffer.from(content, 'utf8');
      const hash = hashBytes(bytes);
      // Validate all path and hash preconditions BEFORE adding private content.
      const delta = view.tree.write(args.path, hash, bytes.length, args.expectedHash);
      if (args.expectedHash !== 'new') {
        await view.read(args.path);
      }
      guard();
      result = { path: Object.keys(delta)[0], hash, bytes: bytes.length, lineEndings: lineEndings(content) };
      if (hash === args.expectedHash) {
        // An unchanged Git-backed file already has immutable retained bytes.
        // A semantic no-op must not create a redundant CAS payload copy.
        return delta;
      }
      if (await put(bytes) !== hash) {
        throw new WorkerError('snapshot_content_missing', 'Private content storage returned a different hash.');
      }
      guard();
      return delta;
    }, guard);
    return JSON.stringify({ ...result, revision: commit.revision });
  }
}
