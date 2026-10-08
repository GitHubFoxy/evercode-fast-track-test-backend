# Evercode Fast Track — backend

REST API для отслеживания цен криптовалют через CoinMarketCap: список отслеживаемых монет (CRUD), актуальные цены, история в SQLite и фоновое обновление. Все цены в USD.

**Стек:** Node.js ≥ 22.5, Express 5, TypeScript (strict), axios, встроенный `node:sqlite` (raw SQL, без ORM), Jest + Supertest, OpenAPI 3.0 + Swagger UI, Docker Compose.

> **Почему Node ≥ 22.5, а не 18.** Модуль `node:sqlite` появился в Node 22.5. Он позволяет работать с SQLite без ORM и без нативных npm-зависимостей (`sqlite3`, `better-sqlite3`), то есть остаться в рамках разрешённых библиотек. Версия закреплена в `engines`. Подробности: [ADR 0001](docs/adr/0001-node-sqlite.md).

## Быстрый старт

Нужны только два секрета. Квоту CoinMarketCap указывать не обязательно.

```sh
npm ci
cp .env.example .env      # впишите API_TOKEN и COINMARKETCAP_API_KEY
npm start                 # сначала собирает TypeScript, затем запускает сервис
```

- API: `http://localhost:3000/api/...`
- Swagger UI: `http://localhost:3000/docs`
- OpenAPI 3.0: `http://localhost:3000/openapi.json`

В Swagger нажмите **Authorize** и введите значение `API_TOKEN` (без `Bearer`). Ключ CoinMarketCap уходит только на сервер CMC и клиенту не передаётся.

### Docker

```sh
cp .env.example .env      # впишите оба секрета
docker compose --env-file .env up --build -d
docker compose --env-file .env logs -f api
docker compose --env-file .env down      # данные сохраняются в томе
```

SQLite лежит в именованном томе `sqlite-data`. `docker compose down --volumes` удаляет данные. База не попадает ни в репозиторий, ни в образ. Контейнер запускает `node dist/main.js` как PID 1 от пользователя `node`, поэтому SIGTERM доходит до приложения напрямую.

## Настройки (переменные окружения)

| Переменная | По умолчанию | Описание |
| --- | --- | --- |
| `API_TOKEN` | — (обязательна) | Секрет Bearer-аутентификации собственного API |
| `COINMARKETCAP_API_KEY` | — (обязательна) | Ключ CoinMarketCap; должен отличаться от `API_TOKEN` |
| `DATABASE_PATH` | — (обязательна) | Путь к файлу SQLite; `.env.example` задаёт `./data/evercode.sqlite` |
| `PORT` | `3000` | 1–65535 |
| `PRICE_CURRENCY` | `USD` | Допустимо только `USD` |
| `CMC_TIMEOUT_MS` | `10000` | Таймаут запроса к CMC, 1–120000 |
| `SYNC_INTERVAL_MS` | `60000` | Нижняя граница интервала фоновой синхронизации, 1000–86400000 (CMC обновляет данные раз в минуту, чаще 60 с сервис не опрашивает) |
| `CMC_BATCH_SIZE` | `250` | Размер пакета монет в одном запросе, 1–1000 |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Срок корректной остановки, 1–120000 |
| `CMC_BASE_URL` | `https://pro-api.coinmarketcap.com` | HTTPS либо HTTP только для loopback (для тестов) |

Значения проверяются при старте, до открытия порта. Неверные значения останавливают запуск с понятной ошибкой.

### Необязательный учёт квоты CMC

Без дополнительных переменных сервис не считает кредиты сам: лимиты применяет CoinMarketCap, а его отказы (например, 429) возвращаются как `502 CMC_API_ERROR`.

Если хотите, чтобы сервис сам распределял запросы фоновой синхронизации по месячной квоте, задайте **весь** набор проверенных значений своего тарифа: `CMC_MONTHLY_LIMIT`, `CMC_CREDITS_LEFT`, `CMC_RESET_AT` (ISO 8601 с часовым поясом), `CMC_RATE_LIMIT_MINUTE`, `CMC_REQUESTS_LEFT`. Дополнительно можно указать `CMC_KEY_INFO_CREDITS` (подтверждённая стоимость `/v1/key/info`), и тогда сервис будет сверять остаток с официальным ответом CMC. Неполный набор считается ошибкой конфигурации: внешние запросы отклоняются, локальные чтения работают. Остаток хранится в SQLite и после перезапуска не сбрасывается к значениям из окружения.

## API

