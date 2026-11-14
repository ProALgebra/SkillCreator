# Архитектура и модель данных

```mermaid
flowchart TB
  TUI[OpenCode TUI /skills-manager] --> RPC[skill-curator.v1]
  Clients[VALERIA / TS / HTTP bridge] --> RPC
  RPC --> Auth[Capability → Principal → tenant/workspace → Role]
  Auth --> Core[CuratorCore: единые правила]
  Core --> Catalog[Catalog / immutable proposals / validation]
  Core --> Learning[History / Learner / deterministic Curator]
  Core --> Jobs[JobService / mode router / budgets]
  Jobs --> Direct[Direct generation]
  Jobs --> Session[Isolated internal session]
  Jobs --> Worker[VALERIA / external pull worker]
  Catalog --> SQLite[(SQLite WAL / versions / audit / events)]
  Learning --> SQLite
  Jobs --> SQLite
  Catalog --> Journal[Durable publication journal]
  Journal --> Packages[Full skill packages]
```

## Модули

| Файл                        | Ответственность                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `server.ts`                 | Реальная регистрация Plugin.define, RPC, skill transform/reload, capture и scheduler        |
| `core.ts`                   | Авторизованный dispatch 77 методов, идемпотентность, материализация LLM-контекста           |
| `catalog.ts`                | Каталог, revisions, версии, proposals, merge/split, публикация и recovery                   |
| `packages.ts`               | Allowlist путей, links, YAML, binary encoding, staged filesystem replacement                |
| `store.ts` / `database.ts`  | SQLite, миграция v1, Node/Bun drivers, IMMEDIATE transactions, process lock, durable events |
| `jobs.ts`                   | Зафиксированный executor, конкурентность, бюджет, timeout, lease и reconciliation           |
| `learning.ts`               | Provenance, очистка, dedupe, evidence validation, deterministic findings                    |
| `refine.ts`                 | Неизменяемые снимки переписки, контекст каталога, кандидаты создания/обновления             |
| `conversation-review.ts`    | Долговременный счётчик действий, завершение ответа, дедупликация и задержки автозапуска     |
| `opencode-conversations.ts` | Чтение истории SDK с проверками проекта, состояния idle и гонок при захвате                 |
| `settings.ts`               | Строгая схема настроек, deep patch, optimistic locking                                      |
| `rpc.ts`                    | Публичные Standard Schema/Zod-контракты и типы клиента                                      |
| `tui.tsx`                   | Solid/OpenTUI route и диалоги поверх RPC                                                    |

## Хранение

`<data_directory>/curator.sqlite` открывается с WAL, synchronous=FULL, busy_timeout=5000. По умолчанию каталог данных — `<project>/.curator`. Каталог навыков можно задать отдельно. БД содержит таблицы `skills`, `skill_versions`, `sessions`, `learning_candidates`, `proposals`, `jobs`, `job_attempts`, `job_leases`, `events`, `audit_log`, `settings`, `usage`, `idempotency`, `publications`, `control`. Строки — JSON с ограничением json_valid и стабильным primary key. Версия схемы хранится в `schema_migrations`; первая миграция транзакционная и повторяемая.

Пакеты располагаются под хешем **только** tenant/workspace и стабильным skill_id. Название навыка не является путём. Текст хранится в UTF-8, произвольные бинарные данные — строками `base64:<данные>`. Такой же формат применён в RPC export/import. Хеш вычисляется по канонически отсортированным ключам полного пакета. Просмотр файла не исполняет его.

Схема связей:

```mermaid
erDiagram
  sessions ||--o{ learning_candidates : verifies
  learning_candidates ||--o{ proposals : motivates
  proposals ||--o{ skill_versions : publishes
  skills ||--o{ skill_versions : snapshots
  skills ||--o{ usage : observes
  jobs ||--o{ job_attempts : attempts
  jobs ||--o| job_leases : claims
  jobs ||--o{ proposals : generates
  skill_versions ||--o{ audit_log : traces
```

