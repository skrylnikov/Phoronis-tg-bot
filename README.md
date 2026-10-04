# Phoronis Telegram Bot

A sophisticated Telegram bot with AI capabilities, context awareness, and user behavior tracking.

## Improvements Made

### 1. Enhanced Error Handling
- Added `handleError` utility function for consistent error logging
- Added `isTelegramError` type guard for better error identification
- Improved error handling throughout the application with better context information

### 2. Better Type Safety
- Added proper TypeScript types to all functions
- Improved type definitions for database models and API responses
- Enhanced type safety in message processing

### 3. Robust Database Operations
- Added try-catch blocks around database operations
- Added error handling to saveChat, saveUser, and saveMessage functions
- Better caching with error recovery

### 4. Testing Framework Setup
- Added vitest as dev dependency
- Created basic test structure for error handling utilities
- Prepared foundation for comprehensive unit testing

## Architecture

### Core Components
- **Telegram Integration**: Grammy.js framework for Telegram API
- **Database**: PostgreSQL with Prisma ORM
- **AI Services**: RouterAI via the Vercel AI SDK with Gemini models
- **Context Management**: PostgreSQL with pgvector and local multilingual embeddings
- **Observability**: Langfuse for prompt management and tracing

### Code Structure
```
src/
├── controllers/       - Bot message handlers and route logic
├── ai/              - AI/LLM integration (AI SDK, RouterAI, TEI)
├── tools/           - Utility functions organized by domain
├── features/        - Feature implementations (selfie-saturday, etc.)
├── shared/          - Shared utilities and helpers
├── generated/prisma/ - Generated Prisma client
├── bot.ts           - Bot initialization and context type
├── db.ts            - Prisma client export
├── config.ts        - Environment configuration and validation
├── logger.ts        - Pino logger instance
├── scheduler.ts     - Cron job scheduler
└── index.ts         - Application entry point
```

## Development

### Running the Bot
```bash
# Install dependencies
bun install

# Run in development mode with auto-reload
bun run dev

# Run in production mode
bun run start

# Run type checking
bun run typecheck

# Run linter
bun run lint
```

### Testing
```bash
# Run the unit test suite
bun run test
```

## Configuration

Create a `.env` file with the following variables:
```
TOKEN=your_telegram_bot_token
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/phoronis
BOT_MODE=polling
WEBHOOK_URL=
WEBHOOK_SECRET=
OPEN_WEATHER_TOKEN=your_openweather_token
YANDEX_CLOUD_TOKEN=your_yandex_cloud_token
YANDEX_S3_ID=your_yandex_s3_id
YANDEX_S3_SECRET=your_yandex_s3_secret
ROUTERAI_API_KEY=your_routerai_key
PAYMENT_SUPPORT_CONTACT=@your_support_username
ANALYTICS_CHAT_ID=your_private_telegram_chat_id
EMBEDDING_BASE_URL=http://localhost:3001
EMBEDDING_MODEL=intfloat/multilingual-e5-small
EMBEDDING_VERSION=1
EMBEDDING_TIMEOUT_MS=2000
LANGFUSE_SECRET_KEY=your_langfuse_secret_key
LANGFUSE_PUBLIC_KEY=your_langfuse_public_key
QUEUE_NORMAL_WORKERS=3
JOB_WORKERS=1
SHUTDOWN_DRAIN_MS=30000
```

Local development uses long polling with `BOT_MODE=polling`. Use a separate
Telegram bot token for local development: Telegram cannot deliver updates for
the same token through both polling and a webhook at the same time. Production
uses `BOT_MODE=webhook`, `WEBHOOK_URL`, and `WEBHOOK_SECRET`.

## Features

- RouterAI-powered responses with context awareness
- User behavior tracking and fact analysis
- Memory management tools
- Image recognition and description
- Custom greeting settings for chats
- Private mode support
- Guest Mode support for answering mentions in chats where the bot isn't a member
- Media handling (photos, videos)

Guest Mode must also be enabled in the bot settings through BotFather's MiniApp.

## Проверка фактов и псевдонимов Jev

Извлечение кандидатов выполняет существующая utility LLM. Перед сохранением Jev проверяет поддержку факта исходным публичным сообщением, принадлежность псевдонима и отдельно пригодность обращения. Пары похожих фактов проверяются на дубликат, противоречие, независимость или недостаток данных. Используется `typesafe/jev-1.13` через RouterAI `/api/v1/decisions` с существующим `ROUTERAI_API_KEY`; новый SDK не требуется.

Текущая политика (`decisionPolicyVersion = 2`): принимать при вероятности >= 0.8, отклонять при <= 0.1, промежуточные результаты пропускать как `uncertain`. Порог 0.8 применяется к поддержке факта, выбранному отношению фактов, принадлежности alias и оценке пригодности обращения. Накопленный рейтинг alias для автоматического обращения по-прежнему должен быть >= 0.9 с минимум двумя авторами; для подтверждения связи/поиска — >= 0.8 с двумя авторами. Исторические DecisionReview сохраняют свою версию и исходные пороги. Для Choice используется вероятность выбранного отношения, а не метрика `confidence`. Ошибка провайдера оставляет анализ доступным для повторной фоновой обработки и не подтверждает непроверенный кандидат. Вероятности пока не оценены на реальной русской переписке; проверка устанавливает соответствие источнику, а не объективную истинность заявления.

