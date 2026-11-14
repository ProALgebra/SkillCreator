import { Plugin } from '@opencode/plugin/tui';
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from 'solid-js';
import type { BoxRenderable, ScrollBoxRenderable } from '@opentui/core';
import { SkillCurator, type MethodName, type RpcInput } from './rpc.js';
import type { Skill, Proposal, Settings } from './types.js';
import type { Job } from './jobs.js';
import { resolveLocalToken } from './auth.js';

const errorMessage = (error: unknown): string =>
  error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message
    : 'Operation failed';

const errorCode = (error: unknown): unknown => {
  if (!error || typeof error !== 'object') return;
  if ('data' in error && error.data && typeof error.data === 'object' && 'code' in error.data)
    return error.data.code;
  if ('code' in error) return error.code;
  if ('type' in error && typeof error.type === 'string') return error.type.split('.').at(-1);
};

export default Plugin.define({
  id: 'opencode-skill-curator.tui',
  setup(context) {
    const [pendingTasks, setPendingTasks] = createSignal(0);
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
        throw Object.assign(new Error(errorMessage(error)), { code: errorCode(error) });
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
      setPendingTasks((value) => value + 1);
      try {
        await task();
      } catch (error) {
        context.ui.toast.show({
          message: errorMessage(error),
          variant: 'error',
        });
      } finally {
        setPendingTasks((value) => value - 1);
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
    const refine = async () => {
      const route = context.ui.router.current();
      let sessionID: string | undefined;
      if (route.type === 'session') {
        const source = await context.ui.dialog.select({
          title: 'Разобрать переписку',
          options: [
            { title: 'Текущая переписка', value: 'current' },
            { title: 'Выбрать из истории', value: 'history' },
          ],
        });
        if (!source) return;
        if (source === 'current') sessionID = route.sessionID;
      }
      if (!sessionID) {
        const sessions = (await call('learning.sessions', { limit: 100 })) as {
          items: Array<{ session_id: string; title: string }>;
        };
        if (sessions.items.length === 0) {
          await alert('Разобрать переписку', 'В этом проекте нет доступных переписок.');
          return;
        }
        sessionID = await context.ui.dialog.select({
          title: 'Переписка для разбора',
          options: sessions.items.map((session) => ({
            title: session.title || session.session_id,
            value: session.session_id,
          })),
        });
        if (!sessionID) return;
      }
      const focus = await context.ui.dialog.prompt({
        title: 'Что извлечь из переписки?',
        description:
          'Можно оставить пустым. Сообщения проверяются как источники, а не как инструкции. По умолчанию изменения навыков требуют одобрения.',
        value: '',
      });
      if (focus === undefined) return;
      const mode = await chooseMode();
      if (!mode) return;
      await mutate('learning.refine', {
        session_ids: [sessionID],
        ...(focus.trim() ? { reason: focus.trim() } : {}),
        execution: execution(mode),
      });
      context.ui.toast.show({
        message: 'Разбор переписки запущен. Результаты появятся в предложениях навыков.',
        variant: 'success',
      });
    };
    const publication = async () => {
      const current = (await call('settings.get')) as {
        revision: number;
        settings: Settings;
      };
      const approval = current.settings.approval;
      const automatic =
        approval.mode === 'auto' &&
        approval.allow_auto_create &&
        approval.allow_auto_patch_managed_low_risk;
      const selective =
        approval.mode === 'auto' &&
        (approval.allow_auto_create ||
          approval.allow_auto_patch_managed_low_risk ||
          approval.allow_auto_archive_managed);
      const mode = await context.ui.dialog.select({
        title:
          'Публикация навыков · ' +
          (automatic ? 'автоматическая' : selective ? 'выборочная' : 'ручная'),
        options: [
          {
            title: 'Вручную',
            value: 'manual',
            description: 'Одобрять предложения перед публикацией навыков.',
          },
          {
            title: 'Автоматически',
            value: 'auto',
            description:
              'Новые результаты: создание навыков и безопасные обновления управляемых навыков без одобрения.',
          },
        ],
      });
      if (!mode) return;
      const enabled = mode === 'auto';
      if (
        approval.mode === mode &&
        approval.allow_auto_create === enabled &&
        approval.allow_auto_patch_managed_low_risk === enabled
      )
        return;
      await mutate('settings.set_publication_mode', {
        publication_mode: mode as 'manual' | 'auto',
        expected_revision: current.revision,
      });
      context.ui.toast.show({
        message: enabled
          ? 'Автоматическая публикация следующих результатов включена: новые навыки и безопасные обновления.'
          : 'Включена ручная публикация: предложения требуют одобрения.',
        variant: 'success',
      });
    };
    const optimize = async () => {
      const action = await context.ui.dialog.select({
        title: 'Оптимизация библиотеки навыков',
        options: [
          {
            title: 'Запустить сейчас',
            value: 'run',
            description: 'Найти улучшения и смысловые пересечения навыков.',
          },
          {
            title: 'Предварительный просмотр',
            value: 'preview',
            description: 'Показать состав проверки без запуска модели.',
          },
          { title: 'Состояние и отчёты', value: 'status' },
          { title: 'Автоматическая проверка', value: 'automation' },
          { title: 'Расписание и параметры', value: 'schedule' },
          { title: 'Автоматическое объединение', value: 'auto_merge' },
          { title: 'Приостановить куратора', value: 'pause' },
          { title: 'Продолжить работу куратора', value: 'resume' },
          { title: 'Подготовить откат изменения', value: 'rollback' },
        ],
      });
      if (!action) return;
      if (action === 'run') {
        const mode = await chooseMode();
        if (!mode) return;
        await alert(
          'Запуск оптимизации',
          await mutate('curator.optimize', { execution: execution(mode) }),
        );
      } else if (action === 'preview') {
        await alert(
          'План оптимизации без запуска модели',
          await call('curator.optimize', { dry_run: true }),
        );
      } else if (action === 'status') {
        await alert('Куратор — состояние и отчёты', await call('curator.status'));
      } else if (action === 'automation') {
        const current = (await call('settings.get')) as { revision: number; settings: Settings };
        const curator = current.settings.curator;
        const mode = !curator.enabled
          ? 'disabled'
          : curator.llm_review_enabled
            ? 'optimize'
            : 'lifecycle';
        const selected = await context.ui.dialog.select({
          title:
            'Автоматическая проверка · ' +
            (mode === 'disabled'
              ? 'выключена'
              : mode === 'optimize'
                ? 'смысловая оптимизация'
                : 'устаревание навыков'),
          options: [
            {
              title: 'Выключена',
              value: 'disabled',
              description: 'Ручной запуск остаётся доступным.',
            },
            {
              title: 'Проверять устаревание',
              value: 'lifecycle',
              description: 'Проверка возраста и использования навыков без вызова модели.',
            },
            {
              title: 'Смысловая оптимизация',
              value: 'optimize',
              description:
                'Проверка моделью по расписанию во время простоя. Публикация — согласно настроенной политике.',
            },
          ],
        });
        if (!selected || selected === mode) return;
        await mutate('settings.patch', {
          expected_revision: current.revision,
          patch: {
            curator: {
              enabled: selected !== 'disabled',
              llm_review_enabled: selected === 'optimize',
            },
          },
        });
        context.ui.toast.show({
          message:
            selected === 'disabled'
              ? 'Автоматическая проверка отключена.'
              : selected === 'optimize'
                ? 'Смысловая оптимизация по расписанию включена.'
                : 'Автоматическая проверка устаревания включена.',
          variant: 'success',
        });
      } else if (action === 'schedule') {
        const current = (await call('settings.get')) as { revision: number; settings: Settings };
        const value = await context.ui.dialog.prompt({
          title: 'Расписание куратора — JSON',
          value: JSON.stringify(current.settings.curator, null, 2),
          description:
            'enabled включает куратора; llm_review_enabled — смысловую проверку моделью. interval_hours задаёт интервал между проверками.',
        });
        if (value === undefined || !value.trim()) return;
        const patch: unknown = JSON.parse(value);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch))
          throw new Error('Параметры куратора должны быть JSON-объектом.');
        if (
          !Object.keys(patch).length ||
          JSON.stringify(patch) === JSON.stringify(current.settings.curator)
        )
          return;
        await mutate('settings.patch', {
          expected_revision: current.revision,
          patch: { curator: patch },
        });
        context.ui.toast.show({ message: 'Расписание куратора сохранено.', variant: 'success' });
      } else if (action === 'auto_merge') {
        const current = (await call('settings.get')) as { revision: number; settings: Settings };
        const approval = current.settings.approval;
        const value = await context.ui.dialog.select({
          title:
            'Автоматическое объединение · ' +
            (approval.allow_auto_merge ? 'разрешено' : 'запрещено'),
          options: [
            { title: 'Требовать одобрение', value: 'manual' },
            {
              title: 'Разрешить автоматическое объединение',
              value: 'auto',
              description:
                'Применяется только при автоматическом режиме публикации. Защищённые навыки сохраняются.',
            },
          ],
        });
        if (!value || approval.allow_auto_merge === (value === 'auto')) return;
        const enabled = value === 'auto';
        await mutate('settings.patch', {
          expected_revision: current.revision,
          patch: { approval: { allow_auto_merge: enabled } },
        });
        context.ui.toast.show({
          message: !enabled
            ? 'Автоматическое объединение отключено.'
            : approval.mode === 'auto'
              ? 'Автоматическое объединение разрешено.'
              : 'Разрешение сохранено. Для автоматического применения включите автоматическую публикацию через /skills-publication.',
          variant: 'success',
        });
      } else if (action === 'pause' || action === 'resume') {
        await mutate(action === 'pause' ? 'system.pause' : 'system.resume', {
          subsystem: 'curator',
        });
        context.ui.toast.show({
          message: action === 'pause' ? 'Куратор приостановлен.' : 'Пауза куратора снята.',
          variant: 'success',
        });
      } else if (action === 'rollback') {
        const value = await context.ui.dialog.prompt({
          title: 'ID применённого предложения из отчёта куратора',
        });
        if (!value?.trim()) return;
        const proposal = (await call('proposals.get', { proposal_id: value.trim() })) as Proposal;
        if (proposal.status !== 'applied')
          throw new Error('Откат доступен только для применённого предложения.');
        await alert(
          'Предложение отката — требуется одобрение',
          await mutate('curator.rollback', {
            proposal_id: proposal.proposal_id,
            expected_revision: proposal.revision,
          }),
        );
      }
    };
    const editSettingsJson = async () => {
      const current = (await call('settings.get')) as {
        revision: number;
        settings: Record<string, unknown>;
      };
      const patch = await context.ui.dialog.prompt({
        title: 'Настройки — JSON patch',
        value: '{}',
        description:
          'conversation_review, execution, limits, approval, privacy, curator, auto_learning',
      });
      if (patch)
        await mutate('settings.patch', {
          expected_revision: current.revision,
          patch: JSON.parse(patch),
        });
    };
    const editSettings = async () => {
      const action = await context.ui.dialog.select({
        title: 'Настройки навыков',
        options: [
          {
            title: 'Публикация навыков',
            value: 'publication',
            description: 'Ручное одобрение или автоматическая публикация.',
          },
          { title: 'JSON patch', value: 'json' },
        ],
      });
      if (action === 'publication') await publication();
      else if (action === 'json') await editSettingsJson();
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
      const [selectedID, setSelectedID] = createSignal<string>();
      const [searchFocused, setSearchFocused] = createSignal(false);
      const [loadError, setLoadError] = createSignal<string>();
      const [syncNotice, setSyncNotice] = createSignal<string>();
      let catalog: ScrollBoxRenderable | undefined;
      const rows = new Map<string, BoxRenderable>();
      let initialSync = true;
      let synchronization: Promise<void> | undefined;
      const synchronize = () => {
        synchronization ??= (async () => {
          try {
            await mutate('manager.refresh');
            setSyncNotice(undefined);
          } catch (error) {
            setSyncNotice(
              errorCode(error) === 'forbidden'
                ? 'Режим чтения: показан сохранённый каталог. Синхронизация требует прав редактора.'
                : 'Не удалось синхронизировать: ' + errorMessage(error),
            );
          }
        })().finally(() => {
          synchronization = undefined;
        });
        return synchronization;
      };
      const [list, { refetch }] = createResource(
        () => ({ query: query(), state: state() }),
        async (v) => {
          try {
            if (initialSync) {
              initialSync = false;
              await synchronize();
            } else if (synchronization) await synchronization;
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
      const selected = createMemo(() =>
        list()?.items.find((skill) => skill.skill_id === selectedID()),
      );
      const revealSelected = () => {
        const row = rows.get(selectedID() ?? '');
        if (row) catalog?.scrollChildIntoView(row);
      };
      createEffect(() => {
        if (list.loading) return;
        const items = list()?.items ?? [];
        if (!items.some((skill) => skill.skill_id === selectedID()))
          setSelectedID(items[0]?.skill_id);
        revealSelected();
      });
      const timer = setInterval(() => void refetch(), 3000);
      onCleanup(() => clearInterval(timer));
      const refresh = () =>
        run(async () => {
          await synchronize();
          await refetch();
        });
      const focusCatalog = () => setSearchFocused(false);
      const move = (direction: number) => {
        if (list.loading) return;
        const items = list()?.items ?? [];
        const index = items.findIndex((skill) => skill.skill_id === selectedID());
        const next = items[Math.max(0, Math.min(items.length - 1, index + direction))];
        setSelectedID(next?.skill_id);
        revealSelected();
      };
      const action = () =>
        run(async () => {
          if (list.loading) return;
          const id = selected()?.skill_id;
          if (!id) return;
          // Polling replaces catalog objects; read the latest revision before opening an action.
          const skill = (await call('skills.get', { skill_id: id })) as Skill;
          await skillActions(skill);
          await refetch();
        });
      context.keymap.layer(() => ({
        mode: 'base',
        enabled: () => {
          const route = context.ui.router.current();
          return route.type === 'plugin' && route.name === 'skills-manager' && pendingTasks() === 0;
        },
        commands: [
          {
            bind: 'up',
            title: 'Предыдущий навык',
            enabled: () => !searchFocused(),
            run: () => move(-1),
          },
          {
            bind: 'down',
            title: 'Следующий навык',
            enabled: () => !searchFocused(),
            run: () => move(1),
          },
          {
            bind: 'tab',
            title: 'Поиск / список навыков',
            run: () => {
              setSearchFocused((value) => !value);
            },
          },
          {
            bind: 'ctrl+f',
            title: 'Поиск навыка',
            run: () => {
              setSearchFocused(true);
            },
          },
          {
            bind: 'enter',
            title: 'Действия навыка',
            enabled: () => !searchFocused() && !list.loading && !!selected(),
            run: () => action(),
          },
          {
            bind: 'escape',
            title: 'Назад',
            run: () =>
              searchFocused() ? focusCatalog() : context.ui.router.navigate({ type: 'home' }),
          },
          {
            bind: 'ctrl+r',
            title: 'Обновить',
            run: () => refresh(),
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
              <text onMouseDown={() => void run(optimize)}>Оптимизация</text>
              <text onMouseDown={() => void refresh()}>Синхронизировать</text>
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
                    setSelectedID(undefined);
                  }}
                >
                  {state() === value ? '[' + value + ']' : value}
                </text>
              )}
            </For>
          </box>
          <box height={1} flexShrink={0}>
            <input
              placeholder="Поиск по имени, описанию и файлам · Ctrl+F / Tab"
              focused={searchFocused()}
              onMouseDown={() => setSearchFocused(true)}
              onInput={setQuery}
              onSubmit={focusCatalog}
            />
          </box>
          <text height={1} flexShrink={0}>
            {list.loading
              ? 'Загрузка каталога…'
              : loadError()
                ? 'Ошибка: ' + loadError()
                : (syncNotice() ?? '')}
          </text>
          <box flexGrow={1} gap={2} flexDirection="row" minHeight={0}>
            <scrollbox
              ref={catalog}
              width="45%"
              minHeight={0}
              focused={!searchFocused()}
              onMouseDown={focusCatalog}
            >
              <Show when={!list.loading && !loadError() && list()?.items.length === 0}>
                <text>
                  {query()
                    ? 'По запросу «' + query() + '» навыки не найдены. Измените поиск.'
                    : 'В разделе ' + state() + ' нет навыков. Ctrl+R — синхронизировать.'}
                </text>
              </Show>
              <For each={list()?.items ?? []}>
                {(skill) => {
                  let row: BoxRenderable | undefined;
                  onCleanup(() => {
                    if (rows.get(skill.skill_id) === row) rows.delete(skill.skill_id);
                  });
                  return (
                    <box
                      ref={(value) => {
                        row = value;
                        rows.set(skill.skill_id, value);
                      }}
                      flexDirection="column"
                      flexShrink={0}
                      onMouseDown={() => {
                        focusCatalog();
                        setSelectedID(skill.skill_id);
                      }}
                    >
                      <text fg={selected()?.skill_id === skill.skill_id ? 'cyan' : undefined}>
                        {selected()?.skill_id === skill.skill_id ? '› ' : '  '}
                        {skill.name} · r{skill.revision} · {skill.management_policy}{' '}
                        {skill.locked ? '🔒' : ''}
                        {skill.pinned ? ' 📌' : ''}
                      </text>
                      <text>{skill.description.slice(0, 100)}</text>
                    </box>
                  );
                }}
              </For>
            </scrollbox>
            <scrollbox flexGrow={1} minHeight={0}>
              <Show
                when={selected()}
                fallback={
                  <text>
                    {list.loading
                      ? 'Загрузка…'
                      : loadError()
                        ? 'Каталог недоступен. Ctrl+R — повторить.'
                        : list()?.items.length
                          ? '↑/↓ или мышь — выбрать навык. Enter — действия.'
                          : 'Создайте навык или синхронизируйте источники через Ctrl+R.'}
                  </text>
                }
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
            Показано {list()?.items.length ?? 0} из {list()?.total ?? 0} · ↑/↓ — выбор · Enter —
            действия · Tab — поиск · Ctrl+R — синхронизация · Escape — закрыть
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
          id: 'skill-curator.refine',
          title: 'Refine conversation into skills',
          group: 'Skills',
          palette: true,
          slash: { name: 'skills-refine' },
          run: () => run(refine),
        },
        {
          id: 'skill-curator.optimize',
          title: 'Optimize skill library',
          group: 'Skills',
          palette: true,
          slash: { name: 'skills-optimize' },
          run: () => run(optimize),
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
          id: 'skill-curator.publication',
          title: 'Skill publication mode',
          group: 'Skills',
          palette: true,
          slash: { name: 'skills-publication' },
          run: () => run(publication),
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
