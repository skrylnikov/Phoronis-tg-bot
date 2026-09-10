## Context

Гостевой флоу сегодня: `guestController.on('guest_message')` → `handleGuestMessage` (`src/controllers/guest.ts`) → `describeGuestPhoto` смотрит только `message.photo` → `generateGuestResponse` (`src/ai/guest-generation.ts`) → `answerGuestQuery`. Обычный флоу для сравнения: `processMessageController` + `findPhotoInReplyChain` (10 hops, БД-fallback, `summary`-кэш) и `voiceController` (VOICE-квота, `downloadTelegramFile`, `yandex.speechkit.recognize`, beautify/summarize).

Ограничения гостевого режима: бот не участник чата, доступен только апдейт целиком (запрос + один уровень `reply_to_message`); `ctx.reply` недоступен, ответ только через `answerGuestQuery`; typing-статуса в Bot API для гостей нет. См. proposal.md (Why) и спеки change (что строить).

## Goals / Non-Goals

**Goals:**
- Reply-фото первого уровня в гостях распознаётся с кэшем `summary` и квотой IMAGE.
- Войс/video note из запроса и из reply первого уровня транскрибируется с квотой VOICE, текст уходит в генерацию.
- Лимитные ответы — короткий текст через `answerGuestQuery`, без кнопки подписки.

**Non-Goals:**
- Multi-hop глубже первого уровня в гостях.
- Кнопка подписки и `sendMediaLimitNotice` в гостях (там `ctx.reply`).
- Typing-статус, rich-обёртка для войсов как в обычном режиме, фоновый анализ гостевых войсов.
- Изменение поведения обычных чатов.

## Decisions

1. **Источник медиа — `message` + `reply_to_message`, приоритет у самого запроса.** Сначала проверяется медиа запроса (фото/войс/video note), затем медиа `reply_to_message`. Альтернатива — переиспользовать `findPhotoInReplyChain`: отвергнута, она ходит в БД по цепочке и дергает `ctx.api.getFile` для чужих `fileId`, чего в гостях нет и не нужно.
2. **Кэш `summary` читается до резерва квоты.** Родитель уже персистится (`persistObservedMessage`), для него же читается `summary`; при hit vision пропускается. Совпадает с обычным режимом (`process-message.ts`), убирает перерасход IMAGE.
3. **Транскрипция переиспользует существующие примитивы.** `downloadTelegramFile` (лимит 20 MiB уже внутри) + `yandex.speechkit.recognize` + `reserveQuota`/`releaseQuota` (VOICE). Beautify/summarize-промпты и rich-правка сообщений из `voiceController` не переносятся — в гостях один ответ через `answerGuestQuery`, сырой транскрипт (или ужатый) уходит в `generateGuestResponse` как `voiceTranscript`.
4. **`generateGuestResponse` получает новый опциональный вход `voiceTranscript`.** Встраивается в `currentUserMessage` рядом с `imageDescription`, отдельным типизированным блоком. Альтернатива — склеивать транскрипт в `text`: отвергнута, ломает типизированный контракт сообщений и переиспользование треда.
5. **Лимитные тексты — константы рядом с `guestImageLimitMessage`, без `sendMediaLimitNotice`.** Причина: `sendMediaLimitNotice` делает `ctx.reply` + кнопку подписки + `ephemeral_message_id` — всё неприменимо к `answerGuestQuery`. Дедуп через `shouldSendLimitNotice` сохраняется, чтобы не спамить один и тот же чат.

## Risks / Trade-offs

- [Risk] Telegram присылает в `guest_message.reply_to_message` урезанное сообщение без `photo`/`voice` → Фикс не сработает. Mitigation: залогировать наличие медиа-полей в `handleGuestMessage` на первом тесте в реальном чате; решение в explore принято как допущение (полный reply).
- [Risk] `getFile`/download для guest-`file_id` отклоняется API (бот не участник) → Mitigation: ошибка уходит в существующий `catch` с возвратом квоты и текстом `Не получилось ответить`; по логу `guest.processing_failed` будет видно.
- [Risk] Длинный транскрипт раздувает контекст генерации → Mitigation: передавать транскрипт как есть для коротких, для длинных — ужимать тем же `voice-summarize` промптом (решение на этапе реализации, спека не меняется).
- [Trade-off] Один уровень вместо десяти: фото глубже reply не распознаётся в гостях. Принято владельцем, зафиксировано в спеке.

## Migration Plan

Миграций БД нет, новые env не нужны. Деплой обычный; откат — предыдущий образ (поведение вернётся к «гости без медиа»). Идемпотентность гостевых ответов уже покрыта `claimGuestInteraction`, новые ветки её не меняют.

## Open Questions

- Нужен ли дедуп лимитных нотисов (`shouldSendLimitNotice`) в гостях или отвечать коротким текстом при каждом отказе — на спеке и задачах не сказывается, решается при реализации дефолтом «дедуп как в обычных чатах».
