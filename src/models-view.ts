import * as vscode from 'vscode';
import { parseModelSettings } from './model-settings';
import { ModelPolicy } from './types';

/**
 * Snapshot of the strict, global (User) codexSubagent.models pool as displayed
 * by the Models view. Pool entry order is the automatic-selection priority.
 * Pure so it can be tested without a VS Code window.
 */
export interface ModelsPoolSnapshot {
  /** Enabled model IDs in configured insertion/priority order. */
  modelIds: string[];
  policies: Record<string, ModelPolicy>;
  /** Message from the strict parser when the setting is malformed; undefined otherwise. */
  error?: string;
  /** No models enabled and no parse error: the actionable empty state. */
  empty: boolean;
}

export function snapshotPool(raw: unknown, fail: (message: string) => string = message => message): ModelsPoolSnapshot {
  try {
    const policies = parseModelSettings(raw);
    const modelIds = Object.keys(policies);
    return { modelIds, policies, empty: !modelIds.length };
  } catch (error) {
    return { modelIds: [], policies: {}, error: fail(error instanceof Error ? error.message : String(error)), empty: false };
  }
}

/** One human-readable policy field, with its built-in default flagged. */
export interface ModelPolicyField {
  key: string;
  label: string;
  value: string;
  detail?: string;
  /** True when the displayed value comes from a built-in default, not the setting. */
  effective: boolean;
}

/** Display values mirror the runtime behavior: permission flags default true when omitted, limits 1/40/600/true. */
export function modelPolicyFields(policy: ModelPolicy): ModelPolicyField[] {
  return [
    { key: 'allowWrite', label: 'allowWrite', value: String(policy.allowWrite !== false), detail: 'Omitted defaults to true; false blocks workspace-write workers for this model', effective: policy.allowWrite === undefined },
    { key: 'allowShell', label: 'allowShell', value: String(policy.allowShell !== false), detail: 'Omitted defaults to true; shell is only offered to workspace-write workers (allowWrite required) and still needs approval', effective: policy.allowShell === undefined },
    { key: 'numSessions', label: 'numSessions', value: String(policy.numSessions ?? 1), detail: 'Maximum simultaneously active conversations; built-in default 1', effective: policy.numSessions === undefined },
    { key: 'maxToolRounds', label: 'maxToolRounds', value: String(policy.maxToolRounds ?? 40), detail: 'Tool rounds per turn before manual resumption; built-in default 40', effective: policy.maxToolRounds === undefined },
    { key: 'turnTimeoutSeconds', label: 'turnTimeoutSeconds', value: String(policy.turnTimeoutSeconds ?? 600), detail: 'Deadline per turn including tool execution; built-in default 600', effective: policy.turnTimeoutSeconds === undefined },
    { key: 'autoCompact', label: 'autoCompact', value: String(policy.autoCompact !== false), detail: 'Automatic summarization before limits; built-in default true', effective: policy.autoCompact === undefined },
    { key: 'modelOptions', label: 'modelOptions', value: policy.modelOptions && Object.keys(policy.modelOptions).length ? 'configured' : 'none', detail: 'Provider-specific request options passed to sendRequest for this exact model', effective: false }
  ];
}

interface ModelEntryNode { kind: 'model'; id: string; name: string; policy: ModelPolicy }
interface FieldNode { kind: 'field'; modelId: string; field: ModelPolicyField }
interface OptionNode { kind: 'option'; modelId: string; key: string; value: unknown }
interface StatusNode { kind: 'status'; text: string; detail?: string }
type ModelNode = ModelEntryNode | FieldNode | OptionNode | StatusNode;

/** One-line compact value used as the tree description preview. */
function optionPreview(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > 80 ? text.slice(0, 77) + '...' : text;
}

/** Full formatted value (nested JSON stays multiline) used as the tooltip. */
function optionValue(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : (JSON.stringify(value) ?? 'undefined');
}

/**
 * Native tree over the User-settings model pool. It only reads the strict
 * global configuration value, so it works without a worker host, broker, or a
 * trusted filesystem workspace. A malformed pool is surfaced as a visible
 * error with recovery access instead of failing activation.
 */
