import { randomUUID } from 'node:crypto';
import { createPatch } from 'diff';
import type { Change, PackageFiles, Proposal, Scope, Skill } from './types.js';
import { now, sameScope } from './types.js';
import { Store } from './store.js';
import { PackageStore, metadata, validatePackage, renamePackage } from './packages.js';
import { ensure } from './errors.js';
import { hash } from './security.js';
import { containsSecrets, redact } from './learning.js';

interface Publication {
  id: string;
  before: Skill[];
  after: Skill[];
  committed: boolean;
}
const publishedState = (state: Skill['state']) => state === 'active' || state === 'stale';
export class Catalog {
  constructor(
    readonly store: Store,
    readonly packages: PackageStore,
  ) {
    this.recover();
  }
  list(scope: Scope): Skill[] {
    return this.store
      .all<Skill>('skills')
      .filter(
        (s) => sameScope(s, scope) || (s.scope === 'global' && s.tenant_id === scope.tenant_id),
      );
  }
  get(scope: Scope, id: string): Skill {
    const s = this.store.get<Skill>('skills', id);
    ensure(
      s && (sameScope(s, scope) || (s.scope === 'global' && s.tenant_id === scope.tenant_id)),
      'not_found',
      'Skill not found',
    );
    return s;
  }
  writable(skill: Skill, automatic = false, action = 'update'): void {
    ensure(
      skill.management_policy !== 'readonly',
      'readonly_skill',
      'Skill source is read-only; clone into the managed library',
    );
    ensure(!skill.locked, 'locked_skill', 'Unlock the skill explicitly before changing it');
    if (automatic) {
      ensure(
        skill.management_policy === 'managed',
        'readonly_skill',
        'Automatic maintenance requires adoption',
      );
      ensure(
        !skill.pinned || !['archive', 'supersede'].includes(action),
        'locked_skill',
        'Pinned skill cannot be archived or merged automatically',
      );
    }
  }
  recover(): void {
    for (const publication of this.store.all<Publication>('publications')) {
      const selected = publication.committed ? publication.after : publication.before;
      for (const s of publication.after)
        if (!selected.some((p) => p.skill_id === s.skill_id)) this.packages.remove(s);
      for (const s of selected) this.packages.write(s);
      this.store.delete('publications', publication.id);
    }
  }
  verifyDisk(skill: Skill): void {
    if (skill.source !== 'plugin') return;
    const actual = this.packages.diskHash(skill);
    ensure(
      skill.state === 'archived' || skill.state === 'superseded'
        ? actual === undefined
        : actual === skill.package_hash,
      'revision_conflict',
      'Package changed on disk; refresh before editing',
    );
  }
  private newSkill(scope: Scope, files: PackageFiles, id: string = randomUUID()): Skill {
    validatePackage(files, containsSecrets);
    const meta = metadata(files);
    const time = now();
    return {
      tenant_id: scope.tenant_id,
      workspace_id: scope.workspace_id,
      ...meta,
      skill_id: id,
      scope: 'workspace',
      source: 'plugin',
      owner: 'plugin',
      management_policy: 'managed',
      state: 'active',
      pinned: false,
      locked: false,
      revision: 1,
      content_hash: hash(files['SKILL.md']),
      package_hash: hash(files),
      created_at: time,
      updated_at: time,
      use_count: 0,
      view_count: 0,
      patch_count: 0,
      source_session_ids: [],
      validation_status: 'valid',
      risk_level: 'low',
      files,
    };
  }
  private commit(
    scope: Scope,
    actor: string,
    before: Skill[],
    after: Skill[],
    event: string,
    finish?: () => void,
  ): Skill[] {
    const publication: Publication = { id: randomUUID(), before, after, committed: false };
    this.store.put('publications', publication.id, publication);
    try {
      for (const skill of after) this.packages.write(skill);
      this.store.transaction(() => {
        for (const skill of after) {
          this.store.put('skills', skill.skill_id, skill);
          const previous = before.find((s) => s.skill_id === skill.skill_id);
          this.store.put('skill_versions', skill.skill_id + ':' + skill.revision, {
            ...scope,
            skill_id: skill.skill_id,
            revision: skill.revision,
            skill,
            author: actor,
            created_at: now(),
            source: event,
            diff: this.diffFiles(previous?.files ?? {}, skill.files),
          });
          this.store.emit(event, scope, actor, skill.skill_id, {}, undefined, skill.revision);
        }
        finish?.();
        this.store.put('publications', publication.id, { ...publication, committed: true });
      });
      this.store.delete('publications', publication.id);
      return after;
    } catch (error) {
      // Keep the recovery journal if rollback itself fails. Startup will refuse to open until repaired.
      for (const skill of after)
        if (!before.some((s) => s.skill_id === skill.skill_id)) this.packages.remove(skill);
      for (const skill of before) this.packages.write(skill);
      this.store.delete('publications', publication.id);
      throw error;
    }
  }
  create(
    scope: Scope,
    actor: string,
    files: PackageFiles,
    dry = false,
    kind: 'workspace' | 'global' = 'workspace',
  ): Skill {
    const next = this.newSkill(scope, files);
    next.scope = kind;
    ensure(
      !this.list(scope).some((s) => s.name === next.name && publishedState(s.state)),
      'validation_error',
      'A published skill with this name already exists',
    );
    return dry ? next : this.commit(scope, actor, [], [next], 'skill.created')[0]!;
  }
  update(
    scope: Scope,
    actor: string,
    id: string,
    revision: number,
    patch: Partial<
      Pick<
        Skill,
        | 'files'
        | 'state'
        | 'pinned'
        | 'locked'
        | 'management_policy'
        | 'replaced_by'
        | 'source_session_ids'
      >
    >,
    dry = false,
    automatic = false,
  ): Skill {
    const old = this.get(scope, id);
    ensure(
      sameScope(old, scope),
      'scope_violation',
      'Modify a global skill from its owning workspace',
    );
    ensure(old.revision === revision, 'revision_conflict', 'Skill revision changed');
    const unlocking = old.locked && patch.locked === false && Object.keys(patch).length === 1;
    if (!unlocking)
      this.writable(old, automatic, patch.state === 'archived' ? 'archive' : 'update');
    this.verifyDisk(old);
    const files = patch.files ?? old.files;
    validatePackage(files, containsSecrets);
    const meta = metadata(files);
    ensure(
      !this.list(scope).some(
        (s) =>
          s.skill_id !== id &&
          s.name === meta.name &&
          publishedState(s.state) &&
          publishedState(patch.state ?? old.state),
      ),
      'validation_error',
      'A published skill with this name already exists',
    );
    const next: Skill = {
      ...old,
      ...patch,
      ...meta,
      files,
      revision: old.revision + 1,
      updated_at: now(),
      package_hash: hash(files),
      content_hash: hash(files['SKILL.md']),
      patch_count: old.patch_count + (patch.files ? 1 : 0),
    };
    const event =
      patch.state === 'archived'
        ? 'skill.archived'
        : patch.state === 'active' && old.state === 'archived'
          ? 'skill.restored'
          : patch.locked === true
            ? 'skill.locked'
            : 'skill.updated';
    return dry ? next : this.commit(scope, actor, [old], [next], event)[0]!;
  }
  rename(
    scope: Scope,
    actor: string,
    id: string,
    revision: number,
    name: string,
    dry = false,
  ): Skill {
    const skill = this.get(scope, id);
    return this.update(
      scope,
      actor,
      id,
      revision,
      { files: renamePackage(skill.files, name) },
      dry,
    );
  }
  history(scope: Scope, id: string) {
    this.get(scope, id);
    return this.store
      .all<{
        skill_id: string;
        revision: number;
        skill: Skill;
        author: string;
        created_at: string;
        source: string;
        diff: string;
      }>('skill_versions')
      .filter((v) => v.skill_id === id);
  }
  rollback(
    scope: Scope,
    actor: string,
    id: string,
    revision: number,
    target: number,
    dry = false,
  ): Skill {
    const previous = this.history(scope, id).find((v) => v.revision === target);
    ensure(previous, 'not_found', 'Revision not found');
    return this.update(
      scope,
      actor,
      id,
      revision,
      { files: previous.skill.files, state: previous.skill.state },
      dry,
    );
  }
  diffFiles(before: PackageFiles, after: PackageFiles): string {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .filter((p) => before[p] !== after[p])
      .map((p) => createPatch(p, before[p] ?? '', after[p] ?? ''))
      .join('\n');
  }
  recordUsage(scope: Scope, actor: string, id: string, source: string): void {
    const skill = this.get(scope, id);
    this.store.transaction(() => {
      const event = { ...scope, id: randomUUID(), skill_id: id, observed_at: now(), source };
      this.store.put('usage', event.id, event);
      this.store.put('skills', id, {
        ...skill,
        use_count: skill.use_count + 1,
        last_used_at: event.observed_at,
      });
      this.store.emit('skill.used', scope, actor, id, { source });
    });
  }
  refresh(scope: Scope, actor: string): Skill[] {
    for (const old of this.list(scope).filter(
      (s) => s.source === 'plugin' && ['active', 'stale'].includes(s.state),
    )) {
      const actual = this.packages.diskHash(old);
      if (actual && actual !== old.package_hash) {
        const files = this.packages.read(this.packages.path(scope, old.skill_id));
        validatePackage(files, containsSecrets);
        const next = {
          ...old,
          ...metadata(files),
          files,
          revision: old.revision + 1,
          package_hash: hash(files),
          content_hash: hash(files['SKILL.md']),
          updated_at: now(),
        };
        this.commit(scope, actor, [old], [next], 'skill.updated');
      }
    }
    this.store.emit('manager.refreshed', scope, actor, scope.workspace_id);
    return this.list(scope);
  }
  discover(
    scope: Scope,
    actor: string,
    entries: { name: string; description: string; path: string; content?: string }[],
    allowedRoots: string[],
  ): void {
    for (const entry of entries) {
      const existing = this.list(scope).find((s) => s.source_path === entry.path);
      if (entry.path.startsWith(this.packages.root + '/')) continue;
      let files: PackageFiles;
      let complete = false;
      try {
        files = this.packages.read(entry.path.replace(/[/\\]SKILL\.md$/, ''), allowedRoots);
        validatePackage(files, containsSecrets);
        complete = true;
      } catch {
        // SDK sources may have virtual paths, display names and body-only content.
        // Keep a redacted preview without treating it as a publishable package.
        files = { 'SKILL.md': redact(entry.content ?? '') };
      }
      const base = complete
        ? this.newSkill(scope, files)
        : {
            ...this.newSkill(scope, {
              'SKILL.md': '---\nname: placeholder\ndescription: Source metadata\n---\n',
            }),
            name: redact(entry.name),
            description: redact(entry.description || entry.name),
            files,
            content_hash: hash(files['SKILL.md']),
            package_hash: hash(files),
          };
      const skill = {
        ...base,
        skill_id: existing?.skill_id ?? base.skill_id,
        revision: (existing?.revision ?? 0) + 1,
        created_at: existing?.created_at ?? base.created_at,
        scope: 'external' as const,
        source: 'discovery',
        source_path: entry.path,
        owner: 'third_party' as const,
        management_policy: 'readonly' as const,
        validation_status: complete ? 'valid' : 'incomplete_source',
      };
      if (
        existing &&
        existing.package_hash === skill.package_hash &&
        existing.validation_status === skill.validation_status &&
        existing.name === skill.name &&
        existing.description === skill.description
      )
        continue;
      this.store.transaction(() => {
        this.store.put('skills', skill.skill_id, skill);
        this.store.put('skill_versions', skill.skill_id + ':' + skill.revision, {
          tenant_id: scope.tenant_id,
          workspace_id: scope.workspace_id,
          skill_id: skill.skill_id,
          revision: skill.revision,
          skill,
          author: actor,
          created_at: now(),
          source: 'discovery',
          diff: this.diffFiles(existing?.files ?? {}, files),
        });
      });
    }
  }
  proposal(
    scope: Scope,
    actor: string,
    operation: string,
    changes: Change[],
    rationale: string,
    refs: string[] = [],
    automatic = false,
    dry = false,
  ): Proposal {
    ensure(
      changes.length > 0 && changes.length <= 100,
      'validation_error',
      'Proposal must contain 1–100 changes',
    );
    ensure(
      !containsSecrets(rationale + ' ' + refs.join(' ')),
      'validation_error',
      'Sensitive proposal metadata rejected',
    );
    const normalized = changes.map((c) =>
      c.action === 'create' ? { ...c, skill_id: c.skill_id ?? randomUUID() } : c,
    );
    const proposal: Proposal = {
      tenant_id: scope.tenant_id,
      workspace_id: scope.workspace_id,
      proposal_id: randomUUID(),
      operation,
      status: 'pending',
      changes: normalized,
      rationale,
      source_refs: refs,
      risk_level: ['merge', 'split', 'archive'].includes(operation) ? 'high' : 'low',
      created_at: now(),
      created_by: actor,
      diff: normalized
        .map((c) =>
          this.diffFiles(
            c.action === 'create' ? {} : this.get(scope, c.skill_id!).files,
            c.files ?? (c.action === 'archive' ? {} : this.get(scope, c.skill_id!).files),
          ),
        )
        .join('\n'),
      content_hash: '',
      automatic,
      revision: 1,
    };
    proposal.content_hash = this.proposalHash(proposal);
    this.validateProposal(proposal);
    if (!dry)
      this.store.transaction(() => {
        this.store.put('proposals', proposal.proposal_id, proposal);
        this.store.emit('proposal.created', scope, actor, proposal.proposal_id);
      });
    return proposal;
  }
  proposalHash(p: Proposal): string {
    return hash({
      changes: p.changes,
      rationale: p.rationale,
      source_refs: p.source_refs,
      operation: p.operation,
      automatic: p.automatic,
      ...{ tenant_id: p.tenant_id, workspace_id: p.workspace_id },
    });
  }
  getProposal(scope: Scope, id: string): Proposal {
    const p = this.store.get<Proposal>('proposals', id);
    ensure(p && sameScope(scope, p), 'not_found', 'Proposal not found');
    return p;
  }
  validateProposal(p: Proposal): { valid: true; errors: string[] } {
    ensure(
      p.content_hash === this.proposalHash(p),
      'validation_error',
      'Proposal content integrity check failed',
    );
    const seen = new Set<string>();
    for (const change of p.changes) {
      ensure(
        change.skill_id && !seen.has(change.skill_id),
        'validation_error',
        'Duplicate or missing skill target',
      );
      seen.add(change.skill_id);
      if (change.files) validatePackage(change.files, containsSecrets);
      if (change.action === 'create') {
        ensure(
          change.files && !this.store.get('skills', change.skill_id),
          'revision_conflict',
          'New skill target already exists',
        );
        continue;
      }
      const skill = this.get(p, change.skill_id);
      ensure(sameScope(skill, p), 'scope_violation', 'Proposal must use the owning workspace');
      this.writable(skill, p.automatic, change.action);
      this.verifyDisk(skill);
      ensure(
        skill.revision === change.expected_revision &&
          (!change.expected_package_hash || skill.package_hash === change.expected_package_hash),
        'revision_conflict',
        'Proposal is based on an outdated skill revision',
      );
    }
    return { valid: true, errors: [] };
  }
  decide(
    scope: Scope,
    actor: string,
    id: string,
    decision: 'approved' | 'rejected' | 'cancelled',
    revision: number,
  ): Proposal {
    return this.store.transaction(() => {
      const p = this.getProposal(scope, id);
      ensure(p.revision === revision, 'revision_conflict', 'Proposal revision changed');
      ensure(
        p.status === 'pending' || (p.status === 'approved' && decision === 'cancelled'),
        'validation_error',
        'Proposal already decided',
      );
      if (decision === 'approved') this.validateProposal(p);
      const next = {
        ...p,
        status: decision,
        approved_by: decision === 'approved' ? actor : undefined,
        decided_at: now(),
        revision: p.revision + 1,
      };
      this.store.put('proposals', id, next);
      this.store.emit(
        'proposal.' +
          (decision === 'approved'
            ? 'approved'
            : decision === 'rejected'
              ? 'rejected'
              : 'cancelled'),
        scope,
        actor,
        id,
      );
      return next;
    });
  }
  apply(
    scope: Scope,
    actor: string,
    id: string,
    revision: number,
    dry = false,
  ): { proposal: Proposal; skills: Skill[] } {
    const p = this.getProposal(scope, id);
    ensure(p.revision === revision, 'revision_conflict', 'Proposal revision changed');
    ensure(p.status === 'approved' && p.approved_by, 'forbidden', 'Proposal must be approved');
    this.validateProposal(p);
    const before: Skill[] = [];
    const after: Skill[] = [];
    for (const change of p.changes) {
      if (change.action === 'create') {
        const skill = this.newSkill(scope, change.files!, change.skill_id);
        skill.source_session_ids = p.source_refs;
        after.push(skill);
      } else {
        const old = this.get(scope, change.skill_id!);
        before.push(old);
        const files = change.files ?? old.files;
        after.push({
          ...old,
          ...metadata(files),
          files,
          state:
            change.action === 'archive'
              ? 'archived'
              : change.action === 'restore'
                ? 'active'
                : change.action === 'supersede'
                  ? 'superseded'
                  : change.action === 'stale'
                    ? 'stale'
                    : old.state,
          replaced_by: change.replaced_by,
          revision: old.revision + 1,
          updated_at: now(),
          package_hash: hash(files),
          content_hash: hash(files['SKILL.md']),
          source_session_ids: [...new Set([...old.source_session_ids, ...p.source_refs])],
        });
      }
    }
    const remaining = this.list(scope).filter((s) => !after.some((a) => a.skill_id === s.skill_id));
    const names = new Set<string>();
    for (const skill of [...remaining, ...after].filter((s) => publishedState(s.state))) {
      ensure(!names.has(skill.name), 'validation_error', 'Duplicate published skill name');
      names.add(skill.name);
    }
    const next: Proposal = { ...p, status: 'applied', revision: p.revision + 1 };
    if (!dry)
      this.commit(
        scope,
        actor,
        before,
        after,
        p.operation === 'merge' ? 'skill.merged' : 'skill.updated',
        () => {
          this.store.put('proposals', id, next);
          this.store.emit('proposal.applied', scope, actor, id, { source_refs: p.source_refs });
        },
      );
    return { proposal: dry ? p : next, skills: after };
  }
  mergePreview(
    scope: Scope,
    actor: string,
    ids: string[],
    name: string,
    automatic = false,
    dry = false,
  ): Proposal {
    ensure(
      ids.length >= 2 && new Set(ids).size === ids.length,
      'validation_error',
      'Merge requires distinct skills',
    );
    const sources = ids.map((id) => this.get(scope, id));
    for (const s of sources) this.writable(s, automatic, 'supersede');
    const files: PackageFiles = {
      'SKILL.md': `---\nname: ${name}\ndescription: Consolidated procedures from selected skills.\n---\n\n# ${name}\n\n`,
    };
    for (const source of sources) {
      const prefix = 'sources/' + source.skill_id + '/';
      for (const [path, content] of Object.entries(source.files)) files[prefix + path] = content;
      files['SKILL.md'] += `- [${source.name}](${prefix}SKILL.md): ${source.description}\n`;
    }
    const target = randomUUID();
    return this.proposal(
      scope,
      actor,
      'merge',
      [
        { action: 'create', skill_id: target, files },
        ...sources.map((s) => ({
          action: 'supersede' as const,
          skill_id: s.skill_id,
          expected_revision: s.revision,
          expected_package_hash: s.package_hash,
          replaced_by: target,
        })),
      ],
      'Preserve complete source packages in isolated subdirectories; review scripts that assume the package root.',
      sources.flatMap((s) => s.source_session_ids),
      automatic,
      dry,
    );
  }
  splitPreview(
    scope: Scope,
    actor: string,
    id: string,
    parts: PackageFiles[],
    dry = false,
  ): Proposal {
    const source = this.get(scope, id);
    this.writable(source);
    ensure(parts.length >= 2, 'validation_error', 'Split requires at least two packages');
    for (const [path, value] of Object.entries(source.files).filter(
      ([path]) => path !== 'SKILL.md',
    ))
      ensure(
        parts.some((part) => part[path] === value),
        'validation_error',
        'Split would lose a dependent file: ' + path,
      );
    return this.proposal(
      scope,
      actor,
      'split',
      [
        ...parts.map((files) => ({ action: 'create' as const, files })),
        {
          action: 'archive',
          skill_id: id,
          expected_revision: source.revision,
          expected_package_hash: source.package_hash,
        },
      ],
      'Split into explicit packages; original package retained in version history.',
      source.source_session_ids,
      false,
      dry,
    );
  }
}
