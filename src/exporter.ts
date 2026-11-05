import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChangeContent, Session, WorkerError } from './types';
import { contains } from './workspaces';

/** Stream full archive segments through a temporary file, retaining an existing
 * export if any source is missing/corrupt or the destination cannot be committed. */
export async function exportTranscript(session: Session, store: string, target: string): Promise<void> {
  const realStore = await fs.realpath(store);
  const parent = await fs.realpath(path.dirname(target));
  if (contains(realStore, path.join(parent, path.basename(target)))) {
    throw new WorkerError('protected_path', 'Export outside the internal session store to preserve its checkpoints.');
  }
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`{"session":${JSON.stringify(session)},"archives":[`);
      for (const [index, archive] of (session.archives || []).entries()) {
        if (index) {
          await file.writeFile(',');
        }
        const data = await fs.readFile(path.join(realStore, 'archives', session.id, `${archive.id}.json`));
        // Reject a corrupt segment rather than publishing an invalid JSON export.
        JSON.parse(data.toString());
        await file.writeFile(data);
      }
      await file.writeFile('],"changeSnapshots":[');
      for (const [index, change] of (session.changes || []).entries()) {
        if (index) {
          await file.writeFile(',');
        }
        const snapshot = JSON.parse(await fs.readFile(path.join(realStore, 'changes', session.id, `${change.id}.json`), 'utf8')) as ChangeContent;
        await file.writeFile(JSON.stringify({ ...snapshot, ...change }));
      }
      await file.writeFile(']}'); await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
