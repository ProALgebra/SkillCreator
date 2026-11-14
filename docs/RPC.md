# RPC skill-curator.v1

Контракт экспортируется из `opencode-skill-curator/rpc` как `SkillCurator`. Сервер регистрирует его реальным `ctx.rpc.register`. Клиент: `OpenCode.make(...).rpc(SkillCurator)['skills.list'](input)`. Публичный `CuratorClient` дополнительно валидирует responses по `outputSchemas`; типы каталога, предложений и jobs экспортированы из `rpc`.

## Конверт

```json
{
  "auth": "CAPABILITY_FROM_ENVIRONMENT",
  "scope": { "workspace_id": "my-project" },
  "skill_id": "stable-uuid",
  "expected_revision": 3,
  "idempotency_key": "archive-skill-r3",
  "reason": "Replaced with a verified procedure"
}
```

`tenant_id` можно опустить: сервер берёт его из Principal. Другая строка tenant или неразрешённый workspace отклоняются даже для администратора. `directory` в scope не даёт дополнительных прав и не выбирает произвольный путь на диске. Location OpenCode задаётся штатными client request options.

`settings_level=workspace|tenant|global` выбирает слой настроек. Workspace наследует tenant и global patches; ответ включает inherited_revisions. Изменение global-слоя требует server-bound global_admin, а не только tenant administrator. `skill_scope=global` при create/import публикует навык для других workspaces того же tenant; изменение такого навыка выполняется администратором из owning workspace.

Мутации требуют idempotency key, кроме lease/heartbeat/complete/fail с собственным lease capability. Повтор одного payload возвращает сохранённый ответ; другой payload с тем же ключом — `idempotency_conflict`. При аварии между принятием запроса и записью результата возвращается `unknown_outcome`: нужно сверить каталог/jobs, а не создавать новую операцию.

Ответ содержит `request_id`, `correlation_id`, `created_at`, `status` и поля сущности (`skill_id`, `proposal_id` или `job_id`). При изменении revision увеличивается. Коллекции: `{items, total, cursor}`; передавайте `limit` (1–200, default 50), следующий `cursor`, `filters`. Для текущей локальной версии cursor — opaque для клиента строка смещения; не используйте её как стабильный snapshot при параллельных изменениях.

## Методы

| Группа       | Методы                                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| system       | health, status, capabilities, pause, resume, shutdown_work                                                                                                                                               |
| settings     | get, patch, validate, reset                                                                                                                                                                              |
| manager      | snapshot, refresh                                                                                                                                                                                        |
| skills       | list, get, search, create, update, rename, clone, merge.preview, split.preview, archive, restore, pin, unpin, lock, unlock, adopt, unadopt, history, diff, rollback, import, export, usage, dependencies |
| learning     | run, ingest, candidates, backfill                                                                                                                                                                        |
| curator      | review, analyze_duplicates, lifecycle_run, update                                                                                                                                                        |
| proposals    | list, get, validate, approve, reject, apply, cancel                                                                                                                                                      |
| jobs         | list, get, run, pause, resume, cancel, retry, progress, logs, lease, heartbeat, complete, fail                                                                                                           |
| executors    | list, status, test, set_policy                                                                                                                                                                           |
| stats        | overview, learning, skills, costs                                                                                                                                                                        |
| audit/events | audit.list, events.replay                                                                                                                                                                                |

Все 74 метода зарегистрированы. Используется единая строгая input schema: неизвестные поля запрещены; обязательность отдельных аргументов дополнительно проверяется обработчиком. Рабочий список и Zod schemas находятся в `src/rpc.ts`.

## Аргументы операций

