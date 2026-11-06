import { z } from 'zod';
import { ModelPolicy, Settings, WorkerError } from './types';

const policySchema = z.object({
  allowWrite: z.boolean().optional(),
  allowShell: z.boolean().optional(),
  numSessions: z.number().int().min(1).max(8).optional(),
  maxToolRounds: z.number().int().min(1).max(200).optional(),
  turnTimeoutSeconds: z.number().int().min(10).max(3600).optional(),
  autoCompact: z.boolean().optional(),
  // Provider-specific request options for this exact model. Arbitrary nested
  // provider JSON is allowed, but the value itself must be an object map.
  modelOptions: z.record(z.string(), z.unknown()).optional()
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
  /** Selectable models in configured pool order (pool keys are the enabled models). */
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
 * cannot honour the session permission. The pool keys are themselves the
 * enabled models, so an empty pool offers nothing for ANY permission; Enable
 * Model adds the exact ID to the setting. Pure, so it is testable without VS Code.
 */
export function eligibleModels(input: EligibleModelInput): EligibleModelSet {
  const entries = Object.entries(input.pool || {});
  const models: EligibleModel[] = [];
  const missing: string[] = [];
  let restricted = 0;
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
  const preferred = models.find(model => model.id === input.previous)?.id ?? models[0]?.id;
  return { models, preferred, guidance: models.length ? undefined : eligibilityGuidance(input, entries.length, missing, restricted) };
}

function eligibilityGuidance(input: EligibleModelInput, configured: number, missing: string[], restricted: number): string {
  if (!input.available.length) {
    return 'No worker models are enabled. Run Codex Subagent: Enable Model and choose a tool-capable model.';
  }
  if (input.permission === 'workspace-write' && !configured) {
    return 'No model is configured in codexSubagent.models, so workspace-write is unavailable. Run Codex Subagent: Enable Model (this adds the exact model ID to codexSubagent.models in User Settings) and leave allowWrite true (or omit it); note that an empty pool also leaves no model available for read-only work.';
  }
  if (!configured) {
    return 'No worker model is enabled. Run Codex Subagent: Enable Model, which adds the exact model ID to codexSubagent.models in User Settings, then retry.';
  }
  if (missing.length && missing.length === configured) {
    return `None of the configured codexSubagent.models IDs is an enabled VS Code model (${missing.join(', ')}). Run Codex Subagent: Enable Model for an exact ID or correct codexSubagent.models in User Settings.`;
  }
  if (restricted) {
    return `No configured model allows workspace-write. Set allowWrite: true (or omit it) for a configured model in codexSubagent.models, or start read-only work. Update the pool in User Settings.`;
  }
  return 'No eligible worker model is configured. Review codexSubagent.models in User Settings, then retry.';
}

/**
 * Aggregate capability used only to decide whether FileTools should create and
 * expose restricted tools. It deliberately treats an empty pool as no access;
 * WorkerEngine still enforces the exact per-session model policy on every call.
 * Shell is only available through a single policy that allows both write and
 * shell, matching the workspace-write requirement.
 */
export function poolAllows(pool: Record<string, ModelPolicy>, field: 'allowWrite' | 'allowShell'): boolean {
  return Object.values(pool).some(policy =>
    policy.allowWrite !== false && (field === 'allowWrite' || policy.allowShell !== false)
  );
}

export function effectiveSettings(base: Settings, modelId: string): Settings {
  const entry = base.models?.[modelId];
  if (!entry) {
    return base;
  }
  // Only present per-model fields override; omitted fields retain the engine's
  // built-in/base runtime settings. Permission flags and numSessions (per-model
  // scheduler capacity) are enforced directly against the pool by the engine,
  // not through Settings.
  const overlay: Partial<Settings> = {};
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
