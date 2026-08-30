## MODIFIED Requirements

### Requirement: Обе стороны private-mode диалога сохраняются приватными

Система MUST сохранять с private-признаком как входящее пользовательское сообщение, так и связанный ответ бота для всех поддерживаемых типов сообщений private mode. Текущий private-запрос MUST использовать обычные durable thread context, public retrieval/vector search, recent public history, сохранённые memory/facts, поиск упомянутых пользователей и writable tools, включая `save_memory`. Context events текущего private-turn MUST быть связаны с private messages и MAY использоваться в текущем ответе, но MUST быть исключены из любого последующего AI context, embeddings, vector retrieval и recent history. Private-turn MUST NOT создавать compacted snapshot. Автоматический fact analysis private-сообщения MUST NOT запускаться, а явная запись через `save_memory` считается намеренным persistent действием пользователя. Private-сообщения и связанные events MUST удаляться действующей очисткой после семи суток.

#### Scenario: Бот отвечает в private mode

- **WHEN** пользователь отправляет текст, фото или голосовое сообщение в личном чате с включённым private mode и бот отвечает
- **THEN** входящее сообщение и сохранённый ответ бота имеют private-признак
- **AND** durable builder записывает связанные с ними user/assistant events для текущего turn
- **AND** следующий turn не получает эти events в AI context

#### Scenario: Пользователь просит запомнить данные в private mode

- **WHEN** private-mode запрос просит сохранить новую память
- **THEN** `save_memory` доступен и может создать persistent memory по явной просьбе пользователя

#### Scenario: Private mode позже выключен

- **WHEN** private mode выключен после ранее состоявшегося приватного диалога
- **THEN** прежние private-сообщения обеих сторон не появляются в embeddings, retrieval, recent history или AI context

#### Scenario: Private mode использует существующий контекст

- **WHEN** текущий private-запрос требует durable history, public retrieval, memory/facts или сведения об упомянутом пользователе
- **THEN** система использует эти источники по обычным scope-правилам
- **AND** не добавляет текущий private-turn в контекст следующего запроса

#### Scenario: Private-turn достиг порога compaction

- **WHEN** добавление текущих private events превышает порог durable context
- **THEN** система не создаёт boundary snapshot из private payload

#### Scenario: Истёк срок хранения

- **WHEN** private-сообщения пользователя и бота старше семи суток попадают в плановую очистку
- **THEN** система удаляет обе стороны приватного диалога даже при наличии более нового reply на одно из удаляемых сообщений
- **AND** связанные private context events удаляются каскадно
- **AND** сохраняемое reply теряет только ссылку на удалённое сообщение

#### Scenario: Найден ранее сохранённый private AI context

- **WHEN** миграция может идентифицировать durable thread, содержащий private-сообщение
- **THEN** этот thread context удаляется целиком вместе с событиями и snapshots, которые могли содержать private payload

#### Scenario: Существующий неприватный ответ не мигрируется

- **WHEN** change развёрнут поверх ранее сохранённых ответов бота без private-признака
- **THEN** система не переклассифицирует их автоматически, а корректно помечает новые ответы