Все маршруты `/api` требуют заголовок `Authorization: Bearer <API_TOKEN>`. Документация и схемы всех ответов — в [Swagger](http://localhost:3000/docs) и в [src/openapi.ts](src/openapi.ts).

| Метод | Путь | Успех | Назначение |
| --- | --- | --- | --- |
| POST | `/api/tracked-cryptocurrencies` | 201 | Начать отслеживание по `{"cmcId": 1}` (сразу сохраняется первая цена) |
| GET | `/api/tracked-cryptocurrencies` | 200 | Список (`limit` 1–100, по умолчанию 50, `offset`) |
| GET | `/api/tracked-cryptocurrencies/{id}` | 200 | Одна запись |
| PUT | `/api/tracked-cryptocurrencies/{id}` | 200 | Заменить монету в записи, `{"cmcId": 1027}` |
| DELETE | `/api/tracked-cryptocurrencies/{id}` | 204 | Удалить отслеживание (история сохраняется) |
| GET | `/api/tracked-cryptocurrencies/{id}/price` | 200 | Свежая цена одной монеты (запись в историю) |
| GET | `/api/prices` | 200 | Свежие цены всех отслеживаемых монет |
| GET | `/api/cryptocurrencies/{cmcId}/history` | 200 | История цен; фильтры `from`, `to` (ISO 8601), `limit`, `offset` |

Запись отслеживания: `{"id":1,"cmcId":1,"symbol":"BTC","name":"Bitcoin","lastUpdatedAt":"2025-01-15T12:00:01.000Z"}`

Элемент истории: `{"id":1,"cmcId":1,"symbol":"BTC","name":"Bitcoin","price":67100,"currency":"USD","fetchedAt":"2025-01-15T12:00:01.000Z","providerUpdatedAt":"2025-01-15T12:00:00.000Z"}`

Правила валидации: тело POST/PUT — строго `{"cmcId": <положительное целое>}` до 16 KiB; ID в пути — десятичные цифры без ведущего нуля; неизвестные query-параметры отклоняются; GET и DELETE не принимают тело.

Формат ошибок: `{"error":{"code":"...","message":"..."}}`

| Статус | Коды |
| --- | --- |
| 400 | `INVALID_JSON`, `INVALID_BODY`, `INVALID_QUERY`, `INVALID_CMC_ID`, `INVALID_TRACKING_ID`, `CMC_ID_NOT_FOUND` |
| 401 | `UNAUTHORIZED` |
| 404 | `TRACKING_NOT_FOUND`, `CRYPTOCURRENCY_NOT_FOUND`, `NOT_FOUND` |
| 409 | `ALREADY_TRACKED`, `TRACKING_CHANGED` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 500 | `INTERNAL_ERROR` |
| 502 / 504 | `CMC_API_ERROR` (ошибка, недоступность или неверный ответ CMC) / `CMC_TIMEOUT` |
| 503 | `STOPPING` (идёт остановка) |

Сообщения не содержат SQL, stack trace, секретов и сырых ответов CMC.

### Пример

```sh
export API_TOKEN='<ваш токен>'
curl --progress-bar http://localhost:3000/api/tracked-cryptocurrencies \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' --data '{"cmcId":1}'
curl --progress-bar http://localhost:3000/api/prices -H "Authorization: Bearer $API_TOKEN"
curl --progress-bar -G http://localhost:3000/api/cryptocurrencies/1/history \
  -H "Authorization: Bearer $API_TOKEN" --data-urlencode 'from=2025-01-01T00:00:00Z' --data-urlencode 'limit=10'
```

## Как это работает

- **Фоновое обновление.** Планировщик периодически читает список из БД, запрашивает цены пакетами и сохраняет историю. Циклы не накладываются, сбой одного пакета не отменяет остальные. Все запросы к CMC (клиентские и фоновые) идут через единый учёт расхода.
- **Ошибки внешнего API.** У каждого запроса есть таймаут, redirect-ы отключены. Ответ CMC строго проверяется. Сбой превращается в `502`/`504`, сохранённые цены подменой не выдаются.
- **Остановка.** SIGINT/SIGTERM останавливает расписание, отменяет текущие запросы к CMC, закрывает HTTP-сервер и БД. Код выхода 0; при превышении `SHUTDOWN_TIMEOUT_MS` — 1.
- **Один процесс.** БД принадлежит одному процессу или контейнеру. Несколько реплик с общим файлом SQLite не поддерживаются.

## Тесты

```sh
npm test            # сборка TypeScript + Jest (Supertest)
```

Тесты не обращаются к настоящему CoinMarketCap: используется локальный fake-сервер и временная SQLite на диске. Для каждого эндпоинта есть позитивные и негативные проверки. Отдельно покрыты фоновая синхронизация, квота, таймауты, ошибки CMC, сигналы SIGINT/SIGTERM, запуск через `npm start` и соответствие ответов схемам OpenAPI.

## Структура

```
src/app.ts            сборка Express-приложения, аутентификация, чтение данных
src/tracking.ts       PUT/DELETE записей отслеживания
src/prices.ts         свежие цены
src/coinmarketcap.ts  клиент CMC (axios), разбор и проверка ответов
src/budget.ts         учёт расхода внешнего API
src/scheduler.ts      фоновая синхронизация
src/database.ts       схема и raw SQL на node:sqlite
src/openapi.ts        OpenAPI 3.0, src/documentation.ts — Swagger UI
```

Терминология: [GLOSSARY.md](GLOSSARY.md). Решения: [docs/adr](docs/adr).
