// Guarded workspace publication for one approved integration candidate.
//
// publishIntegration() applies an approved candidate's changes with RAW bytes:
// BOMs, encodings and line endings are never decoded, transcoded or
// re-normalized. Every path is canonicalized and validated, every ancestor is
// lstat'ed (plain directories only; symlinks and junctions are never
// traversed) and its dev/ino identity is pinned. The destination must still
// match the approved base entry: content hash, size and (on POSIX) mode.
// Symlinked and hard-linked destinations are rejected, never overwritten, and
// no directories are created: creations and replacements require an existing
// plain parent.
//
// The publication is guarded by a durable journal that MUST live outside the
// workspace. The caller serializes operations per root, owns the journal
// directory and passes the existing workspace model/auth/feature checks as
// `authorize`; the guard is re-checked before every journal write (including
// immediately before the journal rename, through atomicWrite's beforeRename
// hook) and before every filesystem effect. The journal records one state per
// file:
//
//   pending     - preflighted, no effect has started; a retry may apply it
//   intent      - durable immediately BEFORE that file's effect
//   applied     - the effect completed (or was later proven complete)
//   interrupted - the effect may have started; it is NEVER repeated
//
// The journal also pins the identity of the plan: the canonical root and every
// parent directory of every entry, as dev/ino pairs. A retry trusts only those
// identities; a parent that disappeared, stopped being a plain directory
// (a symlink or Windows junction) or became a DIFFERENT plain directory - even
// one holding byte-identical content - is untrusted and is never applied.
// Filesystem stats are read with `bigint: true` so device and inode numbers keep
// their exact 64-bit value (Windows reports file indices above
// Number.MAX_SAFE_INTEGER, where two real identities could round to one double)
// and the journal stores them as exact decimal strings; sizes, modes and times
// are converted to numbers only at their already validated use.
//
// A recoverable `intent` is resolved by proof only, and the proof runs under
// exactly the same ancestor checks as normal preflight: a destination that
// exactly matches the approved `after` entry is recorded as applied and never
// rewritten; anything else, including an untrusted ancestor, is recorded as
// interrupted. Before that proof, ONE provably owned staging entry of that
// intent is removed (see the staging section below), because a creation
// interrupted between link() and unlink() leaves a second link to the published
// inode that the destination proof would otherwise refuse as hard-linked.
// Applied paths are skipped on every replay, so a later user edit
// on an applied path is never overwritten. An exact replay of a finished
// publication therefore performs no filesystem change and returns the same
// result. An `authorize` rejection propagates to the caller: files already
// completed remain durably recorded as applied, and a revocation at the
// completion write leaves that file's durable `intent` in place instead of
// publishing an unguarded completion record.
//
// The caller may add a recovery contract. `requireJournal` states that a journal
// was already durably established for this attempt - a latch the caller persists
// before it allows any effect - so a MISSING journal is terminal: an effect may
// already have started and its proof is gone. That case returns `interrupted`
// without touching the workspace and without writing a replacement journal.
// `onJournalReady` is awaited once a valid journal is durable - written by this
// call, or loaded from disk - and BEFORE any workspace effect, which is exactly
// where that latch is persisted; a rejection aborts before any effect.
// `recoveryOnly` resolves durable state only: `intent` entries are resolved by
// the same proof used everywhere else, an all-applied journal is reported as
// applied, outstanding `pending` work is a retryable structured conflict, and a
// journal is never created and no new or pending effect is ever started. These
// options are additive: a caller that omits them keeps byte-identical behavior.
//
// The caller may also persist its OWN durable trace of the journal. Every check
// this module can run on a loaded journal is self-consistency: identity, root,
// plan and change signatures are all unchanged by a rollback, and neither the
// revision number nor the per-entry state is part of the plan digest. So an
// intact, validated journal can still be an EARLIER revision of the very same
// journal restored over the current one, and that revision is too old to say
// which changes reached the workspace: a `pending` entry may already have been
// applied, because a durable `intent` precedes its effect and a refused live
// check can leave that effect unstarted.
// Combined with the recurring user edit (undoing or re-checking out a published
// file restores exactly the captured `before` entry) the retry's preflight would
// pass and its effect would overwrite that restored edit. The caller therefore
// persists each durable `intent` revision in its attempt ledger: `onJournalIntent`
// is awaited once per workspace effect, immediately AFTER that entry's durable
// `intent` record and BEFORE any staged or real effect, and the same revision is
// handed back as `minimumJournalRevision`. A loaded journal whose revision is
// below that floor is terminal `interrupted`: no journal revision is written, no
// workspace file is touched, and proof-only recovery does not soften it, so a
// rollback-lost effect is never repeated. A positive floor also proves a journal
// WAS established, so a missing journal is terminal for it in every mode.
//
// Live preconditions are bounded and re-verified: a destination is never read
// before its size and identity are checked against the approved entry, the
// read allocates exactly that bounded size (O_NOFOLLOW where the platform
// provides it), and the opened handle's identity, type, size and mtime plus the
// current path entry are re-checked afterwards, so a swap during the read is
// refused instead of verified against the wrong bytes. The final path entry is
// additionally compared with the handle's post-read stat for size, precise
// mtime/ctime, link count and permission bits, so an in-place write or a hard
// link that lands during that last observation is refused too; this is the best
// available observation, not a compare-and-swap - there is no OS-level CAS and
// a change after the final lstat is out of scope. Each boundary runs the
// editor guard (whose alias resolution awaits) first, then the ancestor checks
// under a fresh guard, then the final target observation, so identity, size,
// content and mode are read as late as possible; the scoped absolute open-path
// inventory is re-read after that observation, awaits nothing further, and a
// change there is a retryable per-file editor conflict.
//
// On POSIX, a replacement preserves the destination's existing permissions
// exactly whenever the approved entry asks for the same executable class: 0o744
// stays 0o744 and an ordinary edit never widens 0o600 to 0o644. An intentional
// supported mode change (0o644 <-> 0o755) applies only the approved executable
// bit where the corresponding read bit is present and keeps the existing
// read/write bits. Files carrying setuid/setgid/sticky bits are refused
// explicitly instead of being silently rewritten with reduced fidelity. The
// staged payload carries the bits the first live check observed (inspectFile
// reads them from the final path entry, not from a stale handle), and a
// replacement is refused when the final check observes a different full POSIX
// mode - an owner edit during staging is preserved, never reverted.
// Windows has no portable mode effect, so a planned mode change on a
// live file is refused there.
//
// Capacity is refused, never thrown: more changes than MAX_CHANGES, declared
// approved bytes above MAX_TOTAL_BYTES, or a journal that cannot hold
// MAX_JOURNAL_BYTES even at its own worst-case encoding is reported as a
// structured conflict BEFORE any approved byte is read, any journal revision is
// committed and any destination effect starts; a resumed journal reports the
// paths it already applied. The journal bound uses the shared serializer and the
// same bound is re-applied defensively on every journal write, so a journal this
// module commits is always one its own recovery can read back.
//
// Staging is a SHORT, FIXED-LENGTH random sibling name
// (`.codex-stage-<16 hex>.tmp`) created in the destination's own directory. The
// name never depends on the destination's length - a valid 234-character leaf
// plus a destination-suffixed temporary name exceeds the 255-character component
// bound and fails with ENOENT - and stays in the same directory, so the final
// rename/link is atomic and never crosses a filesystem boundary. The generated
// basename is pinned into that entry's durable `intent` record, the entry is then
// created EXCLUSIVELY, and its actual file identity is recorded durably BEFORE
// the first candidate byte is written. The persisted row always carries that
// record: `stage` is null when the phase has none, and a record's `identity` is
// null until the exclusive create records the exact entry. Debris the record
// cannot describe - no record, or no recorded identity - is never touched.
//
// The staged payload is proved before anything can publish it: it must still be
// the recorded inode, a plain single-link regular file, and its bytes must be the
// approved ones while its identity, size and precise times are stable across the
// bounded read and matched again by the final path entry. That verification is
// the long observation, so it runs BEFORE the final live destination check, and a
// last observation of the staged entry runs immediately before the link/rename;
// an in-place same-size edit of the staged payload, a swap or a truncation is
// therefore refused and never published.
//
// Proof-only recovery cleans exactly ONE staging entry per durable row, and only
// when the pinned ancestors still verify, the path entry is a plain regular file
// that is still the recorded dev/ino identity, no open editor names it, and its
// bytes - read through the same bounded, no-follow handle as a destination and
// bound to that identity by the post-read stat and the final path entry - are
// exactly the approved payload, with one link or with two only during a
// creation interrupted between link() and unlink(). A second link is removable
// solely when the exact final destination is that SAME inode. Cleanup runs for a
// durable `intent` BEFORE its completion proof and also for an already terminal
// (`interrupted`) row, so it is part of proof-only recovery and starts zero new
// pending effects. The same rule removes a failed effect's own staging entry
// in-process, and a removal it cannot prove is never attempted another way. A
// partial payload, a byte-identical clone at the same name, later-edited bytes,
// an untrusted parent, an open editor on the staging name, a record without a
// durable identity, or a rollback that restored a revision without that identity
// is never removed: only this module's own staging name is ever unlinked, and it
// is never discovered by globbing or directory scanning. A failed exclusive
// create removes neither a pre-existing destination nor a pre-existing entry at
// the staging name, and a known owned stage is never silently dropped from the
// durable record when its cleanup could not be proved.
//
// A row that has to stage again is reconciled against its OWN recorded stage
// first: a retryable `pending` row whose effect left debris, and a resolved
// `applied` row whose completion was proved before its staging cleanup, both keep
// the exact entry in the single per-row stage slot until that path is resolved.
// The exact recorded entry is proved and removed by the rule above, and the
// record may be cleared only once that path is proved ABSENT - removed, or no
// longer existing, and an ENOENT is accepted only after the pinned ancestors are
// re-verified and only for that exact code, so an unreadable or unobservable path
// stays unproved. A fresh staging name NEVER replaces an old record: while
// the recorded staging path still exists and cannot be proved removable, the row
// keeps that exact record and reports a retryable conflict naming the staging
// path, so an owner can move an edited file or close the editor that holds it; the
// row retries normally once the path is absent. Reconciliation is proof-only: it
// starts no pending effect and never replays the destination, so an already
// applied row is never rewritten by it, and it runs for a `recoveryOnly` call too.
// An `intent` whose destination proves applied but whose own stage was not cleared
// is recorded as `applied` WITH that record and is reported in the SAME call as
// that retryable stage conflict (carrying the applied path), so the caller's
// attempt ledger accepts the call and a later apply re-enters the journal to
// reconcile the entry instead of seeing a terminal `applied` result.
//
// Limitations, deliberately not claimed: publication is NOT multi-file atomic
// (each file has its own durable intent/completion record, so a crash can
// leave earlier files applied and later ones pending), there is no OS-level
// compare-and-swap against concurrent editors (open editors on a touched path
// are a conservative per-file conflict re-evaluated before each effect, matched
// by canonical location - the realpath of the parent plus the exact dev/ino
// identity of the leaf, so a Windows junction or symlink alias cannot hide an
// open document, and an absent untitled leaf is matched by its canonical
// parent+leaf location; document text is never read), and an interrupted run is
// cleaned ONLY through its own durable `stage` record, for one exact name and
// one exact identity: a staging entry whose payload was only partially written,
// a row whose stage is null or whose recorded identity is still null is left in
// place as unproved debris instead of being guessed at - and
// that debris keeps its row from staging again (a retryable conflict naming the
// staging path) until the owner has moved it or the path is provably absent.
// Journal-level refusals (foreign, corrupt or unsafe journal) report the
// journal path in `path`; per-file refusals report the canonical change path;
// root-wide capacity refusals report `.` (never an empty path).
// The journal stores hashes, sizes and directory identities only, never file
// bytes. Directory identities are compared, not assumed: a filesystem that
// reports unstable dev/ino pairs fails closed rather than publishing.

import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_FILE_MODE, EXECUTABLE_FILE_MODE, fileModeFromPermissions, isFileMode, type FileMode, type OpenDocument
} from './snapshot-content';
import { atomicWrite, digest } from './storage';
import { WorkerError } from './types';

/**
 * One side of a change: an approved regular file with its planned POSIX mode
 * class, or its absence.
 */
export type PublicationEntry = { type: 'file'; hash: string; size: number; mode: FileMode } | null;

/** One approved path transition; `path` is canonical, root-relative and POSIX. */
export interface PublicationChange {
  path: string;
  before: PublicationEntry;
  after: PublicationEntry;
}

/**
 * Optional recovery contract of one publication call. Every field is additive
 * and opt-in, so existing callers keep their exact previous behavior.
 */
