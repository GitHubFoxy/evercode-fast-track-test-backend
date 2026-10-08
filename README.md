# Evercode Fast Track — backend

REST API для списка отслеживания криптовалют, актуальных котировок CoinMarketCap и накопленной истории цен в USD. Node.js 24, Express 5, TypeScript, axios и встроенный `node:sqlite`; raw SQL без ORM. SQLite хранит записи, историю и общий расход внешнего API. Поддерживается **один процесс/контейнер**, владеющий БД, не несколько реплик.

## Быстрый локальный запуск

Нужны Node.js **24** и npm; команды ниже используют [mise](https://mise.jdx.dev/). Без mise выполняйте те же команды `npm` под Node 24.

```sh
mise exec node@24 -- npm ci
cp .env.example .env
# Отредактируйте .env: задайте два разных секрета и подтверждённую квоту своего CMC-ключа.
mise exec node@24 -- npm start
```

`npm start` сначала собирает TypeScript (`prestart`), поэтому работает на свежем checkout без `dist`. Node читает `.env` стандартным `--env-file-if-exists`; уже экспортированные переменные окружения имеют приоритет. Если передаёте окружение другим способом, файл не нужен. Для отдельной сборки и запуска готового результата:

```sh
mise exec node@24 -- npm run build
mise exec node@24 -- node --env-file-if-exists=.env dist/main.js
```

После изменения исходников пересоберите/перезапустите сервис. HTTP: `http://localhost:3000`, Swagger: `http://localhost:3000/docs`, OpenAPI 3.0.3: `http://localhost:3000/openapi.json`. Сервис не имеет отдельного health endpoint. Остановка — Ctrl+C / SIGINT или SIGTERM.

`API_TOKEN` защищает собственный API; `COINMARKETCAP_API_KEY` отправляется **только** CoinMarketCap в `X-CMC_PRO_API_KEY`. Swagger публичен: в **Authorize** введите только значение `API_TOKEN` (без префикса `Bearer`). Ключ поставщика туда не вводите. UI использует локальные `swagger-ui-dist` CSS/JS без Express-обёртки/CDN. `validatorUrl: null` отключает внешний валидатор; токен не сохраняется между открытиями страницы. Не публикуйте `.env`, БД и ключи; примеры содержат только заменяемые значения. При доступе вне localhost нужен HTTPS на внешнем прокси: сам сервис TLS не завершает.

## Настройки окружения

Пример без секретов — [`.env.example`](.env.example). Обязательные значения проверяются до открытия HTTP-порта и запуска фона. Путь SQLite не может быть `:memory:`; родительский каталог создаётся автоматически.

| Переменная | Значение / ограничения |
| --- | --- |
| `API_TOKEN` | Обязательный непустой секрет собственного API |
| `COINMARKETCAP_API_KEY` | Обязательный непустой отдельный ключ поставщика |
| `DATABASE_PATH` | Обязательный путь SQLite; пример `./data/evercode.sqlite`; Compose фиксирует `/data/evercode.sqlite` |
| `PORT` | `3000`; целое 1–65535 |
| `PRICE_CURRENCY` | Только `USD`, также по умолчанию |
| `CMC_TIMEOUT_MS` | `10000`; 1–120000 мс |
| `SYNC_INTERVAL_MS` | `60000`; 1000–86400000 мс; эффективный нижний предел фона — минимум 60000 мс |
| `CMC_BATCH_SIZE` | `250`; 1–1000 монет в пакете. 250 — кредитная ступень и выбор сервиса, не заявленный максимум CMC |
| `SHUTDOWN_TIMEOUT_MS` | `10000`; 1–120000 мс; конечный срок остановки |
| `CMC_BASE_URL` | `https://pro-api.coinmarketcap.com`; HTTPS либо HTTP **только loopback**; без credentials, query, fragment и непустого path |
| `CMC_MONTHLY_LIMIT` | Подтверждённый положительный месячный лимит кредитов |
| `CMC_CREDITS_LEFT` | Подтверждённый остаток 0…`CMC_MONTHLY_LIMIT` |
| `CMC_RESET_AT` | Календарно корректное ISO 8601 с часовым поясом; для bootstrap новой БД — будущий момент сброса |
| `CMC_RATE_LIMIT_MINUTE` | Подтверждённый положительный лимит запросов в минуту |
| `CMC_REQUESTS_LEFT` | Подтверждённый остаток 0…`CMC_RATE_LIMIT_MINUTE` текущей UTC-минуты |
| `CMC_KEY_INFO_CREDITS` | Подтверждённая неотрицательная стоимость `/v1/key/info`; нулевая стоимость не предполагается |

Все числовые настройки — безопасные целые числа, без дробей/знаков. Не задавайте отсутствующие необязательные значения пустыми строками: либо задайте корректное значение, либо уберите переменную.

### Квота и фон

Для **первого внешнего обращения**, включая служебную сверку, нужна полная подтверждённая bootstrap-квота: месячный лимит/остаток/будущий reset и минутный лимит/остаток. Возьмите эти значения из сведений своего ключа/тарифа; в проекте нет выдуманного стартового бюджета. При неполной или истёкшей квоте новой БД сервис запускается, локальные чтения доступны, внешние запросы возвращают `502 CMC_API_ERROR`. Пустой список актуальных цен возвращает `[]` без внешнего обращения.

При заданной проверенной `CMC_KEY_INFO_CREDITS` сервис сверяется с официальным `/v1/key/info` перед первым внешним запросом после старта, после throttling и при месячном сбросе. Без этой стоимости служебных запросов нет: используется только полная проверенная конфигурация; новый месячный период автоматически не придумывается. Поля ответа поставщика дополняются конфигурацией только при их отсутствии. Старый bootstrap timestamp допустим при рестарте с уже сохранённой актуальной квотой.

POST/PUT, клиентские цены, фон и служебная сверка расходуют **один бюджет**. Резерв сохраняется в SQLite до HTTP-запроса; валидный `status.credit_count` корректирует его, сетевой сбой без подтверждённого расхода оставляет резерв потраченным. Рестарт не восстанавливает остаток из окружения. Минутный остаток обновляется по UTC-минутам; после 429 соблюдается доступный валидный `Retry-After`. При месячном сбросе новые котировки требуют подтверждённого будущего reset, а не календарного предположения.

Фон читает текущий список из БД, не накладывает циклы и сохраняет успешные пакеты даже при сбое другого пакета. Интервал распределяет доступные целые циклы по оставшемуся периоду, учитывает размер списка, стоимость пакетов, минутный лимит и период источника. Для клиента сохраняется резерв одного кредита/минутного запроса; активный клиентский запрос блокирует новые фоновые обращения. Бесконечный клиентский трафик может исчерпать бюджет. Другие потребители того же CMC-ключа учитываются при официальной сверке, не в реальном времени.

SIGINT/SIGTERM прекращает расписание и новые операции, отменяет provider I/O, завершает учёт расхода, закрывает HTTP и БД. Нормальное завершение — код 0; превышение срока остановки — код 1. В библиотечном HTTP-приложении новые запросы после начала остановки получают `503 STOPPING`; в работающем процессе HTTP-соединения закрываются.

## API

Все `/api`-маршруты требуют точный заголовок `Authorization: Bearer <API_TOKEN>`. Формат ошибок:

```json
{"error":{"code":"UNAUTHORIZED","message":"Authentication required"}}
```

| Метод | Путь | Успех |
| --- | --- | --- |
| POST | `/api/tracked-cryptocurrencies` | `201`, новая запись отслеживания |
| GET | `/api/tracked-cryptocurrencies` | `200`, массив записей |
| GET | `/api/tracked-cryptocurrencies/{id}` | `200`, запись |
| PUT | `/api/tracked-cryptocurrencies/{id}` | `200`, замена монеты в той же записи |
| DELETE | `/api/tracked-cryptocurrencies/{id}` | `204`, без тела; история остаётся |
| GET | `/api/tracked-cryptocurrencies/{id}/price` | `200`, новая котировка и запись истории |
| GET | `/api/prices` | `200`, новые котировки всего списка, без пагинации |
| GET | `/api/cryptocurrencies/{cmcId}/history` | `200`, сохранённая история даже после удаления отслеживания |

POST и PUT принимают строго `{"cmcId":1}`. ID — положительные безопасные целые ≤ 9007199254740991; ID пути — десятичные цифры без ведущего нуля. Запись отслеживания, CMC ID и ID наблюдения — **разные идентификаторы**. Символ/название приходят от поставщика; клиент не задаёт цену, валюту или `enabled`.

Запись отслеживания:

```json
{"id":1,"cmcId":1,"symbol":"BTC","name":"Bitcoin","lastUpdatedAt":"2025-01-15T12:00:01.000Z"}
```

`lastUpdatedAt` — время последнего успешного получения сервисом; `null`, если наблюдений ещё нет (например, старый каталог). Котировка/элемент истории:

```json
{"id":1,"cmcId":1,"symbol":"BTC","name":"Bitcoin","price":67100,"currency":"USD","fetchedAt":"2025-01-15T12:00:01.000Z","providerUpdatedAt":"2025-01-15T12:00:00.000Z"}
```

Цены конечные и неотрицательные; примеры условные, не текущие рыночные данные. `fetchedAt` — UTC-время получения сервисом, `providerUpdatedAt` — дата USD-котировки у поставщика, которая может иметь явное смещение часового пояса.

- Список и история: `limit` по умолчанию 50, диапазон 1–100; `offset` по умолчанию 0, неотрицательное безопасное целое. Ответ — массив без total/обёртки. Список сортируется по tracking ID.
- История: дополнительные `from` и `to`, календарно корректные ISO-даты со временем, секундами и обязательным `Z`/`±HH:MM`; `from <= to`. Границы по `fetchedAt` включительные. Сортировка по `fetchedAt`, затем ID наблюдения, потом пагинация. Известная локальная монета без наблюдений возвращает `[]`; отсутствующая в локальном каталоге — 404.
- Другие query-поля, повторные/структурированные query-значения и лишние поля тела запрещены. GET одной записи/цен и мутации не принимают query. GET/HEAD/DELETE под `/api` не принимают тело: положительный Content-Length или любой Transfer-Encoding дают `400 INVALID_BODY` независимо от Content-Type. DELETE без тела остаётся `204`. JSON-тело POST/PUT ограничено 16 KiB.
- Замена BTC на ETH сохраняет историю BTC отдельно; DELETE также её не удаляет. Повторное добавление продолжает историю монеты с новым tracking ID. PUT той же монеты получает новую котировку. Устаревший результат запроса после удаления/замены записи не сохраняется.
- Актуальные цены — **новый запрос** `/v3/cryptocurrency/quotes/latest` с CMC ID и `convert=USD`, без скрытого fallback к сохранённым ценам. Полный клиентский набор сохраняется атомарно; неполный ответ не выдаётся за успех.
- Публичны `/docs`, `/openapi.json` и только три `/docs/assets/{asset}`: `swagger-ui.css`, `swagger-ui-bundle.js`, `swagger-ui-standalone-preset.js`. Нет произвольного static-каталога. Query документации запрещён.
- GET-маршруты также поддерживают HEAD с теми же статусами/заголовками без тела. Совпадающий `If-None-Match` может вернуть bodyless 304; Range для документации игнорируется, отдаётся полный ресурс. Конечный `/` допускается. Неизвестные пути/методы — JSON 404, а под `/api` сначала проверяется Bearer.

### Примеры запросов

Подставьте свой токен в окружение текущей оболочки, не ключ CoinMarketCap. Эти команды обращаются к запущенному сервису; операции с ценами расходуют квоту поставщика.

```sh
export API_TOKEN='<ваш токен собственного API>'
curl --progress-bar http://localhost:3000/api/tracked-cryptocurrencies \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  --data '{"cmcId":1}'
curl --progress-bar 'http://localhost:3000/api/tracked-cryptocurrencies?limit=10&offset=0' \
  -H "Authorization: Bearer $API_TOKEN"
# Используйте id записи, полученный при создании; ниже условно 1.
curl --progress-bar http://localhost:3000/api/tracked-cryptocurrencies/1/price \
  -H "Authorization: Bearer $API_TOKEN"
curl --progress-bar http://localhost:3000/api/prices -H "Authorization: Bearer $API_TOKEN"
curl --progress-bar http://localhost:3000/api/tracked-cryptocurrencies/1 \
  -X PUT -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  --data '{"cmcId":1027}'
curl --progress-bar http://localhost:3000/api/tracked-cryptocurrencies/1 \
  -X DELETE -H "Authorization: Bearer $API_TOKEN"
curl --progress-bar -G http://localhost:3000/api/cryptocurrencies/1/history \
  -H "Authorization: Bearer $API_TOKEN" \
  --data-urlencode 'from=2025-01-01T00:00:00Z' --data-urlencode 'to=2025-02-01T00:00:00Z' \
  --data-urlencode 'limit=10' --data-urlencode 'offset=0'
```

### Ошибки

| Статус | Машинные коды |
| --- | --- |
| 400 | `INVALID_JSON`, `INVALID_BODY`, `INVALID_QUERY`, `INVALID_CMC_ID`, `INVALID_TRACKING_ID`, `CMC_ID_NOT_FOUND` (POST/PUT) |
| 401 | `UNAUTHORIZED`: нет токена, неверный токен или формат |
| 404 | `TRACKING_NOT_FOUND`, `CRYPTOCURRENCY_NOT_FOUND`, `NOT_FOUND` |
| 409 | `ALREADY_TRACKED`, `TRACKING_CHANGED` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 500 | `INTERNAL_ERROR` |
| 502 | `CMC_API_ERROR`: ошибка поставщика/соединения/формата/квоты; не ошибка Bearer собственного API |
| 503 | `STOPPING` |
| 504 | `CMC_TIMEOUT` |

Сообщения безопасные, без SQL, stack trace, секретов и необработанного ответа поставщика. Подробные параметры/схемы и статусы каждой операции — в [явном OpenAPI](src/openapi.ts), доступном по `/openapi.json`; Swagger описывает и служебные пути документации.

## Docker Compose

Нужны Docker daemon и Compose v2. Production Compose содержит **только API**, без отдельной БД/поставщика. Укажите файл окружения явно:

```sh
cp .env.example .env
# Задайте оба секрета и проверенную квоту.
docker compose --env-file .env up --build -d
docker compose --env-file .env logs -f api
docker compose --env-file .env restart api
docker compose --env-file .env down
```

Образ собирает TypeScript, устанавливает только production-зависимости и запускает `node dist/main.js` **непосредственно как PID 1**, от пользователя `node`. Host `dist` не нужен. Node получает SIGTERM без npm/shell-обёртки. Compose передаёт все настройки выше (SQLite path фиксирован внутри контейнера). Порт контейнера и опубликованный порт задаёт `PORT`. Grace period 125 секунд превышает максимальный разрешённый shutdown timeout 120 секунд.

SQLite живёт в именованном томе `sqlite-data` проекта Compose, включая служебные файлы БД и расход квоты. `restart` и `down` сохраняют том. **`down --volumes` удаляет данные**; не используйте его для обычной остановки. Для резервной копии остановите сервис и копируйте содержимое тома; не копируйте только основной SQLite-файл во время записи. `.dockerignore` исключает окружение/БД/локальные сборки из контекста, а Dockerfile не копирует их в образ. Секреты передаются при запуске, не при сборке; не публикуйте вывод `docker compose config` с реальным окружением.

## Воспроизводимые проверки без настоящего CoinMarketCap

```sh
mise exec node@24 -- npm ci
mise exec node@24 -- npm run build
mise exec node@24 -- npm test
# Только документация и соответствие схем ответам:
mise exec node@24 -- npm test -- --runTestsByPath test/docs-api.test.cjs test/openapi-contract.test.cjs
```

Jest проверяет собранный код без TypeScript-трансформера. HTTP-тесты: Supertest, настоящая временная SQLite на диске и локальный fake CMC; фон/квота — управляемое время; сигналы/локальный запуск — дочерние процессы с конечным ожиданием. Для всех опубликованных методов/путей, включая docs/assets и HEAD, есть позитивные и негативные проверки. HTTP-ответы сопоставляются с полученными по HTTP OpenAPI-схемами без дополнительных validator-пакетов. Нет настоящих ключей/платных запросов и `--forceExit`.

Чтобы ограничить время всего тестового процесса на любой машине со стандартным Python 3:

```sh
python3 - <<'PY'
import os, signal, subprocess
p = subprocess.Popen(['mise', 'exec', 'node@24', '--', 'npm', 'test'], start_new_session=True)
try:
    raise SystemExit(p.wait(timeout=60))
except subprocess.TimeoutExpired:
    os.killpg(p.pid, signal.SIGTERM)
    try:
        p.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        p.wait(timeout=2)
    raise SystemExit('Тесты превысили 60 секунд')
PY
```

В среде реализации также доступен `python3 /private/tmp/evercode-run-bounded.py 60 mise exec node@24 -- npm test`; этот внешний helper не является файлом проекта и не требуется для обычного запуска.

### Контейнерный smoke

```sh
python3 scripts/docker-smoke.py
```

Нужны Python 3 (только стандартная библиотека), Docker и доступ к registry/npm для сборки. Скрипт использует уникальный Compose project, отдельный временный fake env с явным `--env-file`, loopback fake CMC **внутри тестового контейнера**, не ослабляет URL-валидацию и не читает реальный `.env`. Проверяет передачу окружения, image/context без секретов/БД, PID1, защищённый CRUD/цены/историю, сохранение данных/расхода после restart и SIGTERM с кодом 0. Сборки ограничены 180 секундами, остальные Docker-команды 30–60 секундами, ожидания имеют дедлайн. В `finally` удаляет только собственные контейнеры, том, тестовые образы и временные fixtures. Это проверка, **не второй production-сервис**. Если загрузка base image недоступна, smoke завершается ошибкой, а не считается пройденным.

### Зависимости и audit

Прямые production-зависимости: `express`, `axios`, `swagger-ui-dist`; dev: `typescript`, `jest`, `supertest`. Нет `@types`, Swagger Express wrapper, ORM, стороннего SQLite-драйвера, dotenv или validator-библиотек. Install-time аналитика транзитивного Scarf отключена через `scarfSettings.enabled=false`.

```sh
mise exec node@24 -- npm audit --omit=dev
mise exec node@24 -- npm audit
```

На финальной проверке #7 production audit: **0 уязвимостей**. Полный audit: **19 moderate** в dev-цепочке Jest → argparse → sprintf-js; опубликованная актуальная версия sprintf-js всё ещё затронута advisory. Это не production finding. Не применять `npm audit fix --force`: предлагаемый downgrade Jest не является безопасным исправлением. Результат audit зависит от актуального registry; повторяйте проверку отдельно от тестов.

Предметная терминология: [GLOSSARY.md](GLOSSARY.md). Требования: [GitHub #1](https://github.com/GitHubFoxy/evercode-fast-track-test-backend/issues/1). Официальные контракты: [CMC quotes latest v3](https://pro.coinmarketcap.com/api/documentation/pro-api-reference/cryptocurrency/quotes-latest.md), [key/info](https://pro.coinmarketcap.com/api/documentation/pro-api-reference/tools/key-info.md).
