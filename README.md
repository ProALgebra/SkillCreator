# OpenCode Skill Curator

Локальный npm-плагин управления библиотекой навыков для OpenCode **2.3.0**. Серверное ядро, TUI `/skills-manager`, RPC `skill-curator.v1`, Learner, Curator и внешние workers работают через общую проверку прав. VALERIA подключается по желанию.

## Установка из исходников

Нужны Node.js **22.21.1+**, npm и среда сборки native addons, если для `better-sqlite3` нет готового бинарного файла. TUI исполняется в runtime установленного OpenCode; его OpenTUI 0.8.4 требует Bun 1.3.14+ либо Node 26.4+. Для сборки и тестов серверного ядра достаточно Node 22.

```bash
git clone https://github.com/ProALgebra/SkillCreator.git
cd SkillCreator
npm ci
npm run check
npm pack
```

Добавьте локальный каталог этого проекта в `opencode.jsonc`:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/skillCreator",
      "options": { "tenant_id": "local", "local_service_auth": true }
    }
  ]
}
```

Для локального сервиса `local_service_auth: true` позволяет серверу и TUI получить одинаковый capability из существующих закрытых учётных данных OpenCode. Отдельный токен не записывается в конфигурацию, БД или на диск; ручной экспорт переменной не нужен. Этот режим рассчитан на сервер и TUI, запущенные от одного пользователя ОС. Он выключен по умолчанию. Проверка файла учётных данных описана в [модели безопасности](docs/SECURITY.md).

В установленной пользовательской конфигурации пакет подключён из `~/.local/share/opencode/skill-curator-runtime/releases/0.1.0-8d27edfd0f27`; изменения исходников не заменяют установленную сборку. Каталог данных по умолчанию — `.curator` внутри выбранного проекта. Workspace определяется из location OpenCode; `workspace_id` можно задать явно для отдельной конфигурации.

Если локальные учётные данные сервиса недоступны или требуется собственный capability, задайте токен минимум из 24 символов в окружении **сервера и TUI**. Переменная `SKILL_CURATOR_TOKEN` имеет приоритет над `local_service_auth`:

```bash
export SKILL_CURATOR_TOKEN="$(openssl rand -hex 32)"
opencode
```

В OpenCode 2.3 сервер автоматически сообщает TUI о плагине, но не передаёт его опции. Добавьте этот же объект `package`/`options` в `~/.config/opencode/cli.json`: локальному менеджеру тоже требуется явное `local_service_auth: true`. При явных `token_env` или `workspace_id` повторите соответствующие опции в CLI-конфигурации.

Откройте `/skills-manager`. Команды `/skills-review`, `/skills-learn`, `/skills-jobs`, `/skills-settings` запускают соответствующие диалоги. В менеджере доступны поиск, архив, полные файлы пакета, создание/редактирование, diff/approval, версии, задания, настройки и аудит. Ревизия и обучение из TUI используют выбранную в OpenCode модель. Во внешнем RPC задавайте `execution.provider` и `execution.model` явно либо настройте базовую модель OpenCode.

Для подключения удалённого клиента настройте capability через окружение и защищённое соединение к серверу OpenCode. Дополнительные principals привязываются к отдельным переменным окружения; пример — [VALERIA configuration](examples/opencode.valeria.jsonc). Не выдавайте workers административный токен.

## Поведение

- SQLite/WAL хранит каталог, снимки всех файлов, предложения, задания, leases, события, аудит и настройки. Node использует better-sqlite3, Bun/OpenCode — встроенный bun:sqlite. Журнал публикаций восстанавливает целые пакеты после аварии.
- LLM возвращает структурированные кандидаты/предложения. Публикация проходит через валидацию, approval, проверку revision и package hash. Начальный режим — ручное одобрение.
- Merge сохраняет **полные пакеты** в `sources/<skill_id>/`, включая бинарные assets. Предложение предупреждает о скриптах, зависящих от текущего каталога. Скрипты автоматически не запускаются.
- `manual`, `readonly`, `locked` и `pinned` ограничивают автоматику. Сторонний пакет сначала клонируется в управляемую библиотеку. Нулевое использование не считается доказательством неактуальности.
- `direct`, `session`, `valeria`, `external`, `auto` выбираются для вызова, типа операции и workspace. Выбранный режим сохраняется в job. После принятия задания fallback запрещён.
- Сырые транскрипты не попадают во внешние workers без отдельного разрешения. Секреты и некоторые персональные данные маскируются до хранения и обращения к модели.
- История незавершённых/неподтверждённых задач сохраняется как недоверенные данные. Для публикации знания необходимы подтверждённые источники и evidence, реально присутствующее в них.

## API и интеграция

```ts
import { OpenCode } from '@opencode/client';
import { SkillCurator } from 'opencode-skill-curator/rpc';

const client = OpenCode.make({ baseUrl: 'http://127.0.0.1:4096' });
const curator = client.rpc(SkillCurator);
const skills = await curator['skills.list'](
  { auth: process.env.SKILL_CURATOR_TOKEN, limit: 50 },
  { location: { directory: '/absolute/path/to/my-project' } },
);
console.log(skills.items);
```

Мутации требуют `idempotency_key`, изменения существующих сущностей — `expected_revision`. Тяжёлые операции возвращают job. `dry_run` показывает предполагаемый результат без публикации файлов.

Документация: [архитектура](docs/ARCHITECTURE.md), [RPC](docs/RPC.md), [VALERIA и Python bridge](docs/VALERIA.md), [безопасность](docs/SECURITY.md), [backup/restore и troubleshooting](docs/OPERATIONS.md), [приёмка и ограничения](docs/ACCEPTANCE.md), [проверка установленного плагина](docs/INSTALLATION_CHECK.md). Ход реализации — [TASKS.md](TASKS.md).

## Совместимость

Плагин подключён к установленному OpenCode **2.3.0**. В работающем сервисе проверены health с `bun:sqlite`, отказ RPC без capability, создание навыка, его видимость в OpenCode, архивирование и восстановление без перезапуска сервиса. Проверены типы SDK, сборка и 57 тестов серверного ядра и адаптеров. Результаты отдельных проверок TUI и модели фиксируются в [отчёте установки](docs/INSTALLATION_CHECK.md).

SDK 2.3 не передаёт идентичность пользователя в plugin RPC context и не позволяет фильтровать RPC live events по capability. Поэтому авторизация выполняется собственным capability-конвертом, а события читаются через защищённый `events.replay`. Встроенный `direct` API возвращает только текст: учёт расходов консервативно списывает резерв; жёсткий лимит фактического счёта провайдера этим API не гарантируется. Для точного биллинга используйте worker с подтверждёнными расходами. Подробности и границы первой реализации перечислены в `docs/ACCEPTANCE.md`.

## Проверки

```bash
npm run typecheck
npm test
npm run build
npm run test:bun
npm run test:tui
```

CI запускает эти проверки на Linux с Node 22 и 24, проверяет состав tarball. Тесты покрывают права, optimistic locking, идемпотентность, архив/restore/rollback, сохранность пакетов при merge/split, Learner provenance, policy, маршрутизацию, leases/heartbeat/reconciliation, лимиты и аварийное восстановление отдельного процесса.
