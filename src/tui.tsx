import { Plugin } from '@opencode/plugin/tui';
import { For, Show, createResource, createSignal, onCleanup } from 'solid-js';
import { SkillCurator, type MethodName, type RpcInput } from './rpc.js';
import type { Skill, Proposal } from './types.js';
import type { Job } from './jobs.js';
import { resolveLocalToken } from './auth.js';

const errorMessage = (error: unknown): string =>
  error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message
    : 'Operation failed';

export default Plugin.define({
  id: 'opencode-skill-curator.tui',
  setup(context) {
    const auth = resolveLocalToken({
      token_env: String(context.options.token_env ?? 'SKILL_CURATOR_TOKEN'),
      local_service_auth: context.options.local_service_auth === true,
    });
    const rpc = context.client.rpc(SkillCurator);
    const scope = context.options.workspace_id
      ? { workspace_id: String(context.options.workspace_id) }
      : undefined;
    const call = async (method: MethodName, input: RpcInput = {}): Promise<unknown> => {
      try {
        return await rpc[method](
          { ...input, auth, scope },
          { location: context.location ?? context.data.location.default() },
        );
      } catch (error) {
        throw new Error(errorMessage(error));
      }
    };
    const mutate = (method: MethodName, input: RpcInput = {}) =>
      call(method, { ...input, idempotency_key: crypto.randomUUID() });
    const alert = (title: string, value: unknown) =>
      context.ui.dialog.alert({
        title,
        message: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      });
    const run = async (task: () => Promise<unknown>) => {
      try {
        await task();
      } catch (error) {
        context.ui.toast.show({
          message: errorMessage(error),
          variant: 'error',
        });
      }
    };
    const confirm = (title: string) =>
      context.ui.dialog.confirm({
        title,
        message: 'Применить выбранное действие? История версий сохранится.',
      });
    const open = () => context.ui.router.navigate({ type: 'plugin', name: 'skills-manager' });
    const chooseMode = async () =>
      context.ui.dialog.select({
        title: 'Исполнитель',
        options: ['auto', 'direct', 'session', 'valeria', 'external'].map((value) => ({
          title: value,
          value,
        })),
      });
    const execution = (mode: string) => {
      const model = context.ui.model.current();
      return {
        mode: mode as 'auto',
        ...(model
          ? { provider: model.providerID, model: model.modelID, variant: model.variant }
          : {}),
      };
    };
    const review = async () => {
      const mode = await chooseMode();
      if (mode) await mutate('curator.review', { execution: execution(mode) });
    };
    const learn = async () => {
      const mode = await chooseMode();
      if (mode) await mutate('learning.run', { execution: execution(mode) });
    };
    const editSettings = async () => {
      const current = (await call('settings.get')) as {
        revision: number;
        settings: Record<string, unknown>;
      };
      const patch = await context.ui.dialog.prompt({
        title: 'Настройки — JSON patch',
        value: '{}',
        description: 'execution, limits, approval, privacy, curator, auto_learning',
      });
      if (patch)
        await mutate('settings.patch', {
          expected_revision: current.revision,
          patch: JSON.parse(patch),
        });
    };
    const jobs = async () => {
      const list = (await call('jobs.list', { limit: 200 })) as { items: Job[] };
      const id = await context.ui.dialog.select({
        title: 'Задания',
        options: list.items.map((j) => ({
          title: j.operation + ' · ' + j.status,
          value: j.job_id,
          description:
            j.executor_mode +
            ' · ' +
            Math.round(j.progress * 100) +
            '% · $' +
            j.cost +
            ' · attempts ' +
            j.attempt,
        })),
      });
      if (!id) return;
      const job = (await call('jobs.get', { job_id: id })) as Job;
      const action = await context.ui.dialog.select({
        title: job.operation,
        options: ['details', 'pause', 'resume', 'cancel', 'retry'].map((value) => ({
          title: value,
          value,
        })),
      });
      if (action === 'details') await alert('Задание', job);
      else if (action && (await confirm(action)))
        await mutate(('jobs.' + action) as MethodName, { job_id: id });
    };
    const proposals = async () => {
      const list = (await call('proposals.list', { limit: 200 })) as { items: Proposal[] };
      const id = await context.ui.dialog.select({
        title: 'Предложения',
        options: list.items.map((p) => ({
          title: p.operation + ' · ' + p.status,
          value: p.proposal_id,
          description: p.rationale,
        })),
      });
      if (!id) return;
      const p = (await call('proposals.get', { proposal_id: id })) as Proposal;
      await alert('Diff · ' + p.risk_level, p.diff || p.rationale);
      const action = await context.ui.dialog.select({
        title: 'Действие',
        options: ['validate', 'approve', 'reject', 'apply', 'cancel'].map((value) => ({
          title: value,
          value,
        })),
      });
      if (action && (await confirm(action)))
        await mutate(('proposals.' + action) as MethodName, {
          proposal_id: id,
          expected_revision: p.revision,
        });
    };
    const create = async () => {
      const name = await context.ui.dialog.prompt({
        title: 'Имя навыка',
        placeholder: 'review-changes',
      });
      if (!name) return;
      const description = await context.ui.dialog.prompt({
        title: 'Описание и условия применения',
      });
      if (!description) return;
      const instructions = await context.ui.dialog.prompt({ title: 'Инструкции навыка' });
      if (!instructions) return;
      await mutate('skills.create', {
        files: {
          'SKILL.md': `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}\n`,
        },
      });
    };
    const batch = async () => {
      const list = (await call('skills.list', { limit: 200 })) as { items: Skill[] };
      const chosen = new Set<string>();
      for (;;) {
        const value = await context.ui.dialog.select({
          title: 'Выберите навыки: ' + chosen.size,
          options: [
            { title: 'Готово — выбрать действие', value: '__done' },
            ...list.items.map((s) => ({
              title: (chosen.has(s.skill_id) ? '[x] ' : '[ ] ') + s.name,
              value: s.skill_id,
            })),
          ],
        });
        if (!value) return;
        if (value === '__done') break;
        if (chosen.has(value)) chosen.delete(value);
        else chosen.add(value);
      }
      if (!chosen.size) return;
      const action = await context.ui.dialog.select({
        title: 'Пакетная операция',
        options: ['merge', 'archive', 'pin', 'adopt', 'export'].map((value) => ({
          title: value,
          value,
        })),
      });
      if (!action) return;
      if (action === 'merge') {
        const name = await context.ui.dialog.prompt({ title: 'Имя объединённого навыка' });
        if (name)
          await alert(
            'Merge proposal',
            await mutate('skills.merge.preview', { skill_ids: [...chosen], name }),
          );
        return;
      }
      if (!(await confirm(action + ' · ' + chosen.size + ' навыков'))) return;
      const exported: unknown[] = [];
      for (const id of chosen) {
        const current = (await call('skills.get', { skill_id: id })) as Skill;
        if (action === 'export') exported.push(await call('skills.export', { skill_id: id }));
        else
          await mutate(('skills.' + action) as MethodName, {
            skill_id: id,
            expected_revision: current.revision,
          });
      }
      if (action === 'export') await alert('Экспорт пакетов', exported);
    };
    const skillActions = async (skill: Skill) => {
      const action = await context.ui.dialog.select({
        title: skill.name + ' · revision ' + skill.revision,
        options: [
          'files',
          'edit',
          'rename',
          'clone',
          'archive',
          'restore',
          'pin',
          'unpin',
          'lock',
          'unlock',
          'adopt',
          'unadopt',
          'history',
          'rollback',
          'export',
          'usage',
          'dependencies',
        ].map((value) => ({ title: value, value })),
      });
      if (!action) return;
      const input: RpcInput = { skill_id: skill.skill_id, expected_revision: skill.revision };
      if (action === 'files') {
        const file = await context.ui.dialog.select({
          title: 'Файлы пакета',
          options: Object.keys(skill.files).map((path) => ({ title: path, value: path })),
        });
        if (file) await alert(file, skill.files[file]);
        return;
      }
      if (action === 'edit') {
        const value = await context.ui.dialog.prompt({
          title: 'Полный пакет — JSON {путь: содержимое}',
          value: JSON.stringify(skill.files),
        });
        if (value && (await confirm('Сохранить пакет')))
          await mutate('skills.update', { ...input, files: JSON.parse(value) });
        return;
      }
      if (['rename', 'clone'].includes(action)) {
        const name = await context.ui.dialog.prompt({
          title: 'Новое имя',
          value: skill.name + '-copy',
        });
        if (name) await mutate(('skills.' + action) as MethodName, { ...input, name });
        return;
      }
      if (
        action === 'history' ||
        action === 'export' ||
        action === 'usage' ||
        action === 'dependencies'
      ) {
        await alert(action, await call(('skills.' + action) as MethodName, input));
        return;
      }
      if (action === 'rollback') {
        const value = await context.ui.dialog.prompt({ title: 'Номер версии для восстановления' });
        if (value && (await confirm('Откатить версию')))
          await mutate('skills.rollback', { ...input, target_revision: Number(value) });
        return;
      }
      if (action === 'unlock') {
        const reason = await context.ui.dialog.prompt({ title: 'Причина снятия блокировки' });
        if (reason) await mutate('skills.unlock', { ...input, reason });
        return;
      }
      if (await confirm(action + (skill.management_policy === 'manual' ? ' — ручной навык' : '')))
        await mutate(('skills.' + action) as MethodName, input);
    };
    function Manager() {
      const [query, setQuery] = createSignal('');
      const [state, setState] = createSignal('active');
      const [selected, setSelected] = createSignal<Skill>();
      const [loadError, setLoadError] = createSignal<string>();
      const [list, { refetch }] = createResource(
        () => ({ query: query(), state: state() }),
        async (v) => {
          try {
            const result = (await call('skills.list', {
              query: v.query,
              filters: { state: v.state },
              limit: 200,
            })) as { items: Skill[]; total: number };
            setLoadError(undefined);
            return result;
          } catch (error) {
            setLoadError(errorMessage(error));
            return { items: [] as Skill[], total: 0 };
          }
        },
      );
      const timer = setInterval(() => void refetch(), 3000);
      onCleanup(() => clearInterval(timer));
      const action = () =>
        run(async () => {
          const skill = selected();
          if (skill) await skillActions(skill);
          await refetch();
        });
      context.keymap.layer(() => ({
        mode: 'base',
        enabled: () => {
          const route = context.ui.router.current();
          return route.type === 'plugin' && route.name === 'skills-manager';
        },
        commands: [
          {
            bind: 'enter',
            title: 'Действия навыка',
            run: () => {
              void action();
            },
          },
          {
            bind: 'escape',
            title: 'Назад',
            run: () => context.ui.router.navigate({ type: 'home' }),
          },
          {
            bind: 'ctrl+r',
            title: 'Обновить',
            run: () => {
              void refetch();
            },
          },
        ],
      }));
      return (
        <box flexDirection="column" padding={1} gap={1} width="100%" height="100%">
          <text height={1} flexShrink={0}>
            Skill Curator · Каталог / Предложения / Задания / Настройки
          </text>
          <box flexDirection="column" height={2} flexShrink={0}>
            <box gap={2} flexDirection="row" height={1}>
              <text onMouseDown={() => void run(create)}>Создать</text>
              <text onMouseDown={() => void run(batch)}>Пакетные</text>
              <text onMouseDown={() => void run(review)}>Ревизия</text>
              <text onMouseDown={() => void run(learn)}>Обучение</text>
              <text onMouseDown={() => void run(proposals)}>Предложения</text>
            </box>
            <box gap={2} flexDirection="row" height={1}>
              <text onMouseDown={() => void run(jobs)}>Задания</text>
              <text onMouseDown={() => void run(editSettings)}>Настройки</text>
              <text
                onMouseDown={() =>
                  void run(async () => {
                    await mutate('manager.refresh');
                    await refetch();
                  })
                }
              >
                Синхронизировать
              </text>
              <text
                onMouseDown={() => void run(async () => alert('Аудит', await call('audit.list')))}
              >
                Аудит
              </text>
            </box>
          </box>
          <box gap={2} flexDirection="row" height={1} flexShrink={0}>
            <For each={['active', 'stale', 'archived', 'superseded']}>
              {(value) => (
                <text
                  onMouseDown={() => {
                    setState(value);
                    setSelected(undefined);
                  }}
                >
                  {state() === value ? '[' + value + ']' : value}
                </text>
              )}
            </For>
          </box>
          <box height={1} flexShrink={0}>
            <input placeholder="Поиск по имени, описанию и файлам" onInput={setQuery} />
          </box>
          <Show when={loadError()}>
            <text>Ошибка: {loadError()}</text>
          </Show>
          <box flexGrow={1} gap={2} flexDirection="row" minHeight={0}>
            <scrollbox width="45%" minHeight={0}>
              <For each={list()?.items ?? []}>
                {(skill) => (
                  <box flexDirection="column" onMouseDown={() => setSelected(skill)}>
                    <text fg={selected()?.skill_id === skill.skill_id ? 'cyan' : undefined}>
                      {skill.name} · r{skill.revision} · {skill.management_policy}{' '}
                      {skill.locked ? '🔒' : ''}
                      {skill.pinned ? ' 📌' : ''}
                    </text>
                    <text>{skill.description.slice(0, 100)}</text>
                  </box>
                )}
              </For>
            </scrollbox>
            <scrollbox flexGrow={1} minHeight={0}>
              <Show
                when={selected()}
                fallback={<text>Выберите навык. Enter — действия, Ctrl+R — обновить.</text>}
              >
                {(skill) => (
                  <box flexDirection="column">
                    <text onMouseDown={() => void action()}>Открыть действия · {skill().name}</text>
                    <text>
                      {JSON.stringify(
                        {
                          owner: skill().owner,
                          state: skill().state,
                          scope: skill().scope,
                          provenance: skill().source_session_ids,
                          use_count: skill().use_count,
                          last_used_at: skill().last_used_at,
                        },
                        null,
                        2,
                      )}
                    </text>
                    <For each={Object.entries(skill().files)}>
                      {([path, content]) => (
                        <box flexDirection="column">
                          <text>━━ {path} ━━</text>
                          <text>
                            {content.startsWith('base64:')
                              ? 'Двоичный файл — доступен в экспорте'
                              : content}
                          </text>
                        </box>
                      )}
                    </For>
                  </box>
                )}
              </Show>
            </scrollbox>
          </box>
          <text height={1} flexShrink={0}>
            Показано {list()?.items.length ?? 0} из {list()?.total ?? 0} · Escape — закрыть
          </text>
        </box>
      );
    }
    const unregister = context.ui.router.register({
      name: 'skills-manager',
      render: () => <Manager />,
    });
    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'skill-curator.manager',
          title: 'Skills manager',
          group: 'Skills',
          palette: true,
          slash: { name: 'skills-manager' },
          run: open,
        },
        {
          id: 'skill-curator.review',
          title: 'Review skills',
          group: 'Skills',
          palette: true,
          slash: { name: 'skills-review' },
          run: () => run(review),
        },
        {
          id: 'skill-curator.learn',
          title: 'Learn history',
          group: 'Skills',
          palette: true,
          slash: { name: 'skills-learn' },
          run: () => run(learn),
        },
        {
          id: 'skill-curator.jobs',
          title: 'Skill jobs',
          group: 'Skills',
          palette: true,
          slash: { name: 'skills-jobs' },
          run: () => run(jobs),
        },
        {
          id: 'skill-curator.settings',
          title: 'Skill settings',
          group: 'Skills',
          palette: true,
          slash: { name: 'skills-settings' },
          run: () => run(editSettings),
        },
      ],
    }));
    return unregister;
  },
});