## Публикация и восстановление

1. Проверить policy, текущую revision, content integrity и фактический hash пакета на диске.
2. Сохранить durable journal: прежние и новые полные снимки, committed=false.
3. Создать staging-пакет, fsync файлов; заменить каталог через rename с backup. Обработать каждый пакет составной операции.
4. Одной SQLite-транзакцией сохранить новые skills, версии, статус proposal и события; отметить journal committed=true.
5. Удалить journal и обновить registry OpenCode. При ошибке reload каталог остаётся валидным, health показывает pending; повторный reload устраняет временную невидимость.

До открытия API recovery применяет старые снимки незавершённого journal либо новые снимки committed journal. При ошибке доступа/целостности запуск блокируется. Тесты прерывают настоящий дочерний процесс до и после фиксации БД. Физическое отключение питания и особенности сетевых FS отдельно не моделировались; хранение рекомендуется на локальном диске.

Второй writer в ту же БД запрещён process lock. После аварии lock снимается только при подтверждённом отсутствии прежнего PID. Мутации внутри процесса сериализованы; SQLite IMMEDIATE атомарно фиксирует leases и revisions.

## Jobs

Режим выбирается до постановки в очередь. `auto` выбирает первый доступный из предпочтений; активный job не мигрирует при изменении настроек. Локальные jobs исполняются scheduler, внешние — через atomic pull lease. В БД сохраняется SHA-256 случайного lease token. После истечения lease: `unknown_outcome`, запрет повторной выдачи/retry и консервативное сохранение бюджетного резерва. Прежний worker может прислать подтверждённый исход с прежней capability; повторный complete того же payload идемпотентен.

Лимит расходов проверяется по tenant за UTC-день, конкурентность — глобально, по executor и workspace. Незавершённые исходы удерживают слоты и резервы. Отмена принятого задания требует acknowledgement, потому что разрыв соединения сам по себе не доказывает остановку внешней модели.

## История

В режиме conversation review hook считает все завершённые вызовы инструментов отдельно для каждой переписки. Listener сохраняет границу успешного ответа; started/failed/interrupted сбрасывают её. Scheduler проверяет порог действий, задержки, quiet hours, pause и native idle перед постановкой задания. Счётчик и ограниченное окно дедупликации последних 512 событий находятся в `control`; retry с неизвестным исходом сохраняет ключ, подтверждённый отказ до принятия позволяет новую попытку с задержкой. История до установки автоматически не обходится.

`learning.refine` читает текущий SDK-контекст, очищает и ограничивает его размер, фиксирует immutable snapshot ID, revisions и hashes доступных целей. Сам текст остаётся в `sessions` с `verified:false`; job хранит идентификаторы. Модель получает снимок и каталог, возвращает кандидаты с именем нового навыка либо `target_skill_id` существующего. При обновлении добавляется раздел Refinement с процедурой, условиями, ошибками и цитатами; остальные файлы пакета сохраняются. Принятие результата проверяет цитаты и разрешённые цели повторно. `truncated` и `catalog_omitted` обозначают неполный контекст. Конфликт каталога останавливает обработку.

Отдельный `learning.run` сохраняет прежние требования: только verified-источники и буквальное evidence. При выключенном conversation review доступен прежний сбор test-tool фрагментов и backlog истории. Внутренние session IDs регистрируются до create/prompt. Ни один LLM-ответ не может одобрить собственное предложение; автоматическое одобрение выполняет только настроенная серверная policy.

Официальные источники совместимости: [server API](https://opencode.ai/docs/build/plugins/server/), [TUI API](https://opencode.ai/docs/build/plugins/cli/), [RPC API](https://opencode.ai/docs/build/plugins/rpc/), [package parts](https://opencode.ai/docs/build/plugins/). Проверены 14 ноября 2026; пакет закреплён на 2.3.0.
