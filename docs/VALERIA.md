# VALERIA и другие внешние клиенты

Интеграция не требует VALERIA для запуска плагина. Поставлены TS-клиент, HTTP bridge и Python SDK. Сам репозиторий VALERIA не изменялся; bridge адаптируется к её реальному API очереди в месте интеграции.

## Подключение

1. В сервере OpenCode настройте `credentials` из `examples/opencode.valeria.jsonc`; токены задайте через окружение сервера и соответствующего клиента. Каждый токен привязан к Principal с tenant/workspace и ролями.
2. От имени администратора примените `examples/settings.valeria.json` через `settings.patch` с текущей revision и idempotency key. Это **настройки плагина через RPC**, их нельзя вставлять как несуществующие корневые поля конфигурации OpenCode.
3. VALERIA UI получает `manager.snapshot`, каталоги/версии/proposals/jobs/settings и вызывает те же RPC-методы, что TUI.
4. Worker использует отдельный token с ролью worker и worker_kind=valeria. Вызов VALERIA с execution.mode=direct/session остаётся локальным в OpenCode.

## HTTP/Python

Запустите из собранного проекта:

```bash
OPENCODE_URL=http://127.0.0.1:4096 node examples/http-bridge.mjs
CURATOR_WORKSPACE=my-project python3 examples/valeria_client.py
```

Bridge слушает **127.0.0.1:8787**. Его единственный маршрут — `POST /rpc`, собственный маршрут адаптера. Он передаёт запрос через настоящий `@opencode/client` RPC; не предполагает `/api/curator/...` на сервере OpenCode. Укажите реальный OpenCode URL в окружении. При защищённом сервере его штатную сетевую авторизацию следует добавить в настройки клиента bridge согласно используемому способу deployment.

```json
{ "method": "skills.list", "input": { "scope": { "workspace_id": "my-project" }, "limit": 50 } }
```

Capability передаётся заголовком `Authorization: Bearer ...`. Bridge перезаписывает input.auth из заголовка, ограничивает размер запроса, не включает CORS и не журналирует тела/токены. Для удалённого доступа разместите за аутентифицированным TLS reverse proxy. Не публикуйте loopback bridge напрямую.

## Pull worker и durable marker

```text
jobs.lease(worker_id, worker_kind=valeria)
  → job, context, lease_token, expires_at
  → найти в VALERIA задачу по marker=job.job_id
      confirmed absent: submit exactly once with marker
      present: resume observing same VALERIA task
      unknown/network failure: stop, reconcile; never submit another task
  → jobs.heartbeat(job_id, worker_id, lease_token, progress)
  → jobs.complete(..., result=<structured JSON>, cost_usd=<reported cost>)
```

Сохраните в durable bridge registry соответствие `job_id → VALERIA task ID` **до** любых повторов после timeout. Секретный lease token храните шифрованным с ключом из secret store либо в защищённом хранилище сервиса; plaintext в task metadata/логах недопустим. Перед повтором submit проверьте фактическое наличие задачи по marker. Повтор complete с прежними token/worker/payload возвращает тот же job; конфликтующий payload отклоняется.

После истечения lease job становится unknown_outcome и больше не выдаётся. Старый worker может согласовать известный исход по первоначальному capability. Heartbeat истёкшего lease запрещён; новый LLM-run не создаётся автоматически. Для отменённого job acknowledgement завершает cancellation без публикации результата.

`context.sessions` пуст при выключенном `privacy.send_raw_transcripts_to_external`; это ожидаемое ограничение раскрытия. Чтобы включить внешнее обучение, администратор должен явно разрешить передачу очищенной истории. Содержимое skill packages для ревизии передаётся только назначенному executor по авторизованному scope.

Панель VALERIA может строиться непосредственно из manager.snapshot, а события опрашиваться через events.replay. Код UI самой VALERIA и её deployment требуют отдельного окружения проекта; серверный контракт готов для этой интеграции.
