import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WorkerError } from './types';

/** Caller holds the view business mutex and the workspace store owner lock. */
export async function sweepViewContent(directory: string, marked: ReadonlySet<string>, guard: () => void): Promise<{
  deletedBlobs: number; deletedBytes: number; preservedUnknown: number;
}> {
  const result = { deletedBlobs: 0, deletedBytes: 0, preservedUnknown: 0 };
  const root = path.join(directory, 'blobs');
  guard();
  const rootStat = await fs.lstat(root).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  guard();
  if (!rootStat) {
    return result;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new WorkerError('isolation_corrupt', 'The content store is not an ordinary directory.');
  }
  for (const prefix of await fs.readdir(root)) {
    guard();
    const folder = path.join(root, prefix);
    const folderStat = await fs.lstat(folder);
    if (!/^[a-f0-9]{2}$/.test(prefix) || !folderStat.isDirectory() || folderStat.isSymbolicLink()) {
      result.preservedUnknown += 1;
      continue;
    }
    for (const suffix of await fs.readdir(folder)) {
      guard();
      if (!/^[a-f0-9]{62}$/.test(suffix)) {
        result.preservedUnknown += 1;
        continue;
      }
      const file = path.join(folder, suffix);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        result.preservedUnknown += 1;
        continue;
      }
      if (marked.has(prefix + suffix)) {
        continue;
      }
      const currentFolder = await fs.lstat(folder);
      const currentRoot = await fs.lstat(root);
      guard();
      if (currentFolder.isSymbolicLink() || !currentFolder.isDirectory() || currentFolder.ino !== folderStat.ino || currentFolder.dev !== folderStat.dev
        || currentRoot.isSymbolicLink() || !currentRoot.isDirectory() || currentRoot.ino !== rootStat.ino || currentRoot.dev !== rootStat.dev) {
        throw new WorkerError('isolation_corrupt', 'The content store changed during cleanup.');
      }
      await fs.unlink(file);
      result.deletedBlobs += 1;
      result.deletedBytes += stat.size;
    }
  }
  return result;
}
