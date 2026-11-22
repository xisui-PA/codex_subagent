import * as vscode from 'vscode';
import type { BoardTaskSummary, BoardTeamSummary, BoardWorkspaceStatus } from './task-board-summary';

export type { BoardTaskSummary, BoardTeamSummary, BoardWorkspaceStatus } from './task-board-summary';

/**
 * Read-only native tree over bounded board summaries.
 *
 * A status row carries previews and totals, never full records: text is clipped,
 * detail lists are samples, and transition entries and reference URIs live in the
 * record behind `codexSubagent.openBoardRecord`. Every row says so instead of
 * implying it shows everything. The view never mutates the board, so it offers no
 * create, accept or integrate action.
 */

/** Flat display node; children are prebuilt so tree identity and content stay deterministic. */
export interface BoardNode {
  kind: 'workspace' | 'team' | 'task' | 'section' | 'leaf' | 'error' | 'empty';
  /** Stable canonical path, independent of labels, assignees and revisions. */
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  command?: vscode.Command;
  children?: BoardNode[];
}

const FULL_RECORD = 'Open the task record for full text, all lists, transition entries and reference URIs.';
const boardPath = (workspaceRoot: string): string => `board:${workspaceRoot}`;
const taskPath = (workspaceRoot: string, task: BoardTaskSummary): string =>
  `${boardPath(workspaceRoot)}/team:${task.teamId}/task:${task.id}`;

/** Literal single-line preview of an already-bounded summary value. */
const preview = (text: string, max = 120): string => text.length > max ? `${text.slice(0, max - 3)}...` : text;
/** `shown of total` for a sampled detail list. */
const shown = (visible: number, total: number): string => `${visible} of ${total}`;

const assigneeText = (task: BoardTaskSummary): string =>
  task.assigneeWorkerId ? `worker ${task.assigneeWorkerId}` : 'unassigned';

/**
 * Visible state text. Submitted/validating stay pending coordinator acceptance;
 * accepted shows only the board acceptance state, never an integration outcome.
 */
function stateText(state: BoardTaskSummary['state']): string {
  if (state === 'submitted' || state === 'validating') {
    return `${state} - awaiting coordinator acceptance`;
  }
  return state;
}

const stateIcons: Record<BoardTaskSummary['state'], string> = {
  ready: 'circle-outline', in_progress: 'sync', submitted: 'mail', validating: 'beaker',
  accepted: 'pass', failed: 'error', cancelled: 'circle-slash'
};

/** Rows that hold children: workspaces and teams open like the workers tree, details stay folded. */
const expanded = (kind: BoardNode['kind']): boolean => kind === 'workspace' || kind === 'team';

/** Actionable guidance row; the view stays read-only, so it only explains where data comes from. */
const emptyRow = (id: string, label: string, tooltip: string): BoardNode =>
  ({ kind: 'empty', id, label, description: 'Read-only view', tooltip, icon: 'info' });

function teamNode(workspaceRoot: string, team: BoardTeamSummary, tasks: BoardTaskSummary[]): BoardNode {
  const path = `${boardPath(workspaceRoot)}/team:${team.id}`;
  return {
    kind: 'team',
    id: path,
    label: team.namePreview,
    description: `rev ${team.revision} - ${tasks.length} task(s)`,
    tooltip: [
      `Team ${team.namePreview}`, `id ${team.id}`, `workspace ${team.workspaceRoot}`,
      `revision ${team.revision}`, `coordinator ${team.coordinatorOwnerId}`,
      `members ${team.memberWorkerIds.length}`, team.descriptionPreview
    ].filter(Boolean).join('\n'),
    icon: 'organization',
    children: tasks.length
      ? tasks.map(task => taskNode(workspaceRoot, task))
      : [emptyRow(`${path}/empty`, 'No tasks in this team yet', 'Tasks appear here once the coordinator creates them for this team.')]
  };
}

function taskNode(workspaceRoot: string, task: BoardTaskSummary): BoardNode {
  return {
    kind: 'task',
    id: taskPath(workspaceRoot, task),
    label: task.titlePreview,
    description: `${stateText(task.state)} - rev ${task.revision} - ${assigneeText(task)}`,
    tooltip: [
      task.titlePreview, `id ${task.id}`, `team ${task.teamId}`, `state ${stateText(task.state)}`,
      `revision ${task.revision}`, `assignee ${assigneeText(task)}`, task.descriptionPreview,
      task.truncated ? 'Some previews are shortened.' : undefined, FULL_RECORD
    ].filter(Boolean).join('\n'),
    icon: stateIcons[task.state],
    command: {
      command: 'codexSubagent.openBoardRecord',
      title: 'Open Board Record',
      arguments: [{ workspaceRoot, teamId: task.teamId, taskId: task.id }]
    },
    children: taskDetails(workspaceRoot, task)
  };
}