export interface IntegrationPublicationOptions {
  /**
   * A journal was already established for this publication, so a MISSING journal
   * is terminal instead of a fresh plan: an earlier effect may have started and
   * its proof is gone. The caller sets this from a durable latch it persisted
   * before any workspace effect was allowed to begin, and it treats an unknown
   * legacy state as required.
   */
  requireJournal?: boolean;
  /**
   * Awaited once a valid journal is durable - written by this call or loaded
   * from disk - and BEFORE any workspace effect. The caller persists its own
   * durable `journal established` latch here, so a later missing journal is
   * provable. A rejection aborts this call before any effect.
   */
  onJournalReady?: () => Promise<void>;
  /**
   * Lowest journal revision this attempt may trust: the revision of the entry
   * `intent` record the caller itself persisted durably before that entry's
   * effect. An intact, self-consistent journal can still be an EARLIER revision
   * restored over the current one, which is too old to determine which changes
   * may already have reached the workspace (a durable intent precedes an effect,
   * and a refused live check can leave that effect unstarted); a validated
   * journal below this floor is therefore
   * terminal `interrupted`, and it is neither rewritten nor allowed to touch the
   * workspace - not even by `recoveryOnly`. A positive floor is also durable
   * evidence that a journal was established, so a MISSING journal is terminal
   * for it in every mode, exactly like `requireJournal`.
   */
  minimumJournalRevision?: number;
  /**
   * Awaited once per workspace effect, immediately AFTER that entry's durable
   * `intent` record and BEFORE any staged or real effect, with the revision that
   * record was committed at. The caller persists that revision as its own floor
   * (`minimumJournalRevision`) and passes it back on the next attempt. A
   * rejection propagates with the durable `intent` left in place: no staged or
   * real effect has started, and the next attempt resolves that intent by proof
   * only, so never by repeating it.
   */
  onJournalIntent?: (revision: number) => Promise<void>;
  /**
   * Resolve durable state only. A durable `intent` is still resolved by the
   * proof-only code, but no fresh journal is created and no new or pending
   * workspace effect is ever started. Used while publication storage is
   * unavailable; the caller retries later with a new request.
   */
  recoveryOnly?: boolean;
}

export interface IntegrationPublicationInput extends IntegrationPublicationOptions {
  /** Canonical workspace root. Every change path is relative to it. */
  root: string;
  /** Durable publication journal; must be a file outside `root`. */
  journalPath: string;
  /** Immutable identity of the approved candidate this journal belongs to. */
  identity: string;
  changes: readonly PublicationChange[];
  /** Approved candidate bytes for one canonical root-relative path. */
  read(path: string): Promise<Buffer>;
  /** All currently open editor documents; non-absolute paths are ignored. */
  openDocuments(): readonly OpenDocument[];
  /** Existing workspace model/auth/feature checks; throws when revoked. */
  authorize(): void;
}

