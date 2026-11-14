import type { BoardTask, TaskState, Team } from './task-board-types';

/**
 * Bounded, explicitly partial projections of board records. The tree and the
 * internal UI snapshot only ever see these summaries, so a response stays well
 * inside the bridge limit even at the declared board capacity.
 *
 * Budget note: the bridge transmits a ToolResult whose text is itself a JSON
 * string, so every character is serialized twice. A control character costs six
 * characters in the inner JSON and seven in the envelope; a backslash costs
 * four. Caps below are sized for that worst case across 512 tasks, not just for
 * ordinary text.
 *
 * Field names ending in `Preview` are clipped, and `<list>Count` records the
 * untruncated total, so nothing claims to be complete. Versioned reference and
 * verdict lists keep their newest entries (the tail), because they are
 * append-only and a stale first page would hide the latest candidate version. Identifiers are never
 * clipped: task/team ids, dependency edges and assignments stay exact, while
 * reference ids keep their full domain-bounded value and only their labels and
 * validation notes are previewed. Anything omitted here (reference URIs, full
 * text, transition entries) lives in the record behind
 * `codexSubagent.openBoardRecord`. Nothing verifies artifact contents or grants
 * file access.
 */

/** Declared preview sizes and per-list detail counts; totals are reported as counts. */
export const summaryLimits = {
  title: 60, description: 60, progress: 60,
  criteriaPreview: 50, criteria: 2,
  blockerPreview: 50, blockers: 2,
  labelPreview: 30, refs: 2,
  notePreview: 30, validations: 2,
  teamName: 80, teamDescription: 80
} as const;

/** Versioned reference without its URI, so a summary can never imply file access. */
export interface BoardRefSummary {
  /** Exact reference id (domain-bounded to 64 characters); never clipped. */
  id: string;
  version: number;
  /** Clipped label; the full label is in the record. */
  labelPreview?: string;
}

/** Metadata-only validation verdict tied to an exact candidate version. */
export interface BoardValidationSummary {
  /** Exact artifact id; never clipped. */
  artifactId: string;
  candidateVersion: number;
  outcome: 'passed' | 'failed';
  /** Clipped note; the full note is in the record. */
  notePreview?: string;
  at: string;
  /** Result reference ids and version only; its URI stays in the full record. */
  resultRef?: { id: string; version: number };
}

/** Bounded transition metadata; the entries themselves stay in the full record. */
export interface BoardHistorySummary {
  retained: number;
  lastSequence: number;
  trimmed: number;
}

export interface BoardTeamSummary {
  id: string;
  namePreview: string;
  workspaceRoot: string;
  coordinatorOwnerId: string;
  memberWorkerIds: string[];
  revision: number;
  descriptionPreview?: string;
}

export interface BoardTaskSummary {
  id: string;
  teamId: string;
  titlePreview: string;
  state: TaskState;
  assigneeWorkerId: string | null;
  revision: number;
  descriptionPreview?: string;
  progressPreview?: string;
  /** First few criteria, clipped; `criteriaCount` is the real total. */
  acceptanceCriteria: string[];
  criteriaCount: number;
  /** Every edge, with the exact task ids and kind: dependencies are never truncated. */
  dependencies: { taskId: string; kind: 'contract' | 'artifact' }[];
  blockers: string[];
  blockersCount: number;
  /** Newest references, clipped labels; `candidatesCount` is the real total. */
  candidates: BoardRefSummary[];
  candidatesCount: number;
  agreedContracts: BoardRefSummary[];
  contractsCount: number;
  /** Newest verdicts, so the latest version is always visible; count is the total. */
  validations: BoardValidationSummary[];
  validationsCount: number;
  history: BoardHistorySummary;
  /** True when any text was clipped or any detail list was shortened. */
  truncated: boolean;
}

/** One workspace's read-only board status; teams and tasks are summaries. */
export interface BoardWorkspaceStatus {
  workspaceRoot: string;
  teams: BoardTeamSummary[];
  tasks: BoardTaskSummary[];
  error?: string;
}

/** Full records a host may project; structural, so this module imports types only. */
export interface BoardSnapshot {
  workspaceRoot: string;
  teams: Team[];
  tasks: BoardTask[];
  error?: string;
}

