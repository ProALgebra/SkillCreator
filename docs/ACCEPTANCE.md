# Приёмка и фактические границы

Это локальная реализация npm-пакета. Публикация в npm, изменения репозитория VALERIA и deployment внешних систем не выполнялись.

## Что проверено

- Сборка TypeScript, declarations и Solid/OpenTUI в отдельные server/tui/rpc exports на SDK 2.3.0.
- Bun 1.3.14: native SQLite lifecycle, restart/restore/backup; настоящий headless OpenTUI frame с каталогом и регистрацией slash commands.
- RPC adapter lifecycle на контекстном double реальных типов SDK: registration, capability checks, skill transform/reload, cleanup.
- Создание, редактирование, rename/clone, archive/restore, rollback, pin/lock/adopt; source discovery и readonly copies.
- Объединение с побайтным сохранением binary assets и всех source trees, split с запретом потери зависимостей, immutable content hash proposals.
- Concurrent revision conflict, idempotency replay/conflict, private scope isolation и запрет worker публикаций.
- direct/session/auto выбор, независимость от VALERIA, leases/heartbeat/complete, expired lease reconciliation, timeout без fallback, бюджеты и конкурентность.
- Verified source → candidate → proposal → approval → version → audit; дедупликация, redaction и отказ от выдуманного evidence.
- Ручной/safe/auto policy, защита manual/readonly/locked/pinned и запрет архива только из use_count=0.
- Перезапуск с сохранением state/leases и настоящий crash дочернего процесса посреди publication до/после commit.
- HTTP bridge и Python client по loopback с теми же правами и ошибками.

Финальный прогон: 57 unit/integration/security/contract/recovery/e2e tests, отдельный Bun SQLite smoke test и настоящий OpenTUI headless smoke test. Сборка и проверка exports извлечённого npm tarball прошли.

## Ограничения SDK и среды

| Область             | Реализованное поведение / граница проверки                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Живой OpenCode      | OpenCode 2.3.0: реальный service, native TUI, RPC, регистрация навыков и direct/session с настроенной DeepSeek проверены; результаты в INSTALLATION_CHECK.md                                                                                                                                                 |
| Direct usage        | SDK 2.3 experimental.generate.text возвращает только text. Списывается полный резерв, фактический provider bill не измеряется этим API                                                                                                                                                                       |
| Executor parameters | model/provider/variant передаются SDK. Его Promise adapter 2.3 игнорирует requestOptions.signal: direct timeout не доказывает остановку генерации; session дополнительно вызывает явный interrupt. temperature/max_tokens/max_iterations сохраняются для workers, жёсткий лимит ими штатным API не обеспечен |
| Live events         | SDK не предоставляет caller identity/ACL live subscribers. Private общий broadcast отключён; events.replay является авторизованным durable transport                                                                                                                                                         |
| Running pause       | Очередные jobs поддерживают pause/resume. Принятый executor не считается безопасно остановленным по разрыву связи; cancel переводит в unknown до подтверждения исхода. Автоматический retry неизвестного local run не выполняется                                                                            |
| Global skills       | Явная admin-публикация внутри tenant; изменения выполняются из owning workspace. Между разными data_directory автоматической синхронизации глобального каталога нет                                                                                                                                          |
| Archive heuristics  | Положительные usage observations + сроки. Unknown/нулевая наблюдаемость оставляет навык активным. Semantic obsolete/duplicate анализ зависит от выбранной модели и владельца                                                                                                                                 |
| Merge scripts       | Полное дерево сохранено; скрипты с предположением о root cwd требуют ручной проверки. Скрипты не запускаются автоматически                                                                                                                                                                                   |
| Scope настройки     | Workspace наследует tenant и global patches поверх defaults; global patch требует отдельного server-bound global_admin. Revision относится к выбранному слою, inherited_revisions показывает родительские версии                                                                                             |
| Извлечение истории  | Есть lifecycle backlog, test-tool evidence и явный importer/backfill. Полный сырой архив всех OpenCode tool outputs не предполагается доступным через session.context                                                                                                                                        |
| Rate limits         | Есть лимиты jobs/context/budget/backlog; отдельный distributed HTTP request rate limiter должен задаваться на reverse proxy                                                                                                                                                                                  |
| PII                 | Эвристическая фильтрация известных форматов; не является доказательством отсутствия любого секрета или персонального признака                                                                                                                                                                                |
| FS integrity        | Файлы fsync, directory replacement и journal recovery проверены на локальной Linux FS; power loss/network FS и враждебный процесс с теми же правами ОС не моделировались                                                                                                                                     |
| VALERIA             | Реализованы RPC/HTTP/Python контракты и pull-worker lifecycle; UI самой VALERIA и её очередь не изменены и не проверены в живой инсталляции                                                                                                                                                                  |

Реальная установка 14 ноября 2026 года описана в [INSTALLATION_CHECK.md](INSTALLATION_CHECK.md). Остальные границы не скрываются тестовыми doubles или фиктивными SDK API. Для эксплуатационной приёмки выполните сценарии из исходного ТЗ на закреплённой версии OpenCode в своей среде.

## Deployment smoke test

1. Настроить capability через окружение либо local_service_auth в server/CLI-конфигурациях, подключить локальный пакет, открыть `/skills-manager`.
2. Создать навык и убедиться, что он присутствует в `ctx.skill.list()`/новой сессии без рестарта.
3. Выполнить deep review с настроенной моделью в direct и session; проверить отдельную внутреннюю session и отсутствие рекурсивного самообучения.
4. Проверить capabilities/manager.snapshot из VALERIA UI token, затем worker lease/heartbeat/complete из отдельного worker token.
5. Проверить restart во время job, revision conflict при ручной правке и восстановление backup в новом каталоге.

## Зависимости

Прямые версии Zod/YAML/diff обновлены до исправленных релизов. `npm audit --omit=dev` на 14 ноября 2026: 0 high/critical, 26 moderate transitive advisories закреплённых OpenCode 2.3.0 и OpenTUI. Изменение SDK вне совместимой версии требует отдельного интеграционного прогона; принудительная замена не выполнялась.
