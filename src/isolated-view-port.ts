import type { Delta, LayeredTree } from './layered-tree';
import type { IsolatedViewBinding, OverlayRecord, SealedSubmission } from './isolated-view-types';

/** The host binds identity to a worker instance, never to editable tool input. */
export interface IsolatedViewIdentity {
  ownerId: string;
  workerId: string;
  workerCreatedAt: string;
}

/** One coherent revision, held for the complete duration of a tool operation. */
export interface IsolatedViewState {
  readonly tree: LayeredTree;
  readonly revision: number;
  /** Resolves a visible file path and verifies its stored bytes. */
  read(path: string): Promise<{ path: string; bytes: Buffer; hash: string }>;
}

/** File tools depend on this port; capture and retention remain host operations. */
export interface IsolatedViewPort {
  withView<T>(
    binding: IsolatedViewBinding,
    identity: IsolatedViewIdentity,
    action: (view: IsolatedViewState) => T | Promise<T>,
    authorize?: () => void
  ): Promise<T>;
  edit(
    binding: IsolatedViewBinding,
    identity: IsolatedViewIdentity,
    planner: (view: IsolatedViewState, put: (bytes: Buffer) => Promise<string>) => Delta | Promise<Delta>,
    authorize?: () => void
  ): Promise<{ revision: number }>;
  seal(
    binding: IsolatedViewBinding,
    identity: IsolatedViewIdentity,
    input: { requestId: string; expectedRevision: number },
    authorize?: () => void
  ): Promise<SealedSubmission>;
  /** Publish a sealed input and its consumer record under one view lock. */
  withSealedInput?<T>(
    binding: IsolatedViewBinding, identity: IsolatedViewIdentity,
    input: { requestId: string; expectedRevision: number },
    action: (view: IsolatedViewState, submission: SealedSubmission) => T | Promise<T>,
    authorize?: () => void
  ): Promise<T>;
  status(
    binding: IsolatedViewBinding,
    identity: IsolatedViewIdentity,
    authorize?: () => void
  ): Promise<OverlayRecord>;
}