/**
 * Detail leaves from the summary only. Each sampled section reports how many
 * entries are shown out of the true total, so a shortened list is never mistaken
 * for the whole record; tooltips point at the record for the rest.
 */
function taskDetails(workspaceRoot: string, task: BoardTaskSummary): BoardNode[] {
  const base = taskPath(workspaceRoot, task);
  const leaf = (key: string, label: string, description?: string, tooltip?: string, icon = 'symbol-field'): BoardNode =>
    ({ kind: 'leaf', id: `${base}/${key}`, label, description, tooltip, icon });
  const section = (key: string, label: string, children: BoardNode[], tooltip?: string): BoardNode =>
    ({ kind: 'section', id: `${base}/${key}`, label, description: String(children.length), tooltip: tooltip ?? `${label}: ${children.length}`, icon: 'list-unordered', children });
  const nodes: BoardNode[] = [];

  if (task.criteriaCount) {
    nodes.push(section('criteria', 'Acceptance criteria', task.acceptanceCriteria.map((text, index) =>
      leaf(`criteria:${index}`, `Criterion ${index + 1}`, text, `${text}\nPreview; ${FULL_RECORD}`)),
    `${shown(task.acceptanceCriteria.length, task.criteriaCount)} shown (${task.criteriaCount} total). ${FULL_RECORD}`));
  }
  if (task.dependencies.length) {
    nodes.push(section('deps', 'Dependencies', task.dependencies.map((dep, index) =>
      leaf(`deps:${index}`, `Task ${dep.taskId}`, dep.kind, `Dependency kind: ${dep.kind}\nTask: ${dep.taskId}`)),
    `All ${task.dependencies.length} dependency edge(s), with exact task ids.`));
  }
  if (task.progressPreview) {
    nodes.push(leaf('progress', 'Progress', preview(task.progressPreview), `${task.progressPreview}\nPreview; ${FULL_RECORD}`, 'pulse'));
  }
  if (task.blockersCount) {
    nodes.push(section('blockers', 'Blockers', task.blockers.map((text, index) =>
      leaf(`blockers:${index}`, `Blocker ${index + 1}`, text, `${text}\nPreview; ${FULL_RECORD}`, 'stop')),
    `${shown(task.blockers.length, task.blockersCount)} shown (${task.blockersCount} total). ${FULL_RECORD}`));
  }
  if (task.candidatesCount) {
    nodes.push(section('candidates', 'Candidates', task.candidates.map((ref, index) =>
      leaf(`candidates:${index}`, `Candidate ${ref.id}`, `v${ref.version}`, [`Candidate ${ref.id} version ${ref.version}`, ref.labelPreview, FULL_RECORD].filter(Boolean).join('\n'))),
    `${shown(task.candidates.length, task.candidatesCount)} shown (${task.candidatesCount} total), newest last; reference URIs are in the record.`));
  }
  if (task.contractsCount) {
    nodes.push(section('contracts', 'Agreed contracts', task.agreedContracts.map((ref, index) =>
      leaf(`contracts:${index}`, `Contract ${ref.id}`, `v${ref.version}`, [`Contract ${ref.id} version ${ref.version}`, ref.labelPreview, FULL_RECORD].filter(Boolean).join('\n'))),
    `${shown(task.agreedContracts.length, task.contractsCount)} shown (${task.contractsCount} total), newest last; reference URIs are in the record.`));
  }
  if (task.validationsCount) {
    nodes.push(section('validations', 'Validations', task.validations.map((entry, index) =>
      leaf(`validations:${index}`, `Validation ${index + 1}`, `${entry.artifactId} v${entry.candidateVersion} ${entry.outcome}`, [
        `Artifact ${entry.artifactId} at exact candidate version ${entry.candidateVersion}: ${entry.outcome}`,
        entry.notePreview, `at ${entry.at}`,
        entry.resultRef ? `result ${entry.resultRef.id} v${entry.resultRef.version}` : undefined,
        FULL_RECORD
      ].filter(Boolean).join('\n'), entry.outcome === 'passed' ? 'pass' : 'error')),
    `${shown(task.validations.length, task.validationsCount)} shown (${task.validationsCount} total), newest last. ${FULL_RECORD}`));
  }

  const history = task.history;
  if (history.retained || history.trimmed || history.lastSequence) {
    const rows: BoardNode[] = [leaf('history:retained', 'Entries retained', String(history.retained),
      `${history.retained} transition entries are retained in the record. ${FULL_RECORD}`)];
    if (history.trimmed) {
      rows.push(leaf('history:trimmed', 'Trimmed entries', String(history.trimmed), 'Older transitions were removed by the board history limit.'));
    }
    if (history.lastSequence) {
      rows.push(leaf('history:seq', 'Last sequence', String(history.lastSequence)));
    }
    nodes.push(section('history', 'History', rows, 'Transition entries stay in the record; the summary carries counts only.'));
  }

  if (task.truncated) {
    nodes.push(leaf('truncated', 'Some previews are shortened',
      'Open the record for full text and complete lists.', `This row carries previews and counts only. ${FULL_RECORD}`, 'info'));
  }
  if (!nodes.length) {
    nodes.push(leaf('empty', 'No details recorded', 'No criteria, dependencies, progress, blockers, candidates, contracts or validations yet.'));
  }
  return nodes;
}

