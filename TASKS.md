# План реализации OpenCode Skill Curator

Источник требований: `OpenCode_Skill_Curator_TZ.md`. План создан до реализации.
Статусы: `[ ] pending`, `[-] in_progress`, `[x] completed`. Завершение отмечается после проверки результата.

1. [x] Изучить ТЗ, проверить доступный SDK OpenCode и определить архитектуру, границы совместимости и критерии проверки.
2. [x] Создать TypeScript/npm-пакет, конфигурацию сборки, публичные типы и RPC-контракт.
3. [x] Реализовать долговременное транзакционное хранилище, миграции, версии, аудит, события и восстановление.
4. [x] Реализовать каталог и безопасную работу с полными пакетами навыков: discovery, CRUD, archive/restore, pin/lock/adopt, export/import, rollback.
5. [x] Реализовать immutable proposals, diff/validation/approval/apply, merge/split и контроль конфликтов/политик.
6. [x] Реализовать jobs, маршрутизацию исполнителей, лимиты, отмену/повтор, durable leases и worker API.
7. [x] Реализовать сбор/импорт истории, дедупликацию, очистку секретов, Learner и детерминированный/LLM Curator.
8. [x] Подключить авторизацию tenant/workspace, все RPC-методы, идемпотентность, настройки и наблюдаемость.
9. [x] Реализовать адаптер OpenCode, команды и TUI-менеджер на общих серверных методах.
10. [x] Добавить документацию архитектуры, установки, безопасности, backup/restore, примеры конфигурации и клиентов TypeScript/Python.
11. [x] Добавить CI и выполнить unit/integration/contract/security/recovery/e2e проверки; устранить найденные ошибки.
12. [x] Проверить сборку и состав npm-пакета, сверить результат с ТЗ, зафиксировать фактические ограничения и итог проверок.

## Подключение к установленному OpenCode

13. [x] Найти установленный OpenCode, проверить версию, конфигурацию и работающий сервис. Обнаружен OpenCode 2.3.0 и локальный background service.
14. [x] Настроить постоянную локальную авторизацию, добавить плагин в пользовательскую конфигурацию и проверить загрузку сервером. Плагин загружен; реальный RPC health подтверждает native SQLite и доступность direct/session.
15. [x] Проверить реальные RPC, создание/видимость/архивирование тестового навыка, TUI и доступный LLM-executor; исправить выявленные ошибки.
16. [x] Повторить необходимые проверки, обновить пакет и документацию, зафиксировать результат живой интеграции.

## Публикация в GitHub

17. [x] Подключить `git@github.com:ProALgebra/SkillCreator.git`, проверить существующую ветку и сохранить историю репозитория. Сохранены исходный коммит и MIT-лицензия ProALgebra; рабочая ветка — master.
18. [x] Подготовить файлы к публикации, проверить исключения и отсутствие секретов, выполнить проверки перед коммитом. Проверены форматирование, состав npm-пакета, portable paths и исключение локальных данных; MIT-лицензия исходного репозитория сохранена.
19. [-] Создать коммит, отправить его в GitHub и проверить совпадение локального и удалённого коммита.

## Проверки и принятые решения

- Исходный каталог содержит только ТЗ; существующего кода, Git-репозитория и локальных соглашений нет.
- Реальная версия SDK и поддерживаемые точки расширения проверяются перед выбором адаптера; неподтверждённые API не объявляются работающими.
- Публикация в npm и изменения внешних репозиториев не входят в локальную реализацию.
- Проверены официальные страницы OpenCode build/plugins (server, cli, rpc) и установлен реальный `@opencode/plugin@2.3.0` / `@opencode/client@2.3.0`. Используется Node.js 22.21.1;
- Архитектура: независимое серверное ядро, SQLite/WAL, журнал публикаций полных пакетов, единая проверка прав для RPC/TUI/workers, LLM выдаёт только проверяемые предложения.
- TypeScript-сборка серверной части, RPC и Solid/OpenTUI прошла; проверены реальные типы SDK. В SDK 2.3 direct generate возвращает только текст: встроенный адаптер учитывает полный резерв стоимости, точную стоимость предоставляет внешний executor.
- Проверены lifecycle, merge с binary assets, approvals, revision/idempotency conflicts, lease/heartbeat/reconciliation, бюджеты, redaction и provenance. Crash recovery проверен прерыванием настоящего дочернего процесса; SDK adapter — contract tests.
- Ограничение SDK 2.3: у RPC context нет authenticated principal и фильтрации private live events. Реализован capability envelope и авторизованный durable events.replay; приватный общий broadcast не используется.
- Финальный `npm run check` прошёл: typecheck, **57 тестов**, build. Проверены HTTP/Python integration, global skills, наследование global/tenant/workspace settings и административное согласование unknown outcomes.
- Дополнительно прошли `test:bun` (Bun 1.3.14, native SQLite lifecycle/restart/backup), `test:tui` (настоящий headless OpenTUI frame/каталог/slash-команды), `format:check` и `test:package` (exports и SQLite core из извлечённого tarball).
- Создан `opencode-skill-curator-0.1.0.tgz`; server/tui/rpc exports присутствуют. В поставку не вошли node_modules, БД, токены, .env и Python cache. CI включает серверные, Bun/TUI и package проверки.
- `npm audit --omit=dev`: 0 high/critical, 26 moderate transitive advisories закреплённого SDK/OpenTUI. Прямые Zod/YAML/diff обновлены.
- При первоначальной сборке живая инсталляция не проверялась. После отдельного запроса пользователя OpenCode 2.3.0 подключён и проверен: native TUI, RPC, skill lifecycle, direct/session с DeepSeek. VALERIA по-прежнему проверена только на уровне контрактов. Подробности — `docs/INSTALLATION_CHECK.md`.

- Живая установка завершена: версия сборки в `skill-curator-runtime/releases/0.1.0-8d27edfd0f27`, server и CLI настроены, native TUI открыт; последние direct/session jobs DeepSeek завершены, явный HTTP 429 не блокирует очередь. 57 тестов и package/Bun/TUI проверки прошли.
