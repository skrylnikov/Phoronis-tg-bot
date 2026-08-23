# langfuse-observability Specification

## Purpose

Это capability фиксирует наблюдаемость AI-генераций после перехода на актуальный JS/TS SDK Langfuse: корреляцию, безопасные метаданные, устойчивость runtime и доставку накопленных trace при завершении процесса.

## Requirements

### Requirement: AI-генерации имеют коррелируемые Langfuse observations

Система MUST создавать observation для каждой persisted chat- и guest-generation, если генерация не отключила сохранение ответа. Observation MUST сохранять существующие имена операций `chat-generation` и `guest-generation`, а также корреляционные значения `sessionId` и `userId`, когда они доступны. Guest generation MUST использовать собственный идентификатор guest-запроса как `sessionId`.

#### Scenario: Обычная chat-generation создаёт trace

- **WHEN** обычный AI-запрос успешно проходит через генерацию с включённым сохранением ответа
- **THEN** в Langfuse появляется observation с именем `chat-generation`, `sessionId` текущего AI-треда и `userId` отправителя, если Telegram передал пользователя

#### Scenario: Guest-generation сохраняет собственную корреляцию

- **WHEN** guest-запрос получает AI-ответ с включённым tracing
- **THEN** observation имеет имя `guest-generation` и связывается с guest query id, не подменяя его session id обычного чата

#### Scenario: Генерация без persistence не создаёт обязательный trace

- **WHEN** вызывающий путь явно отключает сохранение ответа
- **THEN** пользовательский ответ продолжает формироваться без требования создать persisted Langfuse observation

### Requirement: Telemetry не раскрывает приватный контекст

Система MUST передавать в observation только агрегированные и безопасные telemetry-поля, необходимые для диагностики генерации: количество и размер сообщений, длительность, размеры результата, границу cache-контекста, версию или hash локального prompt и значения доступности provider cache. Система MUST NOT записывать в telemetry metadata полный prompt, полный пользовательский контекст, историю сообщений, ответ модели, секретные ключи или иные приватные payload только ради наблюдаемости.

#### Scenario: В trace попадает безопасная статистика

- **WHEN** chat-generation завершается
- **THEN** observation содержит latency и агрегированные размеры/счётчики из текущего telemetry-контракта, но не содержит полный текст system instructions или истории диалога

#### Scenario: Приватные данные не попадают в metadata

- **WHEN** контекст содержит имена пользователей, память, результаты поиска или сообщение пользователя
- **THEN** эти значения не сериализуются целиком в Langfuse metadata

### Requirement: Ошибка Langfuse не ломает AI-ответ

Система MUST рассматривать недоступность или ошибку отправки telemetry как non-fatal для обработки Telegram update. Ошибка tracing MUST быть залогирована с техническим контекстом без секретов, а генерация и сохранение пользовательского ответа MUST продолжаться по основному пути, если сама AI-операция не завершилась ошибкой.

#### Scenario: Langfuse недоступен во время ответа

- **WHEN** отправка observation завершается сетевой ошибкой или Langfuse временно недоступен
- **THEN** пользователь получает обычный AI-ответ, ошибка tracing логируется, а обработчик update не падает только из-за Langfuse

### Requirement: Runtime корректно применяет конфигурацию Langfuse

Система MUST использовать `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` и `LANGFUSE_BASE_URL` для подключения к настроенному Langfuse endpoint. Если задано `LANGFUSE_TRACING_ENVIRONMENT`, observations MUST получать это окружение. Legacy-настройка окружения MUST NOT silently override поддерживаемое v5-значение.

#### Scenario: Self-hosted endpoint получает trace

- **WHEN** приложение запускается с ключами и `LANGFUSE_BASE_URL` self-hosted инсталляции
- **THEN** observation отправляется на заданный endpoint, а не на cloud endpoint по умолчанию

#### Scenario: Environment отделён от старого имени переменной

- **WHEN** задано `LANGFUSE_TRACING_ENVIRONMENT`
- **THEN** новое значение используется в observations независимо от наличия устаревшего `LANGFUSE_ENVIRONMENT`

### Requirement: Graceful shutdown не теряет буферизованные observations

При штатном завершении процесса система MUST остановить приём новых операций tracing и дождаться flush/shutdown telemetry-провайдера в пределах существующего shutdown budget. Ошибка flush MUST логироваться и MUST NOT блокировать завершение остальных runtime-компонентов.

#### Scenario: SIGTERM после AI-ответа

- **WHEN** процесс получает SIGTERM после создания observation, но до автоматической отправки буфера
- **THEN** shutdown вызывает flush/shutdown telemetry-провайдера до завершения процесса и пытается доставить observation

#### Scenario: Flush не отвечает

- **WHEN** telemetry-провайдер не завершает flush в установленный budget
- **THEN** система логирует timeout/error, продолжает graceful shutdown остальных компонентов и завершает процесс без бесконечного ожидания

### Requirement: Пользовательское поведение не зависит от смены SDK

Переход на актуальный SDK MUST NOT возвращать runtime-загрузку prompt management или изменять порядок/содержимое локальных AI-промптов, Telegram-ответов, квот и правил приватности. Изменение формата Langfuse observations допустимо только внутри внешней системы наблюдаемости.

#### Scenario: Локальный prompt остаётся единственным runtime-источником

- **WHEN** chat, voice или image AI-путь формирует запрос после миграции
- **THEN** он использует локальный prompt registry и не требует получения prompt из Langfuse

#### Scenario: Обновление tracing не меняет ответ бота

- **WHEN** один и тот же AI-запрос выполняется до и после миграции при доступном LLM-провайдере
- **THEN** формат Telegram-ответа, квотирование и privacy-ограничения остаются прежними, кроме разрешённых изменений telemetry
