export type Role = 'viewer' | 'editor' | 'curator' | 'administrator' | 'worker';
export interface Principal {
  subject: string;
  tenant_id: string;
  workspace_ids: string[];
  roles: Role[];
  worker_kind?: 'valeria' | 'external';
  global_admin?: boolean;
}
export interface Scope {
  tenant_id: string;
  workspace_id: string;
}
export type Mode = 'direct' | 'session' | 'valeria' | 'external' | 'auto';
export type PackageFiles = Record<string, string>;
export interface Skill {
  skill_id: string;
  name: string;
  description: string;
  scope: 'global' | 'workspace' | 'external';
  tenant_id: string;
  workspace_id: string;
  source: string;
  source_path?: string;
  owner: 'plugin' | 'user' | 'third_party' | 'unknown';
  management_policy: 'managed' | 'manual' | 'readonly';
  state: 'active' | 'stale' | 'archived' | 'superseded';
  pinned: boolean;
  locked: boolean;
  revision: number;
  content_hash: string;
  package_hash: string;
  created_at: string;
  updated_at: string;
  last_used_at?: string;
  use_count: number;
  view_count: number;
  patch_count: number;
  replaced_by?: string;
  source_session_ids: string[];
  validation_status: string;
  risk_level: string;
  files: PackageFiles;
  tags: string[];
}
export interface Change {
  skill_id?: string;
  expected_revision?: number;
  expected_package_hash?: string;
  action: 'create' | 'update' | 'archive' | 'restore' | 'supersede' | 'stale';
  name?: string;
  files?: PackageFiles;
  replaced_by?: string;
}
export interface Proposal extends Scope {
  proposal_id: string;
  operation: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'cancelled';
  changes: Change[];
  rationale: string;
  source_refs: string[];
  risk_level: 'low' | 'medium' | 'high';
  created_at: string;
  created_by: string;
  approved_by?: string;
  decided_at?: string;
  diff: string;
  content_hash: string;
  automatic: boolean;
  validation?: { valid: boolean; errors: string[] };
  revision: number;
}
export interface Execution {
  mode?: Mode;
  model?: string;
  provider?: string;
  variant?: string;
  temperature?: number;
  max_tokens?: number;
  max_iterations?: number;
  timeout_sec?: number;
  priority?: 'low' | 'normal' | 'high';
  max_cost_usd?: number;
  max_parallel?: number;
  fallback_policy?: 'before_accept' | 'never';
  approval_mode?: 'manual' | 'auto';
}
export interface Settings {
  enabled: boolean;
  conversation_review: {
    enabled: boolean;
    every_n_actions: number;
    min_age_sec: number;
    debounce_sec: number;
    provider?: string;
    model?: string;
    variant?: string;
  };
  auto_learning: {
    enabled: boolean;
    on_session_end: boolean;
    every_n_sessions: number;
    include_child_sessions: boolean;
    backfill_on_first_start: boolean;
    min_age_sec: number;
    debounce_sec: number;
    max_backlog: number;
    retention_days: number;
    quiet_hours: number[];
  };
  curator: {
    enabled: boolean;
    interval_hours: number;
    llm_review_enabled: boolean;
    stale_after_days: number;
    archive_after_days: number;
    archive_requires_evidence: boolean;
  };
  execution: {
    default_mode: Mode;
    auto_preferred_modes: Exclude<Mode, 'auto'>[];
    fallback_before_accept_only: boolean;
    max_parallel_total: number;
    max_parallel_per_workspace: number;
    max_parallel_per_executor: number;
    operation_modes: Partial<Record<string, Mode>>;
  };
  approval: {
    mode: 'manual' | 'safe' | 'auto';
    allow_auto_create: boolean;
    allow_auto_patch_managed_low_risk: boolean;
    allow_auto_archive_managed: boolean;
    protect_manual_skills: boolean;
  };
  limits: { daily_cost_usd: number; max_job_cost_usd: number; max_context_tokens: number };
  privacy: {
    redact_secrets: boolean;
    send_raw_transcripts_to_external: boolean;
    exclude_internal_sessions: boolean;
  };
  valeria_bridge: { enabled: boolean; worker_kind: 'valeria'; lease_seconds: number };
  external_bridge: { enabled: boolean; lease_seconds: number };
}
export const now = (): string => new Date().toISOString();
export const sameScope = (a: Scope, b: Scope): boolean =>
  a.tenant_id === b.tenant_id && a.workspace_id === b.workspace_id;
