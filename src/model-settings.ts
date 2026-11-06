import { z } from 'zod';
import { ModelPolicy, Settings, WorkerError } from './types';

const policySchema = z.object({
  allowWrite: z.boolean().optional(),
  allowShell: z.boolean().optional(),
  numSessions: z.number().int().min(1).max(8).optional(),
  maxToolRounds: z.number().int().min(1).max(200).optional(),
  turnTimeoutSeconds: z.number().int().min(10).max(3600).optional(),
  autoCompact: z.boolean().optional()
}).strict();

const maxModelIdLength = 500;

const reject = (detail: string): never => {
  throw new WorkerError('invalid_settings', `codexSubagent.models is invalid: ${detail}.`);
};
const key = (issue: z.core.$ZodIssue): string => `${issue.path.join('.') || '(root)'}`;

export function parseModelSettings(raw: unknown): Record<string, ModelPolicy> {
  if (raw === undefined) {
    return {};
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    reject('must be an object keyed by exact model ID');
  }
  const source = raw as Record<string, unknown>;
  const entries: [string, ModelPolicy][] = [];
  for (const [id, value] of Object.entries(source)) {
    if (id.length === 0 || id.length > maxModelIdLength) {
      reject(`model ID ${JSON.stringify(id)} must be nonempty and at most ${maxModelIdLength} characters`);
    }
    const parsed = policySchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new WorkerError('invalid_settings', `codexSubagent.models is invalid: ${id}: ${issue.message} ${key(issue)}.`);
    }
    entries.push([id, parsed.data]);
  }
  // Object.fromEntries defines own properties, so an exact ID such as '__proto__' is preserved.
  return Object.fromEntries(entries);
}

export interface EligibleModel { id: string; name: string; policy?: ModelPolicy }
export interface EligibleModelSet {
  /** Selectable models in configured pool order (or enabled order for a legacy empty pool). */
  models: EligibleModel[];
  /** Pre-selection: the previous model when still eligible, otherwise the first eligible model. */
  preferred?: string;
  /** Guidance when no model is eligible; undefined when at least one is offered. */
  guidance?: string;
}
export interface EligibleModelInput {
  permission: 'read-only' | 'workspace-write';
  /** Models exposed and enabled by VS Code, as returned by subagent_models. */
  available: readonly { id: string; name: string }[];
  pool?: Record<string, ModelPolicy> | undefined;
  /** Previously pinned model ID whose replacement must be offered explicitly. */
  previous?: string;
}

/**
 * Every surface that offers a model (New Worker, Resume Worker, panel dropdown)
 * must offer exactly the configured pool in priority order, minus models that
 * cannot honour the session permission. An empty legacy pool falls back to the
 * enabled model list. Pure so it is testable without VS Code.
 */
export function eligibleModels(input: EligibleModelInput): EligibleModelSet {
  const entries = Object.entries(input.pool || {});
  const models: EligibleModel[] = [];
  const missing: string[] = [];
  let restricted = 0;
  if (entries.length === 0) {
    for (const model of input.available) {
      models.push({ id: model.id, name: model.name });
    }
  } else {
    for (const [id, policy] of entries) {
      const model = input.available.find(candidate => candidate.id === id);
      if (!model) {
        missing.push(id);
        continue;
      }
      if (input.permission === 'workspace-write' && policy.allowWrite === false) {
        restricted++;
        continue;
      }
      models.push({ id: model.id, name: model.name, policy });
    }
  }
  const preferred = models.find(model => model.id === input.previous)?.id ?? models[0]?.id;
  return { models, preferred, guidance: models.length ? undefined : eligibilityGuidance(input, entries.length, missing, restricted) };
}

function eligibilityGuidance(input: EligibleModelInput, configured: number, missing: string[], restricted: number): string {
  if (!input.available.length) {
    return 'No worker models are enabled. Run Codex Subagent: Enable Model and choose a tool-capable model.';
  }
  if (!configured) {
    return 'No enabled worker model is available. Run Codex Subagent: Enable Model, then retry.';
  }
  if (missing.length && missing.length === configured) {
    return `None of the configured codexSubagent.models IDs is an enabled VS Code model (${missing.join(', ')}). Run Codex Subagent: Enable Model for an exact ID or correct codexSubagent.models in User Settings.`;
  }
  if (restricted) {
    return `No configured model allows workspace-write. Set allowWrite: true for a configured model and enable codexSubagent.allowWrites, or start read-only work. Otherwise update codexSubagent.models in User Settings.`;
  }
  return 'No eligible worker model is configured. Review codexSubagent.models in User Settings, then retry.';
}

export function effectiveSettings(base: Settings, modelId: string): Settings {
  const entry = base.models?.[modelId];
  if (!entry) {
    return base;
  }
  // Only present per-model fields override; omitted fields inherit the global settings.
  // Permission flags are enforced separately by the workspace tools, not by Settings.
  const overlay: Partial<Settings> = {};
  if (entry.numSessions !== undefined) {
    overlay.maxConcurrent = entry.numSessions;
  }
  if (entry.maxToolRounds !== undefined) {
    overlay.maxToolRounds = entry.maxToolRounds;
  }
  if (entry.turnTimeoutSeconds !== undefined) {
    overlay.turnTimeoutMs = entry.turnTimeoutSeconds * 1000;
  }
  if (entry.autoCompact !== undefined) {
    overlay.autoCompact = entry.autoCompact;
  }
  return { ...base, ...overlay };
}
