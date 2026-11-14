# Настройка, upgrade, backup/restore

## Конфигурация

Опции загрузки (`opencode.jsonc`): data_directory, skill_directory, source_roots, tenant_id, workspace_id, token_env, local_service_auth, credentials. Относительные пути данных разрешаются процессом runtime; для deployment задавайте абсолютные пути. По умолчанию данные находятся в `.curator` выбранного проекта, workspace определяется из location OpenCode. Корни стандартных `.opencode/skills`, `.agents/skills` и пользовательского OpenCode добавляются к источникам чтения, если существуют.

`local_service_auth` выключен по умолчанию. Для локального сервиса и TUI одного пользователя ОС задайте `local_service_auth: true`: capability выводится из существующего пароля OpenCode в `${XDG_CONFIG_HOME:-~/.config}/opencode/service.json`. Файл должен быть обычным, без symlink и дополнительных hardlinks; на POSIX проверяются владелец и отсутствие доступа группы/остальных. Файл не создаётся и не изменяется плагином. Явный токен из `token_env` (по умолчанию `SKILL_CURATOR_TOKEN`) имеет приоритет. Для удалённых клиентов и отдельных workers используйте собственные env-токены и bindings в `credentials`.

В текущей установке глобальный `~/.config/opencode/opencode.jsonc` подключает пакет `~/.local/share/opencode/skill-curator-runtime/releases/0.2.1-b0438569a32f` с `local_service_auth: true`. Резервная копия прежней конфигурации сохранена рядом с ней. После замены установленной сборки выполните `opencode reload`, затем проверьте `system.health`. Для каждого API-вызова выбирайте проект через штатные request options `location`; поле `scope.directory` не заменяет выбор location. Результаты подключения приведены в [отчёте установки](INSTALLATION_CHECK.md).

Рабочие настройки меняются через `settings.get` → `settings.patch({expected_revision,patch,idempotency_key})`. Слои global → tenant → workspace наследуются как patches; `settings_level` выбирает слой, reset снимает его overrides. Global write разрешён только server-bound global_admin. Схема и defaults: `src/settings.ts`. Примеры patch: `examples/settings.standalone.json`, `examples/settings.valeria.json`.

По умолчанию manual approval, direct/session предпочтения, максимум 2 активных job глобально и 1 на workspace, $3/UTC-день на tenant, $1 резерв на job, контекст 45 000 условных токенов. Ограничение контекста реализовано консервативной оценкой по символам, а не provider tokenizer. Для автоматического патча нужны mode=auto и отдельный allow-флаг; mode=safe запрещает автопубликацию.

История не обрабатывается целиком при первом запуске. `learning.backfill` требует явный список импортируемых транскриптов и поддерживает курсор. Отправитель импорта отвечает за достоверность verified/provenance; evidence дополнительно проверяется сервером. Наблюдения test-tool с exit=0 захватываются автоматически; завершение execution без подтверждения остаётся unverified.

Локальная TUI-конфигурация `~/.config/opencode/cli.json` должна повторять объект `package`/`options` плагина, включая `local_service_auth: true` или собственный `token_env`. В SDK 2.3 server inventory передаёт путь TUI, а опции берутся из локальной CLI-конфигурации. Реальная установка и проверка описаны в [INSTALLATION_CHECK.md](INSTALLATION_CHECK.md).

Вызовы ревизии/обучения из менеджера передают текущие provider/model/variant интерфейса. Внешний RPC без этих параметров использует базовую модель OpenCode. Явные отказы authentication, rate_limit и invalid_request завершают job как failed и освобождают резерв; сетевой разрыв и неоднозначные ошибки сохраняют unknown_outcome.

## Backup

1. Выполните `system.pause` для всех обслуживаемых scope, дождитесь завершения локальной работы и сохраните связи внешних workers. Unknown outcomes сначала согласуйте по durable markers.
2. Остановите плагин/процесс OpenCode и убедитесь, что `curator.sqlite.lock` больше не занят живым процессом.
3. Скопируйте **весь data_directory**, включая SQLite/WAL/SHM при их наличии, и отдельно выбранный skill_directory, если он находится вне data_directory. Сохраняйте права доступа и защищайте резервную копию.

Для online backup доверенный Node-код в том же процессе может вызвать `await core.store.db.backup('/protected/path/curator.sqlite')`. Snapshot БД содержит все версии и файлы, но для согласованной резервной копии каталогов всё равно требуется пауза публикаций. Не копируйте один открытый `.sqlite`, игнорируя WAL.