После миграции и запуска обновлённого бота `DecisionReview` хранит принятые, отклонённые, неуверенные и ошибочные решения семь дней. Журнал содержит кандидат, оценки, версию правил, фактическую модель, исходные ID, попытку (`runId`) и действие; исходная переписка не копируется. Для сравнения фактов сохраняется прежнее утверждение. Удаление исходного сообщения или целевого пользователя каскадно удаляет журнал. Почасовая задача очищает устаревшие записи; отчёт сразу исключает данные старше семи дней и непубличные источники.

Отчёт за последние три дня:

```bash
bun run jev:report -- --days 3 --limit 30
bun run jev:report -- --days 3 --chat-id=-1001234567890 --json > /tmp/jev-review.json
```

Команда читает БД из `DATABASE_URL`, дополнительных bot/provider credentials для отчёта не требуется. `--days` допускает 1–7, `--limit` — 1–200. По умолчанию сначала показываются отклонённые, неуверенные и незавершённые проверки; при оставшемся лимите — принятые. В JSON есть `groups`, `latency` и `examples`. Отчёт содержит пользовательские сведения и предназначен для локального операторского разбора, не для публикации.

На работающем Kubernetes deployment после разрешённого rollout команда запускается внутри контейнера с его подключением к БД:

```bash
kubectl -n phoronis exec deploy/phoronis -c bot -- bun run jev:report -- --days 3 --limit 30
```

Для ручной проверки сравнивай `candidate` с `source.text`, публичным reply и `comparison`: не превратилась ли мечта в факт, сведения о родственнике в сведения об авторе, упоминание третьего лица в псевдоним адресата, разные периоды жизни в противоречие. Проверяй и отклонённые кандидаты — высокий процент принятия сам по себе не означает хорошую точность.

Технические события `jev.request_completed`, `jev.request_failed`, `jev.decision`, `jev.action` не содержат текста кандидата/сообщения или секретов. `jev.review_write_failed` / `jev.review_update_failed` означают пробел в журнале; их ошибки не ломают основную обработку. `pending` означает, что применение решения ещё не завершилось; `already_applied` — что evidence ранее зачтён. Задержки в отчёте относятся к оценкам; несколько записей пакетной проверки разделяют одну задержку.

### Трейсы AI в Langfuse

Ответы chat/guest содержат root `chat-generation`/`guest-generation` с фактическими instructions и упорядоченными messages, итоговым текстом до Telegram-форматирования и correlation metadata. Вложенные LLM-вызовы записываются как `GENERATION`, tools — как `TOOL`; model/provider, параметры, finish reason, TTFT и доступный provider usage видны на соответствующем вызове. Usage учитывается только на реальных model calls; недоступный cache usage обозначается `unavailable`, стоимость определяется Langfuse только при наличии достоверного pricing.

Для private mode содержимое исключается из root, trace и всех children, включая tool arguments/results и exception events; остаются технические метрики. В обычных запросах диагностические копии очищаются от credentials, известных runtime secrets, signed URLs и бинарных вложений. Input/output ограничены 128 KiB UTF-8 с `truncated`, `originalBytes` и preview. Media upload отключён. Отмена/ошибка отмечается в trace, уже полученный обычный partial output сохраняется.

Интеграция применяется только к traced chat/guest: `/ask`, vision, voice, compaction и фоновые AI-вызовы сохраняют прежний tracing scope. Экспорт пакетный; shutdown пытается выгрузить spans в существующий drain budget. Исторические пустые traces автоматически не восстанавливаются.


## Восстановление анализа сообщений и обращения

Новая `USER_MESSAGE_ANALYSIS` закрепляет до 30 публичных сообщений автора по ID при постановке в очередь (`windowVersion: 1`, `baseMessageIds`, `cutoffAt`). Граница совпадает с исходным `createdAt`. Legacy-задача восстанавливает последние 30 сообщений до этой даты, с порядком `sentAt DESC, id DESC`, и сохраняет ID под действующим lease перед AI. Это приближение: удалённые и поздно доставленные источники нельзя восстановить точно. Закреплённые сообщения, которые удалены или стали private, исключаются без замены свежими. Пустое окно завершается с `skipped_no_sources` без квоты и AI.

Один уровень публичных родителей и входящих replies того же чата до cutoff дополняет окно. Сначала выбираются родители, затем replies по времени и ID; максимум 60 дополнительных сообщений и 24 000 символов, усечение целыми сообщениями с `repliesTruncated`. Основное окно сохраняется. Дополнительные ID закрепляются перед моделью и не расширяются при retry. Бот/private/чужие чаты/поздние replies исключаются. Prompt содержит фактические ID, авторов, `REPLY_TO_MESSAGE_ID` и `RELATION`. Источники обычных facts — только base-сообщения автора; alias evidence может ссылаться на реальный входящий reply. Summary не заменяет исходный текст при его наличии.