| Операция                                            | Поля кроме общего конверта                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| create/import                                       | `files: {"SKILL.md": "---...", "assets/a.bin": "base64:..."}`                                            |
| update                                              | `skill_id`, `expected_revision`, полный новый `files`                                                    |
| rename/clone                                        | `skill_id`, `name`; rename также `expected_revision`                                                     |
| archive/restore/pin/unpin/lock/unlock/adopt/unadopt | `skill_id`, `expected_revision`; unlock требует `reason`                                                 |
| merge.preview                                       | `skill_ids` минимум 2, `name`; создаёт high-risk proposal                                                |
| split.preview                                       | `skill_id`, `parts` — массив полных пакетов; запрещена потеря зависимостей                               |
| history/diff/rollback                               | `skill_id`; diff: `from_revision`,`to_revision`; rollback: `target_revision`,`expected_revision`         |
| proposals.approve/reject/cancel/apply               | `proposal_id`, `expected_revision` предложения                                                           |
| learning.ingest                                     | `transcript: {source_instance, session_id, stage_id, content, verified, source_refs?, internal?}`        |
| learning.backfill                                   | `transcripts`, `limit?`, `cursor?`; explicit import, не скрытый обход всего архива                       |
| learning.run                                        | `session_ids?`, `execution?`; отсутствие ids выбирает непройденные источники                             |
| curator.review/update                               | `skill_ids?` / `skill_id?`, `execution?`                                                                 |
| curator.lifecycle_run                               | Без LLM; findings и предложения stale/archive, с dedupe по revision                                      |
| jobs.run                                            | `operation`: learning/review/merge/update, `execution`, `skill_ids?`, `session_ids?`; merge также `name` |
| jobs.pause/resume/cancel/retry                      | `job_id`; retry разрешён только после определённого failed                                               |
| settings.patch                                      | `patch`, `expected_revision` настроек                                                                    |
| executors.set_policy                                | `patch` для execution, `expected_revision` настроек                                                      |
| jobs.lease                                          | `worker_id`, `worker_kind`: valeria/external                                                             |
| jobs.heartbeat                                      | `job_id`, `worker_id`, `lease_token`, `progress` 0–1                                                     |
| jobs.complete                                       | `job_id`, `worker_id`, `lease_token`, `result`, `cost_usd`                                               |
| jobs.fail                                           | `job_id`, `worker_id`, `lease_token`, `error`, `cost_usd?`                                               |

`expected_revision` относится к редактируемой сущности; у proposal и skill независимые счётчики. Новое предложение запоминает revisions всех затрагиваемых навыков. После approval нужен новый expected_revision proposal. Изменившийся исходный пакет блокирует apply даже при сохранённом approved status.

Для неизвестного local outcome администратор может явно подтвердить остановку через `jobs.cancel({job_id,confirm_stopped:true,reason,cost_usd,idempotency_key})`. Это аудируемое заявление оператора после проверки фактической остановки и расходов; освобождаются удержанные concurrency/budget reservations. Обычный cancel такого подтверждения не подразумевает.

`skills.list/search`: filters `scope`, `owner`, `state`, `management_policy`, `managed`, `tag`, `used`, `pinned`, `locked`, `name`; sort `name`, `updated_at`, `use_count`. Поиск охватывает текст файлов. Настройки читаются вместе с их revision.

## Jobs и вывод модели

`execution.mode`: direct/session/valeria/external/auto. Также принимаются model/provider/variant, timeout_sec, max_tokens, max_iterations, priority, max_cost_usd, max_parallel, fallback_policy, approval_mode. Эти параметры сохраняются в job; какие из них может реально применить встроенный SDK adapter, описано в ACCEPTANCE.md. Worker получает политику целиком и обязан её соблюдать.

Learner output:

```json
{
  "candidates": [
    {
      "title": "Retry policy",
      "problem": "Transient failure",
      "solution": "Keep a durable marker",
      "conditions": [],
      "evidence": ["verbatim evidence from verified source"],
      "failures": [],
      "confidence": 0.95,
      "reusability_score": 0.9,
      "source_refs": ["session-id"]
    }
  ]
}
```

Review/update output: `{"updates":[{"skill_id":"...","files":{"SKILL.md":"..."},"rationale":"..."}]}`. Merge assessment: `{"merge":false,"rationale":"Unsafe overlapping dependencies"}` либо merge=true. Лишние поля, выдуманные source_refs, изменившиеся revisions и секреты блокируют принятие результата. Подтверждённый отказ от merge завершает job без proposal.

`dry_run=true` для создания/обновления/merge/split/apply проверяет пакет и возвращает потенциальный результат без записи файлов или принятия job. Для ревизии возвращаются детерминированные findings и выбранный executor. При dry-run решения о proposal возвращается текущее предложение; решение не меняется.

## События и ошибки

События имеют `event_id`, `occurred_at`, tenant/workspace, actor, correlation_id, entity_id, entity_revision?, details. Обязательные skill/proposal/job/settings/manager/health события сохраняются в `events` и `audit_log`. Текущая безопасная внешняя доставка — `events.replay`; клиент дедуплицирует по event_id и продолжает пагинацию. `manager.open` не является удалённой операцией: открытие route принадлежит локальному TUI.

Коды ошибок: unauthorized, forbidden, not_found, validation_error, revision_conflict, scope_violation, locked_skill, readonly_skill, executor_unavailable, rate_limited, budget_exceeded, idempotency_conflict, lease_expired, unknown_outcome, internal_error. SDK использует свой declared error envelope; HTTP bridge переводит его в `{"error":{"code":"...","message":"..."}}`.