export class ModelsTree implements vscode.TreeDataProvider<ModelNode> {
  private readonly change = new vscode.EventEmitter<ModelNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.change.event;
  private snapshot: ModelsPoolSnapshot = { modelIds: [], policies: {}, empty: true };

  /** Latest parsed pool snapshot (also used to drive the view's empty context). */
  get pool(): ModelsPoolSnapshot {
    return this.snapshot;
  }

  /** Re-read the User-level pool and notify the view. */
  refresh(): void {
    const raw = vscode.workspace.getConfiguration('codexSubagent').inspect<unknown>('models')?.globalValue;
    this.snapshot = snapshotPool(raw, error => error);
    this.change.fire();
  }

  getTreeItem(node: ModelNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.kind === 'model' ? node.name : node.kind === 'status' ? node.text : node.kind === 'field' ? node.field.label : node.key);
    if (node.kind === 'model') {
      item.id = `model:${node.id}`;
      item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      item.contextValue = 'modelEntry';
      // The display label is the VS Code model name; the exact configured ID
      // stays the stable identity and command argument, shown in the tooltip.
      item.tooltip = `Enabled worker model (exact ID)\n${node.id}`;
      item.iconPath = new vscode.ThemeIcon('brain');
      item.command = { command: 'codexSubagent.configureModel', title: 'Configure Model Options', arguments: [node.id] };
    } else if (node.kind === 'field') {
      item.id = `field:${node.modelId}:${node.field.key}`;
      item.description = node.field.effective ? `default ${node.field.value}` : node.field.value;
      item.tooltip = [
        `${node.field.label}: ${node.field.value}${node.field.effective ? ' (built-in default, not set in codexSubagent.models)' : ''}`,
        node.field.detail
      ].filter(Boolean).join('\n');
      item.iconPath = new vscode.ThemeIcon('symbol-constant');
    } else if (node.kind === 'option') {
      item.id = `option:${node.modelId}:${node.key}`;
      item.description = optionPreview(node.value);
      item.tooltip = optionValue(node.value);
      item.iconPath = new vscode.ThemeIcon('symbol-object');
    } else {
      item.id = 'status:invalid';
      item.tooltip = [node.text, node.detail].filter(Boolean).join('\n');
      item.iconPath = new vscode.ThemeIcon('warning');
      item.command = { command: 'codexSubagent.openModelSettings', title: 'Open Model Settings' };
    }
    return item;
  }

  /**
   * Display names come from the VS Code model catalog (metadata only, exact-ID
   * match). A missing catalog entry or a failed query must never hide a
   * configured model: such entries fall back to a neutral label.
   */
  private async modelNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
      for (const model of await vscode.lm.selectChatModels()) {
        names.set(model.id, model.name);
      }
    } catch {
      // Metadata is a display concern; the configured pool stays visible.
    }
    return names;
  }

  async getChildren(node?: ModelNode): Promise<ModelNode[]> {
    if (!node) {
      if (this.snapshot.error) {
        return [{ kind: 'status', text: 'Model settings are invalid', detail: `${this.snapshot.error}\nFix codexSubagent.models in User Settings to enable models.` }];
      }
      const names = await this.modelNames();
      // Pool order (configuration insertion order) is the priority, not the
      // catalog order selectChatModels resolves to.
      return this.snapshot.modelIds.map(id => ({ kind: 'model', id, name: names.get(id) || 'Unavailable model', policy: this.snapshot.policies[id] || {} }));
    }
    if (node.kind === 'model') {
      const fields: ModelNode[] = modelPolicyFields(node.policy).map(field => ({ kind: 'field', modelId: node.id, field }));
      const options: ModelNode[] = node.policy.modelOptions
        ? Object.entries(node.policy.modelOptions).map(([key, value]) => ({ kind: 'option', modelId: node.id, key, value }))
        : [];
      return [...fields, ...options];
    }
    return [];
  }

  dispose(): void {
    this.change.dispose();
  }
}