Попытка анализа ограничена 180 секундами, extraction — 60, verification/fact relation/persistence — 30; TEI использует штатный timeout. Внутренний retry extraction отключён: повтором управляет очередь. Events `user_analysis.stage_completed`, `user_analysis.stage_failed`, `user_analysis.window_prepared` содержат job/attempt/run, этап, модель, количество/длительность и безопасную категорию ошибки без source/prompt/ключей. Причины jobs выглядят как `analysis:extraction:timeout`. Некорректный payload и постоянные HTTP 400/401/403/404/405/422 завершают analysis без бессмысленных повторов; timeout/429/5xx используют обычный ограниченный retry. Lease loss/shutdown передаются во внутренние вызовы; после отмены новые мутации не начинаются. Начатая DB-операция может завершиться, поэтому evidence и создание фактов идемпотентны. Нехватка квоты возвращает `quota_deferred`: job остаётся PENDING до следующей полуночи Europe/Moscow, error-attempt не расходуется. Ошибки после резервирования возвращают ANALYSIS-квоту.

Историческое противоречие сравнивается с accepted evidence по `(sentAt, chatId, messageId)` внутри транзакции с блокировкой пользователя. `updatedAt` — время обработки, не время утверждения. Старый источник даёт `skipped_stale_source`, недоступный порядок — `skipped_unknown_source_order`; content, embedding и weight сохраняются. Новый content и embedding записываются атомарно. Повтор одного source/content/type не создаёт новый факт, независимые сведения того же источника сохраняются отдельно. Автоматические aliases не отменяют owner preferences/blocks/rejections.

### Команда оператора

```sh
bun run analysis:retry --help
bun run analysis:retry --chat-id=-1001005702961 --user-id=6919991193 --limit=1
# После проверки preview и отдельного разрешения на production replay:
bun run analysis:retry --chat-id=-1001005702961 --user-id=6919991193 --limit=1 --apply
```

Без `--apply` команда только читает БД и выводит JSON preview: task IDs, original createdAt/cutoff, legacy approximation, доступные base/reply counts, усечение, техническую категорию ошибки. `TOKEN` позволяет исключить bot ID из preview; без него `botFilterApplied: false` и reply counts приблизительны. Поддерживаются `--from`/`--to` с ISO timestamp и часовым поясом, `--limit` 1..100 (по умолчанию 10). Чат обязателен, AI не вызывается.

Применение условно возвращает только выбранные FAILED USER_MESSAGE_ANALYSIS в PENDING от старых к новым; ID/dedupeKey/createdAt/окно сохраняются, attempts нового цикла обнуляются. Bounded `payload.replay` хранит счётчик, предыдущие attempts/категорию и дату последнего replay. Гонка с другой командой пропускает изменившуюся строку. Payments/COMPLETED/PROCESSING не переигрываются.

Runbook: проверить текущий image/миграции/health → dry-run выбранного чата и одного пользователя с limit=1 → проверить источники и доступную квоту → применить одну задачу → проверить `COMPLETED`/outcome, stage latency, реальные evidence source IDs и состояние aliases → только затем расширить разрешённую выборку. Для отката приложения сохранить queue/evidence и вернуть предыдущий image; прежний worker читает плавающее окно, поэтому replay при rollback не запускать. Эта команда не удаляет данные и не обходит квоту.

### Контракт aliases

Код обрабатывает самостоятельные «называй/зови меня …», «не называй/зови меня …», «… не мой псевдоним» после штатной адресации боту. Поддерживаются префикс «Ио» и mention текущего бота. Отображаемый регистр сохраняется; quotes/forward/guest/read-only не изменяют aliases. Tool проверяет тот же original request и не может подменить «Саша» на сохранённый «Шурик». Для известных aliases допустимы однозначные формы вроде «Шуриком → Шурик»; неизвестные/неоднозначные формы при исправлении сохранённого имени требуют уточнения без записи. Новое дословное имя в prefer сохраняется после валидации. Результаты: `applied`, `already_applied`, `superseded`, ошибка. Короткое подтверждение формируется из фактической операции без вызова модели.

`aliasContext` одинаков для обычного/guest/fallback/read-only контекста и `get_user_info` после его membership/privacy checks:

- `chatId`, `userId` определяют область;
- `addressing: string | null` уже выбрано кодом; null — ответ без имени;
- `identityAliases` содержит только подтверждённые связи, включая запрещённые для обращения;
- `blockedAddressingAliases` запрещены как обращение;
- `rejectedIdentityAliases` отклонены как принадлежность.

Confidence/CANDIDATE/preferred/ranking модели не передаются. Preferred → подходящий автоматический alias → допустимый firstName → допустимый username → null. Профильные fallback проверяются против запретов по нормализованному имени. Старые события не переписываются: свежая схема добавляется очередным контекстным событием. Compaction сохраняет хронологию повторных состояний A → B → A → B; имя из summary не меняет structured state.