function workspaceNode(status: BoardWorkspaceStatus): BoardNode {
  const base = boardPath(status.workspaceRoot);
  const children: BoardNode[] = [];
  if (status.error) {
    children.push({
      kind: 'error', id: `${base}/error`, label: 'Could not read the task board',
      description: preview(status.error, 160), tooltip: status.error, icon: 'warning'
    });
  }
  for (const team of status.teams) {
    children.push(teamNode(status.workspaceRoot, team, status.tasks.filter(task => task.teamId === team.id)));
  }
  const orphans = status.tasks.filter(task => !status.teams.some(team => team.id === task.teamId));
  if (orphans.length) {
    children.push({
      kind: 'team', id: `${base}/orphan-tasks`, label: 'Tasks without a team in this snapshot',
      description: `${orphans.length} task(s)`,
      tooltip: 'These tasks reference a team id that is not present in this snapshot; they stay visible so no task is hidden.',
      icon: 'warning',
      children: orphans.map(task => taskNode(status.workspaceRoot, task))
    });
  }
  if (!children.length) {
    children.push(emptyRow(`${base}/empty`, 'No teams or tasks on this board yet',
      'Teams and tasks appear here once the coordinator creates them. This view only displays host snapshots and sends no changes.'));
  }
  return {
    kind: 'workspace',
    id: base,
    label: status.workspaceRoot,
    description: `${status.teams.length} team(s) - ${status.tasks.length} task(s)`,
    tooltip: [`Workspace ${status.workspaceRoot}`, `teams ${status.teams.length}`, `tasks ${status.tasks.length}`,
      'Read-only: changes are made by the coordinator, not this view.'].join('\n'),
    icon: 'folder',
    children
  };
}

/** Shown when the host has reported no board snapshots at all. */
const emptyBoardNode: BoardNode = {
  ...emptyRow('board:none', 'No task board workspaces yet',
    'A board appears here once the host reports a workspace snapshot with teams and tasks. This view only displays snapshots.'),
  children: []
};

/**
 * Native tree over read-only board summaries. It never mutates the board: it
 * only groups teams and tasks and exposes their bounded details.
 */
export class TaskBoardTree implements vscode.TreeDataProvider<BoardNode> {
  private readonly change = new vscode.EventEmitter<BoardNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.change.event;
  private statuses: readonly BoardWorkspaceStatus[] = [];

  /** Adopt host summaries; only the outer arrays are copied, rows stay read-only by contract. */
  refresh(statuses: readonly BoardWorkspaceStatus[] = []): void {
    this.statuses = statuses.map(status => ({
      workspaceRoot: status.workspaceRoot, teams: [...status.teams], tasks: [...status.tasks], error: status.error
    }));
    this.change.fire();
  }

  getTreeItem(node: BoardNode): vscode.TreeItem {
    const collapsible = node.children?.length
      ? (expanded(node.kind) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, collapsible);
    item.id = node.id;
    if (node.description) {
      item.description = node.description;
    }
    item.tooltip = node.tooltip ?? node.label;
    if (node.icon) {
      item.iconPath = new vscode.ThemeIcon(node.icon);
    }
    if (node.command) {
      item.command = node.command;
    }
    if (node.kind === 'task') {
      item.contextValue = 'boardTask';
    }
    return item;
  }

  async getChildren(node?: BoardNode): Promise<BoardNode[]> {
    if (node) {
      return node.children ?? [];
    }
    return this.statuses.length ? this.statuses.map(workspaceNode) : [emptyBoardNode];
  }

  dispose(): void {
    this.change.dispose();
  }
}
