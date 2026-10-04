# Spec Delta

## MODIFIED Requirements

### Requirement: Langfuse остаётся системой трейсинга

Система MUST продолжать создавать Langfuse traces для AI-генерации и связанных операций наблюдаемости. Runtime-код MUST NOT вызывать Langfuse prompt management для получения пяти перенесённых промптов. Трейсы MUST содержать идентификатор локальной версии промпта или её хеш и сведения о сборке контекста. Для диагностики неприватных chat/guest система MUST записывать очищенный фактический model input/output в специализированные поля observations по правилам `langfuse-observability`; полный приватный prompt и весь пользовательский текст MUST NOT записываться только ради метрик кеша, в cache metadata или обычные логи.

#### Scenario: Генерация ответа трассируется

- **WHEN** модель генерирует ответ после перехода на локальные промпты
- **THEN** trace создаётся как раньше и содержит безопасные метаданные локальной версии и cache boundary
- **AND** у неприватного chat/guest фактические инструкции, последовательность сообщений и ответ доступны в очищенных Input/Output

#### Scenario: Langfuse prompt management недоступен

- **WHEN** Langfuse prompt management недоступен, но сервис трейсинга доступен или отключён конфигурацией
- **THEN** voice, image, chat и meta-analysis не падают из-за невозможности получить prompt из Langfuse

#### Scenario: Диагностический снимок не меняет запрос модели

- **WHEN** tracing очищает секреты или ограничивает размер своего input/output
- **THEN** инструкции и append-only сообщения model call сохраняют исходное содержимое и порядок
- **AND** чтение данных для telemetry не расширяет scope памяти, retrieval или сведений о пользователях

#### Scenario: Текущий запрос выполнен в private mode

- **WHEN** chat/guest использует private mode с доступным контекстом и tools
- **THEN** root и дочерние observations сохраняют только технические метрики, без private payload в input/output, metadata и ошибках