export interface IntegrationPublicationResult {
  state: 'applied' | 'conflict' | 'interrupted';
  applied: string[];
  conflicts: { path: string; reason: string }[];
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;
/** Canonical non-negative decimal integer, exactly as an identity is written. */
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const JOURNAL_SCHEMA = 2;
const JOURNAL_KEYS: ReadonlySet<string> = new Set(['schema', 'identity', 'root', 'plan', 'revision', 'trust', 'entries']);
const JOURNAL_ENTRY_KEYS: ReadonlySet<string> = new Set(['path', 'state', 'before', 'after', 'stage']);
const JOURNAL_STAGE_KEYS: ReadonlySet<string> = new Set(['name', 'identity']);
const JOURNAL_TRUST_KEYS: ReadonlySet<string> = new Set(['root', 'parents']);
const IDENTITY_KEYS: ReadonlySet<string> = new Set(['dev', 'ino']);
const JOURNAL_STATES: readonly JournalState[] = ['pending', 'intent', 'applied', 'interrupted'];
const PROTECTED_COMPONENTS: ReadonlySet<string> = new Set(['.git', '.codex', '.vscode']);
/** Characters that are never portable in a path segment (quotes, globs, redirects). */
const NON_PORTABLE_CODES: ReadonlySet<number> = new Set([34, 42, 60, 62, 63, 124]);

const MAX_CHANGES = 1_024;
const MAX_PATH_LENGTH = 4_096;
const MAX_IDENTITY_LENGTH = 200;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
/** Temporary payload mode; the final POSIX mode is applied before publication. */
const TEMPORARY_FILE_MODE = 0o600;
/**
 * Staging sibling of one destination: short, FIXED length and independent of the
 * destination's length, so a valid maximal leaf never overflows the filesystem's
 * per-component bound the way a destination-suffixed temporary name does. It is
 * created in the destination's own directory, so the final link/rename stays
 * atomic and never crosses a filesystem boundary.
 */
const STAGE_PREFIX = '.codex-stage-';
const STAGE_SUFFIX = '.tmp';
/** 8 random bytes rendered as 16 lowercase hex digits; the name length is fixed. */
const STAGE_RANDOM_BYTES = 8;
/** Exactly the names stagingName() can produce; never a prefix, glob or pattern. */
const STAGE_NAME_PATTERN = /^\.codex-stage-[0-9a-f]{16}\.tmp$/;
/** Widest staging name, so a capacity reservation never depends on randomness. */
const WORST_STAGING_NAME = `${STAGE_PREFIX}${'f'.repeat(STAGE_RANDOM_BYTES * 2)}${STAGE_SUFFIX}`;
/** Read-only, and no-follow where the platform exposes O_NOFOLLOW. */
const READ_ONLY_FLAGS: string | number = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 'r';

const INTERRUPTED_REASON = 'interrupted: a previous attempt may already have started this change; it is never repeated. Inspect the file, then publish a new approved candidate.';
const CHANGED_REASON = 'unsafe path: the destination changed while it was inspected.';
const STAGED_MODE_REASON = 'stale mode: the destination permissions changed while the publication was staged.';
const EDITOR_INVENTORY_REASON = 'open editor: the set of open documents changed while this file was checked; retry the publication so the current editor state is observed.';
/** The exclusive staging create failed: nothing was staged and nothing is removed. */
const STAGE_TAKEN_REASON = 'staging conflict: the publication could not exclusively create its own staging entry beside the destination, so nothing was staged and nothing was removed; retry the publication.';
/** The staging name no longer names the exact inode this effect created. */
const STAGE_CHANGED_REASON = 'staging conflict: the staged payload is no longer the entry this publication created, so it is never published or removed; retry the publication.';
/**
 * A row that may still have to stage a payload keeps a staging entry its own
 * durable record describes, and that entry cannot be proved removable - it exists
 * and its identity, bytes, path or editor state refuse the removal. It is never
 * replaced by a fresh staging name and never removed by a guess, so the conflict
 * names that exact staging path: moving it or closing the editor that holds it
 * makes the row retryable again.
 */
const stageDebrisReason = (staging: string): string =>
  `stage debris: the staging entry ${staging} is recorded for this change and cannot be proved removable, so it is neither replaced by a new staging name nor removed. Move that file or close the editor that holds it, then retry the publication.`;
/**
 * Terminal refusal of an ESTABLISHED publication whose journal is gone. No
 * effect may be repeated and no replacement journal may be written: the durable
 * proof of which files were already applied is missing, so the only safe
 * decisions are an explicit release and a new approved candidate.
 */
const MISSING_JOURNAL_REASON = 'journal missing: this publication durably established its journal and the journal is now gone, so an earlier attempt may already have started a change; it is never repeated. Release this attempt, then publish a new approved candidate.';
/**
 * Terminal refusal of a journal that is intact and self-consistent but BELOW the
 * revision the caller durably recorded. That revision is too old to say which
 * changes ran: a durable `intent` is written BEFORE an effect and a refused live
 * check can keep the effect from ever starting, so an entry the loaded revision
 * still records as `pending` MAY already have reached the workspace. The
 * uncertainty, not a claim of what happened, is why no effect is repeated and no
 * journal revision is written; the loaded state is also never reported as
 * applied, because it is not a complete record of what ran.
 */
const journalRollbackReason = (revision: number, floor: number): string =>
  `journal rollback: the loaded publication journal is revision ${revision}, below the durable minimum revision ${floor}. The journal is too old to tell which files may have been written. Release this attempt before applying a newly approved candidate.`;
/** Recovery found no journal at all: nothing durable to resolve, nothing started. */
const NO_RECOVERY_JOURNAL_REASON = 'recovery unavailable: no publication journal exists. Proof-only recovery cannot create one. Retry with a new request when publication preconditions are satisfied.';
/** Recovery resolved durable state and left outstanding pending work untouched. */
const RECOVERY_ONLY_PENDING_REASON = 'recovery pending: only existing journal state was reconciled. To apply pending files, retry with a new request when publication preconditions are satisfied.';

type JournalState = 'pending' | 'intent' | 'applied' | 'interrupted';

/**
 * Durable staging record of one entry: the exact basename this module pinned for
 * its payload and, once the entry was created exclusively, the exact file
 * identity to prove it with. `identity` is absent while the entry has only been
 * pinned - before the create - and a staging entry can then never be proven. The
 * persisted row still carries both fields of this one current shape: `stage` is
 * null when the phase has no staging record at all, and a record's `identity` is
 * null until the exclusive create has recorded the exact entry.
 */
interface JournalStage {
  name: string;
  identity?: FileIdentity;
}

interface JournalEntry {
  path: string;
  state: JournalState;
  before: PublicationEntry;
  after: PublicationEntry;
  stage?: JournalStage;
}

interface JournalTrust {
  root: FileIdentity;
  /** Canonical root-relative parent directory path -> pinned identity. */
  parents: ReadonlyMap<string, FileIdentity>;
}

interface Journal {
  schema: typeof JOURNAL_SCHEMA;
  identity: string;
  root: string;
  plan: string;
  revision: number;
  trust: JournalTrust;
  entries: JournalEntry[];
}

interface FileIdentity { dev: bigint; ino: bigint }

interface Ancestor { path: string; identity: FileIdentity }

interface ValidatedChange {
  /** Canonical root-relative POSIX path; also the journal key. */
  key: string;
  segments: string[];
  before: PublicationEntry;
  after: PublicationEntry;
}

interface Context {
  readonly input: IntegrationPublicationInput;
  readonly root: string;
  readonly rootIdentity: FileIdentity;
  readonly journalFile: string;
  readonly journalDirectory: string;
  readonly journalDirectoryIdentity: FileIdentity;
  readonly identity: string;
  readonly changes: readonly ValidatedChange[];
}

/** Validation outcome: one usable context, or the conflict result to return. */
type Validation = { context: Context } | { result: IntegrationPublicationResult };

interface Prepared {
  change: ValidatedChange;
  target: string;
  ancestors: readonly Ancestor[];
  bytes?: Buffer;
  /** Pinned staging basename; generated immediately before the durable intent. */
  staging?: string;
}

type Conflict = { path: string; reason: string };
type EffectOutcome = { ok: true } | { ok: false; reason: string; stageDebris?: JournalStage };
type Inspection = { ok: true; stat: BigIntStats } | { ok: false; reason: string };
/**
 * Optional rules for entries that are not publication destinations. A staging
 * entry is not a destination: its payload mode is applied before publication
 * rather than compared against the approved class (`mode: false`), and a
 * creation interrupted between link() and unlink() legitimately has one extra
 * link (`secondLink: true`). Both default to the untouched destination
 * semantics, so every existing caller keeps its exact behavior.
 */
interface InspectionRules {
  mode?: boolean;
  secondLink?: boolean;
}
type DestinationCheck = { ok: true; base?: BigIntStats } | { ok: false; reason: string };
type Proof = { done: true } | { done: false; detail: string };

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

/**
 * sha256 of zero bytes: the only content a demonstrably untouched staging marker
 * can carry, i.e. the entry this module created exclusively and has not written
 * a single payload byte into yet.
 */

/** One fresh staging basename; fixed length, never derived from the destination. */
const stagingName = (): string => `${STAGE_PREFIX}${randomBytes(STAGE_RANDOM_BYTES).toString('hex')}${STAGE_SUFFIX}`;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function invalid(detail: string): never {
  throw new WorkerError('invalid_publication', detail);
}

/** Exact bigint identity of one filesystem entry; never rounded to a double. */
const identityOf = (stat: BigIntStats): FileIdentity => ({ dev: stat.dev, ino: stat.ino });

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean => left.dev === right.dev && left.ino === right.ino;

/** Exact decimal text of one identity component (journal envelope, plan digest). */
const identityText = (value: bigint): string => value.toString();

const identityDocument = (identity: FileIdentity): { dev: string; ino: string } => ({
  dev: identityText(identity.dev), ino: identityText(identity.ino)
});

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

/** Exact bigint lstat: device/inode values must never be rounded to doubles. */
function lstatOrNull(target: string): Promise<BigIntStats | undefined> {
  return fs.lstat(target, { bigint: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
}

/**
 * The planned mode class of one side of a change. A file entry always carries its
 * own mode; only an ABSENT side - the base of a creation - has no approved class
 * of its own, and the publication default applies to it.
 */
const entryMode = (entry: PublicationEntry): FileMode => (entry === null ? DEFAULT_FILE_MODE : entry.mode);

function sameEntry(left: PublicationEntry, right: PublicationEntry): boolean {
  return left !== null && right !== null && left.hash === right.hash && left.size === right.size
    && entryMode(left) === entryMode(right);
}

/** Every parent directory of one change, root-relative and canonical. */
function dirsOf(segments: readonly string[]): string[] {
  const dirs: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    dirs.push(segments.slice(0, index).join('/'));
  }
  return dirs;
}

function requiredParents(entries: readonly { path: string }[]): Set<string> {
  const required = new Set<string>();
  for (const entry of entries) {
    for (const dir of dirsOf(entry.path.split('/'))) {
      required.add(dir);
    }
  }
  return required;
}

/** Canonical POSIX ordering, so the same plan always hashes identically. */
function byPath(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/**
 * Plan identity: the ordered entries together with the pinned root and parent
 * directory identities. The journal may only replay a byte-identical plan, and
 * a retry can only apply it while every pinned directory still exists as the
 * same plain directory.
 */
function planOf(entries: readonly { path: string; before: PublicationEntry; after: PublicationEntry }[], trust: JournalTrust): string {
  const parents: (string | string[])[][] = [];
  for (const key of [...trust.parents.keys()].sort()) {
    const identity = trust.parents.get(key);
    if (identity) {
      parents.push([key, [identityText(identity.dev), identityText(identity.ino)]]);
    }
  }
  return digest({
    entries: [...entries].sort(byPath).map(entry => [entry.path, entry.before, entry.after]),
    trust: { root: [identityText(trust.root.dev), identityText(trust.root.ino)], parents }
  });
}

/**
 * Canonical, portable validation of one root-relative change path. Mirrors the
 * repository's selection-path rules: no escapes, dot segments, backslashes,
 * drive letters, alternate data streams, reserved device names or trailing
 * dots/spaces. Protected configuration directories are refused.
 */
function validatePath(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    invalid('A change path must be a non-empty string of at most 4096 characters.');
  }
  if (value.includes('\\')) {
    invalid(`A change path must use "/" separators only: ${JSON.stringify(value)}.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127 || NON_PORTABLE_CODES.has(code)) {
      invalid(`A change path contains a non-portable character: ${JSON.stringify(value)}.`);
    }
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      invalid(`A change path has an empty or escaping segment: ${JSON.stringify(value)}.`);
    }
    if (segment.charCodeAt(1) === 58 || segment.includes(':')) {
      invalid(`A change path contains a drive letter or alternate data stream: ${JSON.stringify(value)}.`);
    }
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
      invalid(`A change path uses a reserved device name: ${JSON.stringify(value)}.`);
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      invalid(`A change path segment ends with a dot or space: ${JSON.stringify(value)}.`);
    }
    if (PROTECTED_COMPONENTS.has(segment.toLowerCase())) {
      invalid(`A change path targets a protected configuration directory: ${JSON.stringify(value)}.`);
    }
  }
  return segments;
}

/**
 * Strict validation of one journal/base/result entry. A file entry always carries
 * its planned mode class, so a record that omits it is refused instead of being
 * read with an implied default.
 */
function normalizeEntry(value: unknown, label: string): PublicationEntry {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'object' || value === undefined) {
    invalid(`The ${label} entry must be a file entry or null.`);
  }
  const entry = value as { type?: unknown; hash?: unknown; size?: unknown; mode?: unknown };
  if (entry.type !== 'file') {
    invalid(`The ${label} entry must have type "file".`);
  }
  if (typeof entry.hash !== 'string' || !HASH_PATTERN.test(entry.hash)) {
    invalid(`The ${label} entry hash must be a 64-character SHA-256 hex digest.`);
  }
  if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0) {
    invalid(`The ${label} entry size must be a non-negative safe integer.`);
  }
  if (entry.size > MAX_FILE_BYTES) {
    throw new WorkerError('publication_capacity', `The ${label} entry exceeds the ${MAX_FILE_BYTES}-byte per-file bound.`);
  }
  if (!isFileMode(entry.mode)) {
    invalid(`The ${label} entry mode must be 0o644 or 0o755.`);
  }
  return { type: 'file', hash: entry.hash, size: entry.size, mode: entry.mode };
}

/** Strict validation of one persisted dev/ino pair of exact decimal strings. */
function normalizeIdentity(value: unknown, label: string): FileIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`The ${label} identity must be an object.`);
  }
  const identity = value as Record<string, unknown>;
  for (const key of Object.keys(identity)) {
    if (!IDENTITY_KEYS.has(key)) {
      invalid(`The ${label} identity has an unknown field ${JSON.stringify(key)}.`);
    }
  }
  // Device and inode numbers are exact 64-bit values on Windows too, so the
  // journal carries them as canonical decimal strings and only a literal that
  // parses back to that same exact value is accepted.
  const { dev, ino } = identity;
  if (typeof dev !== 'string' || typeof ino !== 'string') {
    invalid(`The ${label} identity must carry dev and ino as decimal strings.`);
  }
  if (!DECIMAL_PATTERN.test(dev) || !DECIMAL_PATTERN.test(ino)) {
    invalid(`The ${label} identity components must be canonical non-negative decimal integers.`);
  }
  return { dev: BigInt(dev), ino: BigInt(ino) };
}

/**
 * Strict validation of one persisted staging record. The one CURRENT journal
 * shape encodes a row without a staging record as `stage: null`, so a present
 * record must name a bare staging sibling of this entry's own directory and must
 * carry its own `identity` field: null while the intent is only pinned - before
 * the exclusive create proves the exact entry - or an exact dev/ino pair. A
 * record that omits either field is refused, never reinterpreted, and an
 * identity is never derived from anything else.
 */
function normalizeStage(value: unknown, leaf: string, hasResult: boolean): JournalStage | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'the publication journal stage record is not an object.';
  }
  const stage = value as Record<string, unknown>;
  for (const key of Object.keys(stage)) {
    if (!JOURNAL_STAGE_KEYS.has(key)) {
      return `a publication journal stage record has an unknown field ${JSON.stringify(key)}.`;
    }
  }
  if (typeof stage.name !== 'string' || !STAGE_NAME_PATTERN.test(stage.name)) {
    return 'a publication journal stage name is not a staging sibling name.';
  }
  if (stage.name === leaf) {
    return 'a publication journal stage name is the destination itself.';
  }
  if (!hasResult) {
    return 'a publication journal stage record describes a change with no result to stage.';
  }
  if (stage.identity === null) {
    return { name: stage.name };
  }
  if (stage.identity === undefined) {
    return 'a publication journal stage record omits its identity.';
  }
  try {
    return { name: stage.name, identity: normalizeIdentity(stage.identity, 'journal stage') };
  } catch (error) {
    return message(error);
  }
}

function compareKey(key: string): string {
  return process.platform === 'win32' ? key.toLowerCase() : key;
}
/** Pinned identities of every ancestor of the freshly preflighted entries. */
function collectTrust(context: Context, prepared: readonly Prepared[]): JournalTrust {
  const parents = new Map<string, FileIdentity>();
  for (const item of prepared) {
    const dirs = dirsOf(item.change.segments);
    for (let index = 0; index < dirs.length; index += 1) {
      const ancestor = item.ancestors[index + 1];
      if (ancestor) {
        parents.set(dirs[index], ancestor.identity);
      }
    }
  }
  return { root: context.rootIdentity, parents };
}

/**
 * Rebuilds the ancestor chain from the pinned journal identities. The chain is
 * only trusted while every element still lstat's as that same plain directory;
 * verifyAncestors() performs those checks and is shared with normal preflight.
 */
function chainFromTrust(context: Context, trust: JournalTrust, segments: readonly string[]): readonly Ancestor[] | string {
  const chain: Ancestor[] = [{ path: context.root, identity: trust.root }];
  let cursor = context.root;
  for (const dir of dirsOf(segments)) {
    const identity = trust.parents.get(dir);
    if (!identity) {
      return `untrusted directory: the publication journal pins no identity for ${JSON.stringify(dir)}.`;
    }
    cursor = path.join(cursor, ...dir.split('/'));
    chain.push({ path: cursor, identity });
  }
  return chain;
}

async function validateRequest(input: IntegrationPublicationInput): Promise<Validation> {
  if (typeof input !== 'object' || input === null) {
    invalid('A publication request is required.');
  }
  if (typeof input.read !== 'function' || typeof input.openDocuments !== 'function' || typeof input.authorize !== 'function') {
    invalid('Publication requires read, openDocuments and authorize callbacks.');
  }
  // The recovery contract's own shape is validated here, before any journal or
  // destination is read, so a malformed floor or checkpoint can never be
  // discovered after an effect.
  if (input.minimumJournalRevision !== undefined
    && (typeof input.minimumJournalRevision !== 'number' || !Number.isSafeInteger(input.minimumJournalRevision)
      || input.minimumJournalRevision < 0)) {
    invalid('The minimum journal revision must be a non-negative safe integer when it is supplied.');
  }
  if (input.onJournalIntent !== undefined && typeof input.onJournalIntent !== 'function') {
    invalid('onJournalIntent must be a function when it is supplied.');
  }
  input.authorize();
  if (typeof input.root !== 'string' || !path.isAbsolute(input.root)) {
    invalid('The workspace root must be an absolute path.');
  }
  if (typeof input.identity !== 'string' || input.identity.length === 0 || input.identity.length > MAX_IDENTITY_LENGTH
    || hasControlCharacters(input.identity)) {
    invalid(`The publication identity must be 1-${MAX_IDENTITY_LENGTH} printable characters.`);
  }
  const rootLink = await lstatOrNull(input.root);
  if (!rootLink || !rootLink.isDirectory() || rootLink.isSymbolicLink()) {
    invalid('The workspace root must be an existing plain directory.');
  }
  const root = await fs.realpath(input.root);
  const rootStat = await fs.lstat(root, { bigint: true });
  if (!rootStat.isDirectory()) {
    invalid('The workspace root must be a directory.');
  }
  if (typeof input.journalPath !== 'string' || !path.isAbsolute(input.journalPath)) {
    invalid('The publication journal path must be absolute.');
  }
  const journalFile = path.resolve(input.journalPath);
  if (contains(root, journalFile)) {
    invalid('The publication journal must live outside the workspace root.');
  }
  const journalDirectory = path.dirname(journalFile);
  const journalDirectoryLink = await lstatOrNull(journalDirectory);
  if (!journalDirectoryLink || !journalDirectoryLink.isDirectory() || journalDirectoryLink.isSymbolicLink()) {
    invalid('The publication journal directory must be an existing plain, caller-owned directory.');
  }
  const journalDirectoryReal = await fs.realpath(journalDirectory);
  if (contains(root, journalDirectoryReal) || contains(root, path.join(journalDirectoryReal, path.basename(journalFile)))) {
    invalid('The publication journal must live outside the workspace root.');
  }
  if (!Array.isArray(input.changes)) {
    invalid('Publication changes must be an array.');
  }
  if (input.changes.length > MAX_CHANGES) {
    // A capacity refusal is a RESULT, not a throw: no journal exists yet, so
    // nothing can be stranded by it, and no journal can describe more entries
    // than this bound allows.
    return {
      result: {
        state: 'conflict',
        applied: [],
        conflicts: [{ path: ROOT_SCOPE_PATH, reason: `publication capacity: a publication may carry at most ${MAX_CHANGES} changes; publish a smaller approved candidate.` }]
      }
    };
  }

  const conflicts: Conflict[] = [];
  const changes: ValidatedChange[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.changes.length; index += 1) {
    const raw = input.changes[index] as unknown;
    if (typeof raw !== 'object' || raw === null) {
      conflicts.push({ path: '', reason: `Change ${index + 1} is not an object.` });
      continue;
    }
    const record = raw as { path?: unknown; before?: unknown; after?: unknown };
    let segments: string[];
    try {
      segments = validatePath(record.path);
    } catch (error) {
      conflicts.push({ path: typeof record.path === 'string' ? record.path.slice(0, MAX_PATH_LENGTH) : '', reason: message(error) });
      continue;
    }
    const key = segments.join('/');
    let before: PublicationEntry;
    let after: PublicationEntry;
    try {
      before = normalizeEntry(record.before, 'before');
      after = normalizeEntry(record.after, 'after');
    } catch (error) {
      conflicts.push({ path: key, reason: message(error) });
      continue;
    }
    if (before === null && after === null) {
      conflicts.push({ path: key, reason: 'invalid change: both the approved base and the result are absent.' });
      continue;
    }
    const duplicate = compareKey(key);
    if (seen.has(duplicate)) {
      throw new WorkerError('invalid_publication', `The change path ${JSON.stringify(key)} appears more than once.`);
    }
    seen.add(duplicate);
    changes.push({ key, segments, before, after });
  }
  if (conflicts.length > 0) {
    return { result: { state: 'conflict', applied: [], conflicts } };
  }
  return {
    context: {
      input, root, rootIdentity: identityOf(rootStat), journalFile, journalDirectory,
      journalDirectoryIdentity: identityOf(journalDirectoryLink), identity: input.identity,
      changes: [...changes].sort((left, right) => byPath({ path: left.key }, { path: right.key }))
    }
  };
}

/**
 * Walks root -> parent with lstat at every level. Every component must be a
 * plain directory; its dev/ino identity is recorded for the pre-effect recheck.
 */
async function ancestorChain(context: Context, segments: readonly string[]): Promise<readonly Ancestor[] | string> {
  const rootStat = await lstatOrNull(context.root);
  if (!rootStat || !rootStat.isDirectory() || !sameIdentity(identityOf(rootStat), context.rootIdentity)) {
    return 'unsafe root: the workspace root is no longer the same plain directory.';
  }
  const chain: Ancestor[] = [{ path: context.root, identity: context.rootIdentity }];
  let cursor = context.root;
  for (const dir of dirsOf(segments)) {
    cursor = path.join(cursor, ...dir.split('/'));
    const stat = await lstatOrNull(cursor);
    if (!stat) {
      return `unavailable directory: parent directory ${JSON.stringify(dir)} does not exist.`;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return `unsafe directory: ${JSON.stringify(dir)} is not a plain directory.`;
    }
    chain.push({ path: cursor, identity: identityOf(stat) });
  }
  return chain;
}

/**
 * The ONE ancestor check shared by live preflight, live effects and proof-only
 * recovery: every pinned directory must still exist as that same plain
 * directory. A missing, replaced, symlinked or junction directory is refused.
 */
async function verifyAncestors(ancestors: readonly Ancestor[]): Promise<string | undefined> {
  for (const ancestor of ancestors) {
    const stat = await lstatOrNull(ancestor.path);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      return 'unsafe directory: a parent directory is missing or is no longer a plain directory.';
    }
    if (!sameIdentity(identityOf(stat), ancestor.identity)) {
      return 'unsafe directory: a parent directory is no longer the same directory.';
    }
  }
  return undefined;
}

/**
 * Opens a destination for verification without following a final symlink when
 * the platform supports O_NOFOLLOW. Anything that cannot be opened as a plain
 * readable file is reported, never guessed.
 */
async function openReadOnly(target: string): Promise<{ handle: FileHandle } | { reason: string }> {
  try {
    return { handle: await fs.open(target, READ_ONLY_FLAGS) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { reason: 'missing path: the approved base file is gone.' };
    }
    if (code === 'ELOOP' || code === 'EMLINK' || code === 'EPERM') {
      return { reason: 'unsafe path: the destination is a symbolic link or cannot be opened without following one.' };
    }
    throw error;
  }
}

/** Reads exactly `size` bytes, then proves the file did not grow past them. */
async function readExact(handle: FileHandle, size: number): Promise<Buffer | string> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const chunk = await handle.read(bytes, offset, size - offset, offset);
    if (chunk.bytesRead === 0) {
      return 'stale content: the destination ended before its approved size.';
    }
    offset += chunk.bytesRead;
  }
  const probe = Buffer.alloc(1);
  const extra = await handle.read(probe, 0, 1, size);
  return extra.bytesRead === 0 ? bytes : 'stale content: the destination grew while it was inspected.';
}

/**
 * Reads one destination and verifies the plain-file identity, content hash,
 * size and (on POSIX) mode. The size and identity are checked BEFORE any
 * allocation or read, the read is bounded by the approved size, and the opened
 * handle plus the current path entry are re-checked afterwards: the handle's
 * post-read stat and the FINAL lstat are compared for identity, size, precise
 * mtime/ctime, link count and permission bits, so an in-place write or a hard
 * link created during the last observation is refused instead of published
 * over. A symbolic link, a hard link, a special file or a file with
 * setuid/setgid/sticky bits is refused rather than followed, overwritten or
 * silently copied with reduced fidelity.
 */
async function inspectFile(
  target: string, expected: { hash: string; size: number; mode?: FileMode }, rules: InspectionRules = {}
): Promise<Inspection> {
  // Destination semantics by default; a staging entry relaxes exactly the two
  // properties that are not its ownership proof (its planned-payload mode, and
  // the one extra link of a creation interrupted between link() and unlink()).
  const maxLinks = rules.secondLink === true ? 2n : 1n;
  const checkMode = process.platform !== 'win32' && rules.mode !== false;
  const link = await lstatOrNull(target);
  if (!link) {
    return { ok: false, reason: 'missing path: the approved base file is gone.' };
  }
  if (link.isSymbolicLink()) {
    return { ok: false, reason: 'unsafe path: the destination is a symbolic link.' };
  }
  if (!link.isFile()) {
    return { ok: false, reason: 'unsafe path: the destination is not a regular file.' };
  }
  if (link.nlink > maxLinks) {
    return { ok: false, reason: 'unsafe path: the destination is hard-linked.' };
  }
  // Size, identity and type are validated BEFORE any allocation or read.
  if (link.size !== BigInt(expected.size)) {
    return { ok: false, reason: 'stale content: the destination size no longer matches the approved base.' };
  }
  const opened = await openReadOnly(target);
  if ('reason' in opened) {
    return { ok: false, reason: opened.reason };
  }
  const { handle } = opened;
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameIdentity(identityOf(before), identityOf(link)) || !before.isFile() || before.nlink > maxLinks) {
      return { ok: false, reason: CHANGED_REASON };
    }
    if (before.size !== BigInt(expected.size)) {
      return { ok: false, reason: 'stale content: the destination size no longer matches the approved base.' };
    }
    const bytes = await readExact(handle, expected.size);
    if (typeof bytes === 'string') {
      return { ok: false, reason: bytes };
    }
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(identityOf(after), identityOf(before)) || !after.isFile() || after.nlink > maxLinks
      || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      return { ok: false, reason: CHANGED_REASON };
    }
    if (sha256(bytes) !== expected.hash) {
      return { ok: false, reason: 'stale content: the destination bytes no longer match the approved base.' };
    }
    const current = await lstatOrNull(target);
    if (!current || current.isSymbolicLink() || !current.isFile() || !sameIdentity(identityOf(current), identityOf(before))) {
      return { ok: false, reason: CHANGED_REASON };
    }
    // Best available full observation of the last path entry: it must still be
    // the same entry the handle's post-read stat described. Size, precise
    // mtime/ctime, link count and permission bits are compared against THAT
    // stat, so an in-place write or a hard link created after the hashed read
    // is refused here instead of being accepted by a narrower identity check.
    // This is deliberately not a compare-and-swap: the entry can still change
    // after this lstat, which is the documented boundary.
    if (current.size !== after.size || current.nlink !== after.nlink || current.mtimeNs !== after.mtimeNs
      || current.ctimeNs !== after.ctimeNs || Number(current.mode) !== Number(after.mode)) {
      return { ok: false, reason: CHANGED_REASON };
    }
    if (checkMode) {
      // Mode is read from the FINAL path entry - the same entry whose identity
      // was just re-checked - and converted only here, after the exact identity
      // and content checks. Special bits are always refused.
      const mode = Number(current.mode);
      if (Math.floor(mode / 0o1000) % 8 !== 0) {
        return { ok: false, reason: 'unsafe mode: the destination carries special permission bits.' };
      }
      // The approved base entry always carries its mode; only a staging
      // inspection disables this comparison (rules.mode), so a missing mode here
      // is an internal shape error and never a live default.
      if (expected.mode === undefined) {
        throw new WorkerError('internal_error', 'The approved publication entry has no file mode.');
      }
      if (fileModeFromPermissions(mode) !== expected.mode) {
        return { ok: false, reason: 'stale mode: the destination permissions no longer match the approved base.' };
      }
    }
    return { ok: true, stat: current };
  } finally {
    await handle.close();
  }
}

async function absentReason(target: string): Promise<string | undefined> {
  const stat = await lstatOrNull(target);
  return stat ? 'unexpected path: the destination already exists.' : undefined;
}

/**
 * Canonical location of one absolute path: the realpath of its parent directory
 * joined with its own final name, plus the exact dev/ino identity of the final
 * entry when it exists.
 */
interface Location {
  canonical: string;
  identity?: FileIdentity;
}

type Resolution = { ok: true; location: Location } | { ok: false; reason: string };

/**
 * Resolves one path to its canonical location. A target may name a file that
 * does not exist yet (a planned creation), so the PARENT - not the whole path -
 * is realpath'ed: that resolves a Windows junction or a POSIX symlink alias of
 * the directory while still describing a not-yet-created leaf. `stat` (never
 * `lstat`) obtains the leaf identity, so a link AT the path is resolved too.
 * Absence of the parent or of the entry yields a location without an identity;
 * any other failure is returned, so the caller refuses instead of assuming the
 * path is unrelated.
 */
async function resolveLocation(candidate: string): Promise<Resolution> {
  const absolute = path.resolve(candidate);
  const parent = path.dirname(absolute);
  let canonical = absolute;
  if (compareKey(parent) !== compareKey(absolute)) {
    try {
      canonical = path.join(await fs.realpath(parent), path.basename(absolute));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return { ok: false, reason: `unresolvable path: ${absolute} could not be resolved (${code ?? message(error)}).` };
      }
    }
  }
  let identity: FileIdentity | undefined;
  try {
    identity = identityOf(await fs.stat(absolute, { bigint: true }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return { ok: false, reason: `unresolvable path: ${absolute} could not be inspected (${code ?? message(error)}).` };
    }
  }
  return { ok: true, location: { canonical, identity } };
}

/** Same entry: an exact dev/ino match, or the same canonical path. */
function sameLocation(left: Location, right: Location): boolean {
  if (left.identity && right.identity && sameIdentity(left.identity, right.identity)) {
    return true;
  }
  return compareKey(left.canonical) === compareKey(right.canonical);
}

/**
 * Conservative editor guard: any eligible open document that names the touched
 * path literally - including an associated untitled document whose absolute
 * path IS the destination - or through a filesystem alias of it. Aliases are
 * decided by canonical location, never by string spelling, so the same file
 * reported through a Windows junction or a symlink is a conflict BEFORE any
 * effect. Per-file only: the caller evaluates this at every publication
 * boundary, and no document text is ever read or inspected. Nothing is cached
 * between boundaries, so a document opened between two checks is seen by the
 * next one.
 *
 * An absent leaf is NOT automatically unrelated: a document path whose final
 * entry does not exist is still compared by its canonical parent+leaf location,
 * so a not-yet-created target and an associated untitled leaf reported through
 * a resolvable junction (or symlink) parent resolve to the same canonical path
 * and conflict. A path is skipped only when it yields no identity and no
 * canonical location equal to the destination's - for example a document under
 * a parent directory that does not exist, which cannot name this file. A path
 * that cannot be resolved for any other reason is reported, so an unresolvable
 * document is never silently assumed to be a different file.
 */
async function editorReason(documents: readonly OpenDocument[], target: string): Promise<string | undefined> {
  const expected = compareKey(path.resolve(target));
  let destination: Location | undefined;
  for (const document of documents) {
    if (typeof document?.path !== 'string' || !path.isAbsolute(document.path)) {
      continue;
    }
    if (compareKey(path.resolve(document.path)) === expected) {
      return `open editor: ${document.path} is open in an editor; close or save it before publication.`;
    }
    if (!destination) {
      const resolved = await resolveLocation(target);
      if (!resolved.ok) {
        return resolved.reason;
      }
      destination = resolved.location;
    }
    const resolved = await resolveLocation(document.path);
    if (!resolved.ok) {
      return resolved.reason;
    }
    if (sameLocation(resolved.location, destination)) {
      return `open editor: ${document.path} is a filesystem alias of ${target}, which is open in an editor; close or save it before publication.`;
    }
  }
  return undefined;
}

/** The one validated document enumeration of a boundary; throws on a non-array. */
function openDocumentsOf(input: IntegrationPublicationInput): readonly OpenDocument[] {
  const documents = input.openDocuments();
  if (!Array.isArray(documents)) {
    throw new WorkerError('invalid_publication', 'openDocuments() must return an array.');
  }
  return documents;
}

/**
 * Cheap identity of one boundary's scoped absolute open-path inventory: the
 * absolute document paths in enumeration order, encoded so that two different
 * path lists never serialize alike. Only paths are read, never document text.
 */
function inventoryOf(documents: readonly OpenDocument[]): string {
  const paths: string[] = [];
  for (const document of documents) {
    if (typeof document?.path === 'string' && path.isAbsolute(document.path)) {
      paths.push(document.path);
    }
  }
  return JSON.stringify(paths);
}

/**
 * The full live precondition set, evaluated immediately before an effect.
 *
 * Ordering matters and is deliberate, because every step before the last one
 * awaits: the editor guard runs FIRST, since its alias resolution performs
 * realpath and stat calls that may be long, and it must never sit between the
 * target's live observation and the effect; the ancestor/path proof then runs
 * under a fresh guard, immediately before the target proof; and the target's
 * identity, size, content and mode are observed LAST. A target observation is
 * therefore never separated from the effect by an unrelated await.
 *
 * The scoped absolute open-path inventory is captured with the documents before
 * the alias awaits and re-read after the target proof; when it changed, a
 * document was opened or closed while this file was checked, so the file is
 * reported as a retryable per-file editor conflict rather than applied against
 * a stale inventory. The re-read happens after the final target proof and
 * nothing that touches the filesystem awaits after it: one cheap enumeration,
 * with no alias resolution repeated or cached.
 */
async function checkDestination(context: Context, prepared: Prepared): Promise<DestinationCheck> {
  context.input.authorize();
  // 1. Editor guard first, on the freshly captured document list: the alias IO
  //    it awaits cannot delay a target observation that has not happened yet.
  const documents = openDocumentsOf(context.input);
  const inventory = inventoryOf(documents);
  // A fresh guard immediately before the alias IO: no filesystem-observing step
  // of this check is entered on a revoked authorization.
  context.input.authorize();
  const editor = await editorReason(documents, prepared.target);
  if (editor) {
    return { ok: false, reason: editor };
  }
  // 2. The ancestor/path proof under a fresh guard, immediately before the
  //    target proof, so the verified chain is as current as the target itself.
  context.input.authorize();
  const unsafe = await verifyAncestors(prepared.ancestors);
  if (unsafe) {
    return { ok: false, reason: unsafe };
  }
  // 3. The final live target proof: the last filesystem observation here.
  let base: BigIntStats | undefined;
  if (prepared.change.before === null) {
    const present = await absentReason(prepared.target);
    if (present) {
      return { ok: false, reason: present };
    }
  } else {
    const inspection = await inspectFile(prepared.target, prepared.change.before);
    if (!inspection.ok) {
      return { ok: false, reason: inspection.reason };
    }
    base = inspection.stat;
  }
  // 4. The inventory re-read is the last step and awaits no filesystem access,
  //    so a document opened or closed at any point in this check is still seen.
  if (inventoryOf(openDocumentsOf(context.input)) !== inventory) {
    return { ok: false, reason: EDITOR_INVENTORY_REASON };
  }
  return { ok: true, base };
}

/** Read-only preflight of one pending change, before any journal write. */
async function preflight(context: Context, change: ValidatedChange, trusted?: readonly Ancestor[]): Promise<Prepared | Conflict> {
  context.input.authorize();
  const target = path.join(context.root, ...change.segments);
  if (path.relative(context.root, target).split(path.sep).join('/') !== change.key) {
    return { path: change.key, reason: 'unsafe path: the canonical path escapes the workspace root.' };
  }
  let ancestors: readonly Ancestor[];
  if (trusted) {
    // A journaled chain is trusted only while it still names the same plain dirs.
    const unsafe = await verifyAncestors(trusted);
    if (unsafe) {
      return { path: change.key, reason: unsafe };
    }
    ancestors = trusted;
  } else {
    const chain = await ancestorChain(context, change.segments);
    if (typeof chain === 'string') {
      return { path: change.key, reason: chain };
    }
    ancestors = chain;
  }
  if (process.platform === 'win32' && change.after !== null && entryMode(change.after) !== entryMode(change.before)) {
    return { path: change.key, reason: 'mode unsupported: Windows cannot apply a file-mode change.' };
  }
  let bytes: Buffer | undefined;
  if (change.after !== null) {
    try {
      bytes = await context.input.read(change.key);
    } catch (error) {
      return { path: change.key, reason: `approved content unavailable: ${message(error)}` };
    }
    if (!Buffer.isBuffer(bytes)) {
      throw new WorkerError('invalid_publication', 'read() must resolve to a Buffer.');
    }
    context.input.authorize();
    if (bytes.length !== change.after.size || sha256(bytes) !== change.after.hash) {
      return { path: change.key, reason: 'stale approved content: the approved bytes do not match the approved entry.' };
    }
    // The declared plan-wide byte budget was checked before this read, so a
    // publication never allocates approved bytes it has already refused.
  }
  const prepared: Prepared = { change, target, ancestors, bytes };
  const check = await checkDestination(context, prepared);
  return check.ok ? prepared : { path: change.key, reason: check.reason };
}

/** Best-effort directory flush; Windows cannot fsync a directory handle. */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* The rename/link remains atomic on platforms without directory fsync. */
  }
}

async function verifyJournalDirectory(context: Context): Promise<void> {
  const stat = await lstatOrNull(context.journalDirectory);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(identityOf(stat), context.journalDirectoryIdentity)) {
    throw new WorkerError('publication_conflict', 'The publication journal directory changed; inspect it before publishing again.');
  }
}

function trustDocument(trust: JournalTrust): { root: { dev: string; ino: string }; parents: Record<string, { dev: string; ino: string }> } {
  const parents: Record<string, { dev: string; ino: string }> = Object.create(null) as Record<string, { dev: string; ino: string }>;
  for (const key of [...trust.parents.keys()].sort()) {
    const identity = trust.parents.get(key);
    if (identity) {
      parents[key] = identityDocument(identity);
    }
  }
  return { root: identityDocument(trust.root), parents };
}

/**
 * The persisted shape of one entry. Every row of the ONE current journal shape
 * carries its `stage` field explicitly: null when the runtime phase has no
 * staging record at all (a row before its intent, a deletion, a cleared record),
 * otherwise the record with its own `identity` field - null while only the name
 * is pinned, or the exact dev/ino pair encoded as decimal strings exactly like
 * every other identity in the file.
 */
function entryDocument(entry: JournalEntry): Record<string, unknown> {
  const stage = entry.stage;
  const base = { path: entry.path, state: entry.state, before: entry.before, after: entry.after };
  if (!stage) {
    return { ...base, stage: null };
  }
  return {
    ...base,
    stage: { name: stage.name, identity: stage.identity ? identityDocument(stage.identity) : null }
  };
}

/**
 * The ONE journal encoding: the durable write, its defensive write bound and the
 * worst-case capacity check all use this exact serialization, so the journal this
 * module refuses is exactly one its own recovery could not read back.
 */
function serializeJournal(
  identity: string, root: string, plan: string, revision: number, trust: JournalTrust, entries: readonly JournalEntry[]
): string {
  return JSON.stringify({
    schema: JOURNAL_SCHEMA, identity, root, plan, revision, trust: trustDocument(trust),
    entries: entries.map(entryDocument)
  });
}

/** The longest persisted per-file state; a journal revision never exceeds it. */
const WORST_JOURNAL_STATE: JournalState = 'interrupted';
/** A full-length plan digest, so the bound never depends on the current plan. */
const WORST_PLAN_DIGEST = '0'.repeat(64);
/** Widest decimal text a pinned identity may carry (see DECIMAL_PATTERN). */
const WORST_IDENTITY: FileIdentity = { dev: 99999999999999999999n, ino: 99999999999999999999n };
/** Widest optional staging metadata: the longest name plus a maximum-width identity. */
const WORST_STAGE: JournalStage = { name: WORST_STAGING_NAME, identity: WORST_IDENTITY };

/**
 * Upper bound of the encoded size of EVERY journal revision this plan can still
 * produce: the same entries under the longest per-file state, the largest safe
 * revision, the pinned identities and - for every entry that can stage a payload
 * - the widest optional stage metadata. Bounding the worst case - not one
 * revision - is what makes a committed journal readable again; it is evaluated
 * before the first journal write and before any destination effect.
 */
function maximumJournalBytes(identity: string, root: string, trust: JournalTrust, entries: readonly JournalEntry[]): number {
  const worst = entries.map(entry => ({
    ...entry,
    state: WORST_JOURNAL_STATE,
    stage: entry.after === null ? undefined : WORST_STAGE
  }));
  return Buffer.byteLength(serializeJournal(identity, root, WORST_PLAN_DIGEST, Number.MAX_SAFE_INTEGER, trust, worst), 'utf8');
}

/**
 * Conservative trust for a plan that has not been preflighted yet: exactly the
 * parent keys collectTrust() will pin, each with a maximum-width identity, so the
 * bound never depends on which directories happen to exist.
 */
function estimatedTrust(entries: readonly JournalEntry[]): JournalTrust {
  const parents = new Map<string, FileIdentity>();
  for (const key of requiredParents(entries)) {
    parents.set(key, WORST_IDENTITY);
  }
  return { root: WORST_IDENTITY, parents };
}

const journalCapacityReason = (bytes: number): string =>
  `journal capacity: the publication journal can reach ${bytes} bytes, above the ${MAX_JOURNAL_BYTES}-byte journal bound its own recovery enforces; publish a smaller approved candidate.`;

/**
 * Diagnostic path of a refusal that concerns the WHOLE plan (change count,
 * declared bytes) rather than one change or the journal file. It is the root
 * itself, never an empty string: a caller that keys an attempt ledger entry by
 * `conflict.path` requires a nonempty path, and an empty one would strand the
 * attempt whose intent this safe refusal just declined to start.
 */
const ROOT_SCOPE_PATH = '.';

const totalCapacityReason = (bytes: number): string =>
  `publication capacity: the plan declares ${bytes} approved bytes, above the ${MAX_TOTAL_BYTES}-byte publication bound; publish a smaller approved candidate.`;

/**
 * Publishes one journal revision. `authorize` adds the pre-write guard; the
 * beforeRename guard runs in EVERY case, so no journal revision - completion,
 * bookkeeping, or an interruption record - is ever renamed into place after the
 * live authorization was revoked. A refusal there removes the temporary record
 * and leaves the previous revision (for example the durable `intent`) intact,
 * so the next attempt uses proof-only recovery instead of an unguarded record.
 */
async function persistJournal(context: Context, journal: Journal, entries: JournalEntry[], authorize: boolean): Promise<void> {
  if (authorize) {
    context.input.authorize();
  }
  await verifyJournalDirectory(context);
  const plan = planOf(entries, journal.trust);
  const revision = journal.revision + 1;
  const text = serializeJournal(journal.identity, journal.root, plan, revision, journal.trust, entries);
  // Defensive write bound, independent of the capacity check that runs before
  // the first write: a revision is never renamed into place when it would exceed
  // the bound its own recovery enforces. The previous revision stays intact and
  // the failure is never swallowed, so no ambiguous effect is reported as safe.
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_JOURNAL_BYTES) {
    throw new WorkerError('publication_capacity', `Publication journal revision ${revision} would be ${bytes} bytes, above the ${MAX_JOURNAL_BYTES}-byte journal bound; the previous revision is intact.`);
  }
  await atomicWrite(context.journalFile, text, 0o600, () => context.input.authorize());
  journal.plan = plan;
  journal.revision = revision;
  journal.entries = entries;
}

/**
 * Writes one entry's durable state. The staging record is dropped only when the
 * write PROVES no staging entry of this module can be left behind: `applied`
 * (published) and a `pending` retry whose own cleanup proved the entry gone pass
 * no record. `interrupted` keeps the existing record, because the bookkeeping has
 * to survive the error that produced it, and a `pending` retry that could NOT
 * prove its staging entry gone passes that record explicitly - so a known owned
 * stage is never silently dropped from the durable record.
 */
async function writeState(context: Context, journal: Journal, key: string, state: JournalState, stage?: JournalStage): Promise<void> {
  const entries = journal.entries.map(entry => {
    if (entry.path !== key) {
      return entry;
    }
    if (stage !== undefined) {
      return { ...entry, state, stage };
    }
    return state === 'interrupted' ? { ...entry, state } : { ...entry, state, stage: undefined };
  });
  await persistJournal(context, journal, entries, true);
}

/**
 * Writes one resolved state together with EXACTLY the staging record the resolver
 * passes. `undefined` is used only when that record's path was proved absent (its
 * entry was removed, or no longer exists at all), so no staging entry of this
 * module can be left behind; a record is passed back verbatim when its cleanup
 * could not be proved, so a known owned stage - including one of an already
 * applied row - is never silently dropped from the journal.
 */
async function writeResolvedState(
  context: Context, journal: Journal, key: string, state: JournalState, stage: JournalStage | undefined
): Promise<void> {
  const entries = journal.entries.map(entry => (entry.path === key ? { ...entry, state, stage } : entry));
  await persistJournal(context, journal, entries, true);
}

/**
 * Writes one entry's durable `intent`, pinned to the staging basename that entry
 * will use, so the name is durable BEFORE the entry can exist and is covered by
 * the caller's own intent checkpoint. The single per-row stage slot is never
 * overwritten: ANY existing record - even one whose basename happens to coincide
 * with the freshly generated one - means the row's previously recorded staging
 * entry was not reconciled, so nothing may be staged.
 */
async function writeIntent(context: Context, journal: Journal, key: string, name?: string): Promise<void> {
  const entries = journal.entries.map(entry => {
    if (entry.path !== key) {
      return entry;
    }
    if (entry.stage !== undefined) {
      throw new WorkerError('internal_error', 'A recorded staging entry was not reconciled before a new staging name was pinned.');
    }
    return { ...entry, state: 'intent' as JournalState, stage: name === undefined ? undefined : { name } };
  });
  await persistJournal(context, journal, entries, true);
}

/**
 * Records the staging entry's ACTUAL file identity durably, immediately after the
 * exclusive create and BEFORE the first payload byte. Only this record can later
 * prove which inode the intent created, so it is never skipped and never
 * inferred: without it the staging entry stays unproved debris.
 */
async function writeStageIdentity(context: Context, journal: Journal, key: string, stage: JournalStage): Promise<void> {
  const entries = journal.entries.map(entry => (entry.path === key ? { ...entry, stage } : entry));
  await persistJournal(context, journal, entries, true);
}

/**
 * Best-effort interruption bookkeeping for an effect error: no pre-write guard
 * (the caller is already failing for a non-authorization reason), but the same
 * beforeRename guard. If authorization was revoked, this record is not
 * published and the durable `intent` stands, so recovery stays proof-only.
 */
async function recordInterrupted(context: Context, journal: Journal, key: string): Promise<void> {
  const entries = journal.entries.map(entry => (entry.path === key ? { ...entry, state: 'interrupted' as JournalState } : entry));
  await persistJournal(context, journal, entries, false);
}

/**
 * POSIX permissions for one publication: when the approved entry asks for the
 * same executable class the destination already carries, every existing
 * permission bit is preserved verbatim (0o744 stays 0o744, 0o600 is never
 * widened to 0o644). An intentional supported mode change (0o644 <-> 0o755)
 * applies only the approved executable bit where the corresponding read bit is
 * present and keeps the destination's read/write bits. A fresh creation uses
 * the approved mode. Callers reject special bits first.
 */
function desiredPermissions(base: BigIntStats | undefined, planned: FileMode): number {
  if (!base) {
    return planned;
  }
  // The destination's mode is converted only here, after inspectFile validated
  // its special bits and approved permission class.
  const permissions = Number(base.mode) % 0o1000;
  if (fileModeFromPermissions(permissions) === planned) {
    // No mode change is planned, so this is an owner's or a project's existing
    // permission set and every bit of it is preserved - including an executable
    // class whose execute bits sit on other slots (0o711 stays 0o711).
    return permissions;
  }
  // An intentional supported mode change: only the approved executable bit is
  // applied, and the destination's read/write bits are preserved.
  const slots = [Math.floor(permissions / 64) % 8, Math.floor(permissions / 8) % 8, permissions % 8];
  const mapped = slots.map(slot => {
    const read = Math.floor(slot / 4) % 2;
    const write = Math.floor(slot / 2) % 2;
    const executable = planned === EXECUTABLE_FILE_MODE && read === 1 ? 1 : 0;
    return read * 4 + write * 2 + executable;
  });
  return mapped[0] * 64 + mapped[1] * 8 + mapped[2];
}

/** Persists one entry's staged identity; supplied by the journal owner. */
type StageRecorder = (stage: JournalStage) => Promise<void>;

/**
 * The final observation of this call's own staged payload, immediately before
 * the only step that can publish it. The path entry must still be the exact stat
 * the verified read ended with - same inode, plain single-link regular file,
 * same size and precise times - so a swapped, truncated, edited or
 * independently hard-linked staging name is refused instead of published.
 */
async function stagingReason(staging: string, verified: BigIntStats, identity: FileIdentity): Promise<string | undefined> {
  const stat = await lstatOrNull(staging);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== verified.nlink) {
    return STAGE_CHANGED_REASON;
  }
  if (!sameIdentity(identityOf(stat), identity)) {
    return STAGE_CHANGED_REASON;
  }
  return stat.size === verified.size && stat.mtimeNs === verified.mtimeNs
    && stat.ctimeNs === verified.ctimeNs && stat.mode === verified.mode
    ? undefined
    : STAGE_CHANGED_REASON;
}

/**
 * Removes exactly ONE staging entry this publication proved it owns, and reports
 * whether it is gone. This is the ONE ownership rule, shared by the in-process
 * failure cleanup and by proof-only recovery: the pinned ancestors still verify,
 * the path entry is a plain regular file that is still the recorded dev/ino
 * identity, no open editor names it, its bytes - read through the same bounded,
 * no-follow handle as a destination and bound to that identity by the post-read
 * stat and by the final path entry - are exactly the approved payload. Its
 * link count is one, or two for a creation whose final target is that second
 * link. Everything else is
 * left exactly as it is: a partial payload, a same-size later edit, a
 * byte-identical clone at the same name, a third link, an untrusted parent, an
 * open editor on the staging name, and any record without a durable identity.
 * Nothing is discovered by globbing or scanning - only the pinned basename is
 * examined - and the removal is itself a guarded effect, so a revoked
 * authorization deletes nothing.
 */
async function removeProvenStage(
  context: Context, chain: readonly Ancestor[] | string, staging: string, approved: PublicationEntry,
  identity: FileIdentity, secondLinkTarget?: string
): Promise<boolean> {
  if (approved === null || typeof chain === 'string') {
    return false;
  }
  try {
    // 1. The editor guard first: its alias resolution awaits, and it must never
    //    sit between the staging observation and the removal.
    const documents = openDocumentsOf(context.input);
    const inventory = inventoryOf(documents);
    context.input.authorize();
    if (await editorReason(documents, staging)) {
      return false;
    }
    // 2. The pinned ancestor proof, under a fresh guard.
    context.input.authorize();
    if ((await verifyAncestors(chain)) !== undefined) {
      return false;
    }
    // 3. The staged bytes, bound to the recorded inode: size and identity are
    //    checked before any allocation or read, the read is bounded by the
    //    approved size, and the handle's post-read stat plus the final path entry
    //    must still describe that same entry, so a same-size clone swap or an
    //    in-place edit is refused instead of removed.
    const link = await lstatOrNull(staging);
    if (!link || link.isSymbolicLink() || !link.isFile() || !sameIdentity(identityOf(link), identity)) {
      return false;
    }
    const secondLink = link.nlink === 2n && secondLinkTarget !== undefined;
    if (link.nlink !== 1n && !secondLink) {
      return false;
    }
    // A zero-length file can be an unstarted stage or a later truncation.
    // The approved size and digest are required for any removal.
    if (link.size !== BigInt(approved.size)) {
      return false;
    }
    const verified = await inspectFile(staging, approved, { mode: false, secondLink });
    if (!verified.ok || !sameIdentity(identityOf(verified.stat), identity)) {
      return false;
    }
    if (secondLink) {
      // link() succeeded and unlink() did not: the destination already holds this
      // very inode, so removing the staging name publishes nothing new.
      const published = secondLinkTarget === undefined ? undefined : await lstatOrNull(secondLinkTarget);
      if (!published || published.isSymbolicLink() || !published.isFile()
        || !sameIdentity(identityOf(published), identity)) {
        return false;
      }
    }
    // 4. Recheck the path after hashing the staged bytes. Refresh the editor
    //    inventory after the final filesystem observations.
    if ((await verifyAncestors(chain)) !== undefined || await stagingReason(staging, verified.stat, identity)) {
      return false;
    }
    if (inventoryOf(openDocumentsOf(context.input)) !== inventory) {
      return false;
    }
    context.input.authorize();
    await fs.unlink(staging);
    await syncDirectory(path.dirname(staging));
    return true;
  } catch {
    // Any unexpected failure leaves the entry in place: an unproved removal is
    // never attempted a second way.
    return false;
  }
}

/**
 * Performs exactly one destination effect. Every verifiable precondition is
 * re-checked here, immediately before publication, after the caller recorded a
 * durable intent. Nothing is written outside the workspace, and this call only
 * ever removes its own staged entry: a fixed-length sibling name whose identity
 * is durable before its payload and whose exact inode, bytes and path
 * preconditions are the only thing cleanup may rely on. A staging entry that
 * cannot be provably removed is reported as durable stage debris, so the record
 * of it is never silently dropped.
 */
async function effect(context: Context, prepared: Prepared, recordStage: StageRecorder): Promise<EffectOutcome> {
  let debris: JournalStage | undefined;
  const outcome = await applyStaged(context, prepared, recordStage, stage => {
    debris = stage;
  });
  return outcome.ok || debris === undefined ? outcome : { ...outcome, stageDebris: debris };
}

/** One effect's staged flow; `onDebris` reports an unprovable staging entry. */
async function applyStaged(
  context: Context, prepared: Prepared, recordStage: StageRecorder, onDebris: (stage: JournalStage) => void
): Promise<EffectOutcome> {
  const check = await checkDestination(context, prepared);
  if (!check.ok) {
    return { ok: false, reason: check.reason };
  }
  if (prepared.change.after === null) {
    context.input.authorize();
    await fs.unlink(prepared.target);
    await syncDirectory(path.dirname(prepared.target));
    return { ok: true };
  }
  const payload = prepared.bytes;
  if (!payload) {
    throw new WorkerError('internal_error', 'Approved bytes are missing for a planned file publication.');
  }
  const name = prepared.staging;
  if (!name) {
    throw new WorkerError('internal_error', 'A staging name is missing for a planned file publication.');
  }
  const after = prepared.change.after;
  const directory = path.dirname(prepared.target);
  const staging = path.join(directory, name);
  const desired = desiredPermissions(check.base, entryMode(after));
  let owned: JournalStage | undefined;
  let published = false;
  try {
    let handle: FileHandle;
    try {
      // Exclusive creation of the pinned name: an entry that already exists at
      // that name is never adopted, overwritten or removed by this call.
      handle = await fs.open(staging, 'wx', TEMPORARY_FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, reason: STAGE_TAKEN_REASON };
      }
      throw error;
    }
    try {
      // The ACTUAL file identity is recorded durably BEFORE the first payload
      // byte, so recovery can prove this exact staging entry - and only it.
      owned = { name, identity: identityOf(await handle.stat({ bigint: true })) };
      await recordStage(owned);
      await handle.writeFile(payload);
      if (process.platform !== 'win32') {
        await handle.chmod(desired);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const identity = owned.identity;
    if (!identity) {
      throw new WorkerError('internal_error', 'The staged payload has no recorded identity.');
    }
    // 1. The staged payload is proved EXACTLY before anything can publish it: it
    //    is still the inode this call created, a plain single-link regular file,
    //    and its bytes are the approved ones while its identity, size and precise
    //    times are stable across the bounded read and matched again by the final
    //    path entry. A same-size edit of the staging entry, a swap, a truncation
    //    or an independent hard link is refused here instead of published. This
    //    is the long observation, so it runs BEFORE the final live destination
    //    check: a user edit of the destination during staging verification is
    //    caught by the check that follows it.
    const staged = await inspectFile(staging, { hash: after.hash, size: after.size }, { mode: false });
    if (!staged.ok || !sameIdentity(identityOf(staged.stat), identity)) {
      return { ok: false, reason: STAGE_CHANGED_REASON };
    }
    // 2. The final live destination check, AFTER the staged verification.
    const again = await checkDestination(context, prepared);
    if (!again.ok) {
      return { ok: false, reason: again.reason };
    }
    // The staged payload carries the permission bits observed by the FIRST live
    // check (every one of them when the executable class is unchanged); a rename
    // over the destination would apply them. When
    // the final check sees a different full POSIX mode (for example an owner
    // edit from 0o644 to 0o600 during staging), publication is refused instead
    // of silently reverting that edit: nothing is renamed, only this call's own
    // staging name is removed.
    if (process.platform !== 'win32' && check.base && again.base && Number(check.base.mode) !== Number(again.base.mode)) {
      return { ok: false, reason: STAGED_MODE_REASON };
    }
    // 3. The final observation of the verified staging entry, immediately before
    //    the only step that can publish it: the path entry must still be the exact
    //    stat the verified read ended with, so an edit or a swap that landed
    //    during the destination check is refused too.
    const moved = await stagingReason(staging, staged.stat, identity);
    if (moved) {
      return { ok: false, reason: moved };
    }
    context.input.authorize();
    if (prepared.change.before === null) {
      try {
        // Exclusive link publication: a concurrent creator is never overwritten.
        await fs.link(staging, prepared.target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return { ok: false, reason: 'unexpected path: the destination appeared before it could be created.' };
        }
        throw error;
      }
      // The single window in which the staged entry is a second link to the
      // published inode: recovery proves that case by identity and content.
      await fs.unlink(staging);
      published = true;
    } else {
      // Rename replaces the directory entry atomically; the verified base file
      // (plain, independent, hash-matched) is the only thing it can overwrite.
      await fs.rename(staging, prepared.target);
      published = true;
    }
    await syncDirectory(directory);
    return { ok: true };
  } finally {
    if (!published && owned?.identity) {
      // Only an entry whose identity, bytes and path preconditions prove it is
      // this call's own staging entry is removed here; an edited, cloned or
      // partial one is left in place and reported as durable stage debris. A
      // `finally` never returns or throws, so the outcome of this effect and any
      // error are preserved exactly.
      const identity = owned.identity;
      const removed = await removeProvenStage(
        context, prepared.ancestors, staging, after, identity,
        prepared.change.before === null ? prepared.target : undefined
      );
      if (!removed) {
        onDebris(owned);
      }
    }
  }
}

/**
 * Proof-only completion check for a durable intent. It runs under the SAME
 * pinned ancestor checks as normal preflight, so an intent is never "proven"
 * through a replaced, missing or linked parent directory.
 */
async function provesApplied(target: string, after: PublicationEntry, ancestors: readonly Ancestor[]): Promise<Proof> {
  const unsafe = await verifyAncestors(ancestors);
  if (unsafe) {
    return { done: false, detail: unsafe };
  }
  if (after === null) {
    const stat = await lstatOrNull(target);
    return stat ? { done: false, detail: 'the path still exists' } : { done: true };
  }
  const inspection = await inspectFile(target, after);
  return inspection.ok ? { done: true } : { done: false, detail: inspection.reason };
}

/** Absolute path of one durable staging record, re-derived from its own entry. */
function stagingPathOf(context: Context, entry: JournalEntry): string | undefined {
  const stage = entry.stage;
  if (!stage) {
    return undefined;
  }
  const segments = entry.path.split('/');
  if (stage.name === segments[segments.length - 1]) {
    // A record naming the destination itself is never a staging sibling.
    return undefined;
  }
  const directory = path.join(context.root, ...segments.slice(0, -1));
  const staging = path.join(directory, stage.name);
  return compareKey(path.dirname(staging)) === compareKey(directory) ? staging : undefined;
}

/**
 * Removes exactly ONE staging entry of a durable row, and only when its ownership
 * is proved by removeProvenStage(): pinned ancestors, the recorded file identity,
 * the approved bytes, the type/link state and the editor/path preconditions. Its bytes are bound to the recorded
 * inode across the open, the bounded read and the final path entry, so a
 * same-size clone or a later edit is refused. Everything else - a partial
 * payload, a row whose stage is null or whose stage identity is still null, an
 * untrusted parent, an open editor - is left exactly as it is, and nothing is
 * discovered by globbing or scanning: only the pinned basename is ever examined.
 * The two-link window is only accepted for a creation
 * whose exact final target is that second link.
 */
async function cleanupStage(context: Context, chain: readonly Ancestor[] | string, entry: JournalEntry): Promise<boolean> {
  const stage = entry.stage;
  const after = entry.after;
  const identity = stage?.identity;
  if (!stage || !identity || after === null) {
    // Nothing is staged for a deletion, and without a durable identity there is
    // no ownership proof at all: an unproved staging entry is never touched.
    return false;
  }
  const staging = stagingPathOf(context, entry);
  if (staging === undefined) {
    return false;
  }
  const segments = entry.path.split('/');
  const published = entry.before === null ? path.join(context.root, ...segments) : undefined;
  return removeProvenStage(context, chain, staging, after, identity, published);
}

/**
 * Proves that the pinned staging path of one row is ABSENT. It runs only after
 * removeProvenStage() REFUSED the removal, so an ENOENT is not taken at face
 * value: the pinned ancestors are re-verified first, because an absent path seen
 * through a replaced, missing or linked parent directory proves nothing about the
 * entry this record describes. Any other failure - permission, I/O, or a path that
 * cannot be lstat'ed at all - leaves the staging entry UNPROVED rather than absent.
 */
async function stagePathAbsent(context: Context, chain: readonly Ancestor[], staging: string): Promise<boolean> {
  context.input.authorize();
  if ((await verifyAncestors(chain)) !== undefined) {
    return false;
  }
  try {
    await fs.lstat(staging, { bigint: true });
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Outcome of reconciling the ONE staging entry a durable row still records.
 * `cleared` means the pinned path is proved ABSENT (this call removed it, or
 * nothing exists at that name any more under the re-verified ancestors) and the
 * single per-row stage slot may be emptied; `unproved` means the path still exists
 * - or could not be observed - and must keep its exact record; `unverified` means
 * the pinned ancestors are not trusted, so no decision about that path may be made
 * at all.
 */
type StageReconcile =
  | { state: 'none' }
  | { state: 'cleared' }
  | { state: 'unproved'; staging: string }
  | { state: 'unverified' };

/**
 * Reconciles the EXACT staging entry a durable row still records, before that row
 * may stage again and without starting any pending effect. Ownership is decided by
 * the ONE shared rule of removeProvenStage(), so an edited, cloned, partial,
 * hard-linked, editor-held or untrusted entry is never removed or replaced; the
 * record may be dropped only once its path is proved absent, and a path that
 * cannot be observed at all counts as unproved. A row whose record survives keeps
 * it verbatim and is reported as retryable with its staging path.
 */
async function reconcileStage(
  context: Context, entry: JournalEntry, chain: readonly Ancestor[] | string
): Promise<StageReconcile> {
  if (entry.stage === undefined) {
    return { state: 'none' };
  }
  if (typeof chain === 'string') {
    return { state: 'unverified' };
  }
  const staging = stagingPathOf(context, entry);
  if (staging === undefined) {
    return { state: 'unverified' };
  }
  if (await cleanupStage(context, chain, entry)) {
    return { state: 'cleared' };
  }
  return (await stagePathAbsent(context, chain, staging)) ? { state: 'cleared' } : { state: 'unproved', staging };
}

function parseTrust(record: unknown, entries: readonly JournalEntry[]): JournalTrust | string {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return 'the publication journal trust record is missing.';
  }
  const trust = record as Record<string, unknown>;
  for (const key of Object.keys(trust)) {
    if (!JOURNAL_TRUST_KEYS.has(key)) {
      return `the publication journal trust record has an unknown field ${JSON.stringify(key)}.`;
    }
  }
  let root: FileIdentity;
  try {
    root = normalizeIdentity(trust.root, 'journal root');
  } catch (error) {
    return message(error);
  }
  const rawParents = trust.parents;
  if (typeof rawParents !== 'object' || rawParents === null || Array.isArray(rawParents)) {
    return 'the publication journal parent identities are missing.';
  }
  const parents = new Map<string, FileIdentity>();
  for (const key of Object.keys(rawParents)) {
    let segments: string[];
    try {
      segments = validatePath(key);
    } catch {
      return `the publication journal pins an invalid parent directory ${JSON.stringify(key)}.`;
    }
    if (segments.join('/') !== key || parents.has(key)) {
      return `the publication journal pins a non-canonical or duplicate parent directory ${JSON.stringify(key)}.`;
    }
    try {
      parents.set(key, normalizeIdentity((rawParents as Record<string, unknown>)[key], `journal parent ${key}`));
    } catch (error) {
      return message(error);
    }
  }
  const required = requiredParents(entries);
  if (parents.size !== required.size) {
    return 'the publication journal pins a different set of parent directories than its entries require.';
  }
  for (const key of required) {
    if (!parents.has(key)) {
      return `the publication journal pins no identity for ${JSON.stringify(key)}.`;
    }
  }
  return { root, parents };
}

function changeSignatures(entries: readonly { path: string; before: PublicationEntry; after: PublicationEntry }[]): string {
  return [...entries].sort(byPath).map(entry => JSON.stringify([entry.path, entry.before, entry.after])).join('\n');
}

function parseJournal(text: string, context: Context): Journal | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'the publication journal is not valid JSON; inspect it before publishing again.';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'the publication journal is not an object.';
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!JOURNAL_KEYS.has(key)) {
      return `the publication journal has an unknown field ${JSON.stringify(key)}.`;
    }
  }
  if (record.schema !== JOURNAL_SCHEMA) {
    return 'the publication journal schema is not supported.';
  }
  if (typeof record.identity !== 'string' || record.identity !== context.identity) {
    return 'the publication journal belongs to a different approved candidate.';
  }
  if (typeof record.root !== 'string' || record.root !== context.root) {
    return 'the publication journal belongs to a different workspace root.';
  }
  const revision = record.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    return 'the publication journal revision must be a non-negative safe integer.';
  }
  const rawEntries = record.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length > MAX_CHANGES) {
    return 'the publication journal entries are missing or out of bounds.';
  }
  const entries: JournalEntry[] = [];
  const seen = new Set<string>();
  for (const raw of rawEntries) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return 'a publication journal entry is not an object.';
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!JOURNAL_ENTRY_KEYS.has(key)) {
        return `a publication journal entry has an unknown field ${JSON.stringify(key)}.`;
      }
    }
    if (typeof entry.path !== 'string') {
      return 'a publication journal entry path is not a string.';
    }
    let segments: string[];
    try {
      segments = validatePath(entry.path);
    } catch {
      return `the publication journal contains an invalid path ${JSON.stringify(entry.path)}.`;
    }
    const key = segments.join('/');
    if (key !== entry.path || seen.has(key)) {
      return `the publication journal contains a non-canonical or duplicate path ${JSON.stringify(entry.path)}.`;
    }
    seen.add(key);
    if (typeof entry.state !== 'string' || !JOURNAL_STATES.includes(entry.state as JournalState)) {
      return `the publication journal state for ${JSON.stringify(key)} is not supported.`;
    }
    let before: PublicationEntry;
    let after: PublicationEntry;
    try {
      before = normalizeEntry(entry.before, 'journal before');
      after = normalizeEntry(entry.after, 'journal after');
    } catch {
      return `the publication journal entry for ${JSON.stringify(key)} is not a valid file entry.`;
    }
    if (before === null && after === null) {
      return `the publication journal entry for ${JSON.stringify(key)} has no change.`;
    }
    if (entry.stage === undefined) {
      return `the publication journal entry for ${JSON.stringify(key)} omits its stage field; a current journal encodes the absence of a staging record as null.`;
    }
    let stage: JournalStage | undefined;
    if (entry.stage !== null) {
      const parsedStage = normalizeStage(entry.stage, segments[segments.length - 1], after !== null);
      if (typeof parsedStage === 'string') {
        return `the publication journal entry for ${JSON.stringify(key)} has an invalid stage: ${parsedStage}`;
      }
      stage = parsedStage;
    }
    entries.push({ path: key, state: entry.state as JournalState, before, after, stage });
  }
  const trust = parseTrust(record.trust, entries);
  if (typeof trust === 'string') {
    return trust;
  }
  if (typeof record.plan !== 'string' || record.plan !== planOf(entries, trust)) {
    return 'the publication journal plan does not match its own entries and directory identities.';
  }
  if (changeSignatures(entries) !== changeSignatures(context.changes.map(change => ({ path: change.key, before: change.before, after: change.after })))) {
    return 'the publication journal describes different changes; it is never rewritten.';
  }
  return { schema: JOURNAL_SCHEMA, identity: context.identity, root: context.root, plan: record.plan, revision, trust, entries };
}

async function loadJournal(context: Context): Promise<{ journal?: Journal; conflict?: Conflict }> {
  const link = await lstatOrNull(context.journalFile);
  if (!link) {
    return {};
  }
  if (link.isSymbolicLink() || !link.isFile() || link.nlink > 1n) {
    return { conflict: { path: context.journalFile, reason: 'journal conflict: the publication journal is not an independent regular file; inspect it before publishing again.' } };
  }
  if (link.size > BigInt(MAX_JOURNAL_BYTES)) {
    return { conflict: { path: context.journalFile, reason: `journal conflict: the publication journal exceeds ${MAX_JOURNAL_BYTES} bytes; inspect it before publishing again.` } };
  }
  const opened = await openReadOnly(context.journalFile);
  if ('reason' in opened) {
    return { conflict: { path: context.journalFile, reason: `journal conflict: ${opened.reason}` } };
  }
  const { handle } = opened;
  let text: string;
  try {
    const stat = await handle.stat({ bigint: true });
    // Bind the journal bytes to the path entry inspected above; a swap
    // between lstat and open is refused instead of adopted.
    if (!sameIdentity(identityOf(stat), identityOf(link)) || !stat.isFile() || stat.nlink > 1n) {
      return { conflict: { path: context.journalFile, reason: 'journal conflict: the publication journal changed while it was read; inspect it before publishing again.' } };
    }
    if (stat.size > BigInt(MAX_JOURNAL_BYTES)) {
      return { conflict: { path: context.journalFile, reason: `journal conflict: the publication journal exceeds ${MAX_JOURNAL_BYTES} bytes; inspect it before publishing again.` } };
    }
    // The bounded size is converted only after the exact bound is proven.
    const bytes = await readExact(handle, Number(stat.size));
    if (typeof bytes === 'string') {
      return { conflict: { path: context.journalFile, reason: `journal conflict: ${bytes}` } };
    }
    text = bytes.toString('utf8');
  } finally {
    await handle.close();
  }
  context.input.authorize();
  const parsed = parseJournal(text, context);
  return typeof parsed === 'string'
    ? { conflict: { path: context.journalFile, reason: `journal conflict: ${parsed}` } }
    : { journal: parsed };
}

function appliedPaths(journal: Journal): string[] {
  return journal.entries.filter(entry => entry.state === 'applied').map(entry => entry.path);
}

function conflictResult(journal: Journal, conflicts: Conflict[]): IntegrationPublicationResult {
  return { state: 'conflict', applied: appliedPaths(journal), conflicts };
}

/**
 * Awaits the caller's `onJournalReady` exactly once, only after a valid journal
 * is durable and BEFORE any workspace effect. A rejection propagates unchanged,
 * so no effect is ever started without the caller's durable latch.
 */
async function notifyJournalReady(input: IntegrationPublicationInput): Promise<void> {
  const ready = input.onJournalReady;
  if (ready === undefined) {
    return;
  }
  if (typeof ready !== 'function') {
    throw new WorkerError('invalid_publication', 'onJournalReady must be a function when it is supplied.');
  }
  await ready();
}

/** The validated floor; validateRequest() already refused every other value. */
function journalFloor(input: IntegrationPublicationOptions): number {
  const floor = input.minimumJournalRevision;
  return typeof floor === 'number' ? floor : 0;
}

/**
 * Awaits the caller's `onJournalIntent` for one workspace effect, AFTER that
 * entry's durable `intent` record and BEFORE any staged or real effect. The
 * caller persists this revision in its attempt ledger, so it survives a rolled
 * back journal. A rejection propagates unchanged and the durable `intent` is
 * left in place: nothing was staged or written, and the next attempt resolves
 * that intent by proof only instead of repeating it.
 */
async function notifyJournalIntent(input: IntegrationPublicationInput, revision: number): Promise<void> {
  const intent = input.onJournalIntent;
  if (intent === undefined) {
    return;
  }
  if (typeof intent !== 'function') {
    throw new WorkerError('invalid_publication', 'onJournalIntent must be a function when it is supplied.');
  }
  await intent(revision);
}

/**
 * Resolves durable intents by proof only (never by repeating the effect), then
 * applies the entries that are still pending, in canonical path order.
 * `recoveryOnly` stops after the proof step: durable state is resolved and
 * reported, and no fresh journal revision and no workspace effect is started.
 */
async function runPublication(
  context: Context, journal: Journal, fresh: boolean, recoveryOnly: boolean
): Promise<IntegrationPublicationResult> {
  // 0. The pinned root identity is exact and always verified, even when every
  //    entry is already applied: a journal of another root is never trusted.
  if (!fresh) {
    const rootCheck = await verifyAncestors([{ path: context.root, identity: journal.trust.root }]);
    if (rootCheck) {
      return { state: 'conflict', applied: [], conflicts: [{ path: context.journalFile, reason: `journal conflict: the pinned workspace root is not this workspace root (${rootCheck}).` }] };
    }
  }
  // 1. Staging reconciliation and intent resolution, under the pinned ancestor
  //    identities. A row whose state is already terminal (`interrupted`) is
  //    never re-proved and never replayed: only a staging entry its durable
  //    record still describes is proved and removed, at zero new pending effects
  //    - which is what makes cleanup part of proof-only recovery. A row that may
  //    still start an effect (`pending`, including one whose own effect left
  //    debris) and a settled row (`applied`) have their OWN recorded staging
  //    entry reconciled here as well, BEFORE any new staging name is pinned: the
  //    record survives while that exact path still exists.
  const debris: Conflict[] = [];
  for (const entry of [...journal.entries]) {
    const terminal = entry.state === 'interrupted';
    if (entry.state !== 'intent' && entry.stage === undefined) {
      continue;
    }
    context.input.authorize();
    const segments = entry.path.split('/');
    const target = path.join(context.root, ...segments);
    const chain = chainFromTrust(context, journal.trust, segments);
    // 1a. The verified staging entry of this row is reconciled BEFORE its proof: a
    //     creation interrupted between link() and unlink() leaves a second link
    //     to the published inode, which the destination proof below would
    //     otherwise refuse as hard-linked. Only a staging entry whose identity,
    //     bytes, link state, ancestors and editor preconditions are provable is
    //     removed; every unproved or partial record is left alone.
    const reconciled = await reconcileStage(context, entry, chain);
    if (terminal) {
      continue;
    }
    if (entry.state !== 'intent') {
      // A row that may still start an effect, or one that already completed: its
      // destination is never replayed here, and its own staging record is dropped
      // only once that exact path is proved ABSENT. A record that survives - the
      // path still exists, could not be observed, or the pinned ancestors are
      // untrusted - is preserved verbatim and reported as a retryable conflict
      // naming the staging path, so the owner can move an edited file or close the
      // editor. Nothing here can reach a new staging name.
      if (reconciled.state === 'cleared') {
        await writeResolvedState(context, journal, entry.path, entry.state, undefined);
      } else if (reconciled.state !== 'none') {
        const staging = reconciled.state === 'unproved'
          ? reconciled.staging
          : stagingPathOf(context, entry) ?? entry.path;
        debris.push({ path: staging, reason: stageDebrisReason(staging) });
      }
      continue;
    }
    let proof: Proof;
    if (typeof chain === 'string') {
      proof = { done: false, detail: chain };
    } else {
      try {
        proof = await provesApplied(target, entry.after, chain);
      } catch (error) {
        proof = { done: false, detail: message(error) };
      }
    }
    // A resolved intent keeps its staging record unless that exact path is proved
    // absent, so a completion whose stage cleanup was refused still records the
    // owned entry a later recovery may reconcile without replaying anything.
    const cleared = entry.stage === undefined || reconciled.state === 'cleared';
    await writeResolvedState(
      context, journal, entry.path, proof.done ? 'applied' : 'interrupted', cleared ? undefined : entry.stage
    );
    if (proof.done && !cleared) {
      // The destination proves applied while its own stage was NOT cleared. The row
      // is durably `applied` WITH that record, and this call still reports the stage
      // conflict - including this already applied path - so the caller's attempt
      // ledger accepts the result and a later apply re-enters the journal to
      // reconcile that exact staging entry instead of seeing a terminal `applied`.
      const staging = reconciled.state === 'unproved'
        ? reconciled.staging
        : stagingPathOf(context, entry) ?? entry.path;
      debris.push({ path: staging, reason: stageDebrisReason(staging) });
    }
  }
  const conflicts: Conflict[] = [];
  for (const entry of journal.entries) {
    if (entry.state === 'interrupted') {
      conflicts.push({ path: entry.path, reason: INTERRUPTED_REASON });
    }
  }
  if (conflicts.length > 0) {
    return { state: 'interrupted', applied: appliedPaths(journal), conflicts };
  }
  if (debris.length > 0) {
    // A staging entry of a row that may still start an effect was preserved and is
    // never replaced by a fresh staging name. Nothing else starts: the owner moves
    // that file or closes the editor, and the row retries once its recorded path
    // is provably absent.
    return conflictResult(journal, debris);
  }

  if (recoveryOnly) {
    // Proof-only recovery under storage pressure: every durable intent has just
    // been resolved above, and nothing else may start. An intact journal's known
    // applied paths are preserved; outstanding pending work is a retryable
    // structured conflict, never a fresh journal and never an effect.
    const applied = appliedPaths(journal);
    if (journal.entries.every(entry => entry.state === 'applied')) {
      return { state: 'applied', applied, conflicts: [] };
    }
    return { state: 'conflict', applied, conflicts: [{ path: ROOT_SCOPE_PATH, reason: RECOVERY_ONLY_PENDING_REASON }] };
  }

  // 2. Capacity, BEFORE any approved byte is read and before the first effect:
  //    the declared plan must fit the total-byte bound, and the journal must be
  //    able to hold every revision this plan can still produce. Both are
  //    structured refusals that carry the paths already applied, so a caller can
  //    resume safely instead of meeting a throw after a durable intent.
  const declared = journal.entries.reduce(
    (total, entry) => total + (entry.state === 'pending' && entry.after !== null ? entry.after.size : 0), 0
  );
  if (declared > MAX_TOTAL_BYTES) {
    return conflictResult(journal, [{ path: ROOT_SCOPE_PATH, reason: totalCapacityReason(declared) }]);
  }
  const journalBytes = maximumJournalBytes(
    journal.identity, journal.root, fresh ? estimatedTrust(journal.entries) : journal.trust, journal.entries
  );
  if (journalBytes > MAX_JOURNAL_BYTES) {
    return conflictResult(journal, [{ path: context.journalFile, reason: journalCapacityReason(journalBytes) }]);
  }

  // 3. Read-only preflight of every pending entry before the first effect.
  const prepared: Prepared[] = [];
  for (const entry of journal.entries) {
    if (entry.state !== 'pending') {
      continue;
    }
    const change = context.changes.find(candidate => candidate.key === entry.path);
    if (!change) {
      return conflictResult(journal, [{ path: entry.path, reason: 'journal conflict: the pending entry is not part of this publication.' }]);
    }
    const chain = fresh ? undefined : chainFromTrust(context, journal.trust, change.segments);
    if (typeof chain === 'string') {
      conflicts.push({ path: entry.path, reason: chain });
      continue;
    }
    const result = await preflight(context, change, chain);
    if ('reason' in result) {
      conflicts.push(result);
      continue;
    }
    prepared.push(result);
  }
  if (conflicts.length > 0) {
    return conflictResult(journal, conflicts);
  }

  // 4. The complete plan, including every pinned directory identity, is
  //    durable before the first destination changes.
  if (fresh) {
    journal.trust = collectTrust(context, prepared);
    await persistJournal(context, journal, journal.entries.map(entry => ({ ...entry, state: 'pending' as JournalState })), true);
    // The journal is durable BEFORE the caller's latch is persisted and before
    // any effect starts, so an established latch can only ever describe a
    // journal that really existed (see the missing-journal refusal in publish()).
    await notifyJournalReady(context.input);
  }

  // 5. Per-file intent -> effect -> completion.
  for (const item of prepared) {
    if (sameEntry(item.change.before, item.change.after)) {
      const check = await checkDestination(context, item);
      if (!check.ok) {
        conflicts.push({ path: item.change.key, reason: check.reason });
        break;
      }
      await writeState(context, journal, item.change.key, 'applied');
      continue;
    }
    // The staging basename of this effect is generated here and pinned into the
    // durable intent itself, so the exact name a later recovery may consider is
    // never guessed - and a deletion, which stages nothing, pins none.
    item.staging = item.change.after === null ? undefined : stagingName();
    await writeIntent(context, journal, item.change.key, item.staging);
    // The caller's own durable intent checkpoint: awaited AFTER this entry's
    // durable `intent` record and BEFORE any staged or real effect, so the
    // revision it persists is a floor a later rolled-back journal cannot pass.
    // A rejection stops here and leaves the durable `intent` intact - nothing
    // was staged or written, and the next attempt proves that intent instead of
    // repeating it. That revision also covers the pinned staging basename; a
    // rollback that loses the later identity record leaves the staging entry
    // unproved, and an unproved staging entry is never removed.
    await notifyJournalIntent(context.input, journal.revision);
    let outcome: EffectOutcome;
    try {
      outcome = await effect(context, item, stage => writeStageIdentity(context, journal, item.change.key, stage));
    } catch (error) {
      await recordInterrupted(context, journal, item.change.key).catch(() => undefined);
      throw error;
    }
    if (!outcome.ok) {
      // Nothing reached the destination, so this entry is safely retryable. Its
      // staging entry was removed only if that removal was proved; when it was
      // not, the durable record keeps describing it instead of dropping a known
      // owned stage.
      await writeState(context, journal, item.change.key, 'pending', outcome.stageDebris);
      conflicts.push({ path: item.change.key, reason: outcome.reason });
      break;
    }
    await writeState(context, journal, item.change.key, 'applied');
  }
  return conflicts.length > 0
    ? conflictResult(journal, conflicts)
    : { state: 'applied', applied: appliedPaths(journal), conflicts: [] };
}

async function publish(input: IntegrationPublicationInput): Promise<IntegrationPublicationResult> {
  const recoveryOnly = input.recoveryOnly === true;
  const validation = await validateRequest(input);
  if ('result' in validation) {
    return validation.result;
  }
  const context = validation.context;
  const loaded = await loadJournal(context);
  if (loaded.conflict) {
    return { state: 'conflict', applied: [], conflicts: [loaded.conflict] };
  }
  if (loaded.journal) {
    // A validated journal is not automatically the CURRENT one: every check
    // parseJournal() runs is self-consistency, and neither the revision number
    // nor the per-entry state is part of the plan digest. A journal below the
    // caller's durable floor is therefore an earlier revision restored over the
    // current one, whose `pending` entries may already have completed, so this
    // is terminal BEFORE the latch and before any journal or workspace write -
    // in proof-only recovery too.
    const floor = journalFloor(input);
    if (loaded.journal.revision < floor) {
      return {
        state: 'interrupted',
        applied: [],
        conflicts: [{ path: context.journalFile, reason: journalRollbackReason(loaded.journal.revision, floor) }]
      };
    }
    if (!recoveryOnly) {
      // An existing, VALID journal is itself the durable proof, so the caller's
      // latch is persisted here - before any effect this call may still perform.
      await notifyJournalReady(input);
    }
    return runPublication(context, loaded.journal, false, recoveryOnly);
  }
  // No journal exists: either nothing has ever been established for this
  // publication, or an established journal was lost. A positive floor is the
  // caller's own durable evidence that a journal WAS established - it records an
  // intent revision - so it makes the missing journal terminal exactly like
  // requireJournal, without that flag and in proof-only recovery as well.
  if (input.requireJournal === true || journalFloor(input) > 0) {
    // An effect may already have started and its proof is gone. This is
    // terminal: no workspace write, and never a replacement journal, so a lost
    // journal can never re-plan a captured base entry over a later user edit.
    return { state: 'interrupted', applied: [], conflicts: [{ path: context.journalFile, reason: MISSING_JOURNAL_REASON }] };
  }
  if (recoveryOnly) {
    // Nothing durable to resolve and nothing may be started under storage
    // pressure, so this is a retryable conflict rather than a fresh plan.
    return { state: 'conflict', applied: [], conflicts: [{ path: ROOT_SCOPE_PATH, reason: NO_RECOVERY_JOURNAL_REASON }] };
  }
  if (context.changes.length === 0) {
    return { state: 'applied', applied: [], conflicts: [] };
  }
  const journal: Journal = {
    schema: JOURNAL_SCHEMA,
    identity: context.identity,
    root: context.root,
    plan: '',
    revision: 0,
    trust: { root: context.rootIdentity, parents: new Map<string, FileIdentity>() },
    entries: context.changes.map(change => ({ path: change.key, state: 'pending', before: change.before, after: change.after }))
  };
  return runPublication(context, journal, true, false);
}

/**
 * Applies one approved candidate's changes under a durable, proof-only journal.
 * See the module header for the exact guarantees and their limits.
 */
export async function publishIntegration(input: IntegrationPublicationInput): Promise<IntegrationPublicationResult> {
  return publish(input);
}