Если local executor имеет unknown_outcome, проверьте отсутствие реального активного run и его расходы, затем администратор явно подтверждает `jobs.cancel` с confirm_stopped=true, reason и cost_usd. Для внешнего worker предпочтительно согласование по исходному lease capability. Резервы неизвестного исхода без подтверждения не снимаются.

## Restore

1. Остановите OpenCode. Восстанавливайте в новый пустой каталог; сохраните текущую повреждённую копию отдельно.
2. Верните data_directory и выбранный skill_directory из одной резервной копии, восстановите владельца и права. Env-токены задайте из secret store/окружения, они в backup БД не содержатся. Для `local_service_auth` сервер и TUI должны читать один актуальный закрытый файл учётных данных сервиса OpenCode; его перенос выполняется отдельно от backup каталога навыков.
3. Lock из backup относится к прежнему процессу. Проверьте PID и отсутствие живого владельца; устаревший lock снимается при старте автоматически. При совпавшем/повторно использованном PID требуется проверка оператором.
4. Запустите совместимую версию плагина. Journal recovery выполнится до регистрации API. Проверьте system.health, manager.refresh, skills.history и jobs.list.
5. Для потерянного materialized skill_directory при целой БД выполните offline rehydrate с доверенным доступом:

```js
import { CuratorCore } from 'opencode-skill-curator/server';
const core = new CuratorCore({ dataDirectory: '/restored/.curator' });
try {
  for (const skill of core.store.all('skills')) core.catalog.packages.write(skill);
} finally {
  await core.close();
}
```

Не применяйте rehydrate к каталогам сторонних источников: PackageStore пишет только собственную управляемую копию. Если обнаружены symlinks или чужие hardlinks, устраните подмену отдельно, не отключая проверку.

## Upgrade

Закрепляйте совместимые версии SDK/OpenCode. Перед обновлением остановите работу, сделайте backup и выполните npm ci/npm run check. Миграция v1 создаёт таблицы в одной транзакции и регистрирует schema version. Будущие миграции должны быть добавлены отдельно; downgrade БД не предполагается. Возврат к прежней версии выполняйте восстановлением соответствующего backup, а не удалением полей.

Установка этой среды использует каталог версии в `~/.local/share/opencode/skill-curator-runtime/releases/` вне node_modules. OpenCode 2.3 не инвалидирует кеш транзитивных импортов внутри node_modules при обычном reload. Для обновления выбирайте новый каталог версии и переключайте package в server/CLI-конфигурациях; затем выполните `opencode reload`.

## Troubleshooting

| Состояние                     | Действие                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unauthorized при загрузке/TUI | Для local_service_auth проверьте один файл service.json, его владельца и закрытые права; иначе задайте одинаковый env-токен сервера и TUI, минимум 24 символа. Удалите случайный env override или согласуйте его значение |
| scope_violation               | Проверьте серверную Principal binding, workspace и owning workspace глобального навыка                                                                                                                                    |
| readonly_skill                | Клонируйте полный сторонний пакет; adopt не обходит readonly                                                                                                                                                              |
| incomplete_source             | Добавьте разрешённый source root и выполните manager.refresh; клонирование неполной копии запрещено                                                                                                                       |
| revision_conflict             | Перечитайте сущность; для внешней правки файлов сначала manager.refresh, затем пересоздайте proposal                                                                                                                      |
| unknown_outcome               | Не retry/new marker автоматически; проверьте принятую задачу и согласуйте исход прежним worker capability                                                                                                                 |
| lease_expired                 | Heartbeat больше не продлевается; complete с исходной capability может согласовать известный результат                                                                                                                    |
| budget_exceeded               | Проверьте расходы и удержанные резервы unknown jobs; поднимайте лимит только осознанным admin patch                                                                                                                       |
| reload pending                | Проверьте права и SDK; manager.refresh и следующий skill.reload восстанавливают registry                                                                                                                                  |
| storage already open          | Используйте одну server instance на data_directory; не удаляйте lock живого процесса                                                                                                                                      |
| native addon mismatch         | Перейдите на поддерживаемый Node и выполните npm rebuild better-sqlite3 либо npm ci                                                                                                                                       |

Прямые зависимости с известными исправлениями обновлены. `npm audit` всё ещё может показывать transitive advisories SDK/OpenTUI; не используйте `--force` для несовместимой замены SDK. Проверяйте обновления upstream отдельно. В последней проверке не осталось high/critical advisories; фактический отчёт зафиксирован в ACCEPTANCE.md.