const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max - 3)}...` : text;
const over = (text: string, max: number): boolean => text.length > max;
const kept = <T>(list: readonly T[], max: number): T[] => list.slice(0, max);
/**
 * Versioned lists are append-only, so the newest entries are the LAST ones.
 * Keeping the tail means a summary never hides the latest candidate version or
 * the latest verdict behind older ones; relative order is preserved.
 */
const tail = <T>(list: readonly T[], max: number): T[] => list.slice(Math.max(0, list.length - max));

function summarizeRef(ref: { id: string; version: number; label?: string }): BoardRefSummary {
  return {
    id: ref.id,
    version: ref.version,
    ...(ref.label ? { labelPreview: clip(ref.label, summaryLimits.labelPreview) } : {})
  };
}

function summarizeValidation(entry: BoardTask['validations'][number]): BoardValidationSummary {
  // Ids and version stay exact; the URI is never part of a summary.
  const resultRef = entry.resultRef ? { id: entry.resultRef.id, version: entry.resultRef.version } : undefined;
  return {
    artifactId: entry.artifactId,
    candidateVersion: entry.candidateVersion,
    outcome: entry.outcome,
    ...(entry.note ? { notePreview: clip(entry.note, summaryLimits.notePreview) } : {}),
    at: entry.at,
    ...(resultRef ? { resultRef } : {})
  };
}

function summarizeTask(task: BoardTask): BoardTaskSummary {
  const criteria = kept(task.acceptanceCriteria, summaryLimits.criteria).map(text => clip(text, summaryLimits.criteriaPreview));
  const blockers = kept(task.blockers, summaryLimits.blockers).map(text => clip(text, summaryLimits.blockerPreview));
  const candidates = tail(task.candidates, summaryLimits.refs).map(summarizeRef);
  const contracts = tail(task.agreedContracts, summaryLimits.refs).map(summarizeRef);
  const validations = tail(task.validations, summaryLimits.validations).map(summarizeValidation);
  const truncated =
    over(task.title, summaryLimits.title) ||
    over(task.description, summaryLimits.description) ||
    over(task.progress, summaryLimits.progress) ||
    criteria.length < task.acceptanceCriteria.length ||
    blockers.length < task.blockers.length ||
    candidates.length < task.candidates.length ||
    contracts.length < task.agreedContracts.length ||
    validations.length < task.validations.length ||
    task.acceptanceCriteria.some(text => over(text, summaryLimits.criteriaPreview)) ||
    task.blockers.some(text => over(text, summaryLimits.blockerPreview)) ||
    task.candidates.some(ref => ref.label ? over(ref.label, summaryLimits.labelPreview) : false) ||
    task.agreedContracts.some(ref => ref.label ? over(ref.label, summaryLimits.labelPreview) : false) ||
    task.validations.some(entry => entry.note ? over(entry.note, summaryLimits.notePreview) : false);
  return {
    id: task.id,
    teamId: task.teamId,
    titlePreview: clip(task.title, summaryLimits.title),
    state: task.state,
    assigneeWorkerId: task.assigneeWorkerId,
    revision: task.revision,
    ...(task.description ? { descriptionPreview: clip(task.description, summaryLimits.description) } : {}),
    ...(task.progress ? { progressPreview: clip(task.progress, summaryLimits.progress) } : {}),
    acceptanceCriteria: criteria,
    criteriaCount: task.acceptanceCriteria.length,
    dependencies: task.dependencies.map(dep => ({ taskId: dep.taskId, kind: dep.kind })),
    blockers,
    blockersCount: task.blockers.length,
    candidates,
    candidatesCount: task.candidates.length,
    agreedContracts: contracts,
    contractsCount: task.agreedContracts.length,
    validations,
    validationsCount: task.validations.length,
    history: {
      retained: task.history.entries.length,
      lastSequence: task.history.lastSequence,
      trimmed: task.history.trimmed
    },
    truncated
  };
}

function summarizeTeam(team: Team): BoardTeamSummary {
  return {
    id: team.id,
    namePreview: clip(team.name, summaryLimits.teamName),
    workspaceRoot: team.workspaceRoot,
    coordinatorOwnerId: team.coordinatorOwnerId,
    memberWorkerIds: [...team.memberWorkerIds],
    revision: team.revision,
    ...(team.description ? { descriptionPreview: clip(team.description, summaryLimits.teamDescription) } : {})
  };
}

/**
 * Project one host snapshot into bounded summaries. Pure: the input records are
 * read only, so callers keep whatever full records they own.
 */
export function summarizeBoard(snapshot: BoardSnapshot): BoardWorkspaceStatus {
  return {
    workspaceRoot: snapshot.workspaceRoot,
    teams: snapshot.teams.map(summarizeTeam),
    tasks: snapshot.tasks.map(summarizeTask),
    error: snapshot.error
  };
}
