## Runtime caller-ы prompt management

Проверено по `rg` и текущим unit-тестам 23 августа 2026 года. Runtime-версия в вызове не передаётся: используется активная версия Langfuse.

| Caller | Prompt name | Версия Langfuse | Ожидаемый формат | План перехода |
| --- | --- | ---: | --- | --- |
| `src/controllers/voice.ts:145` | `text-beautifier` | 3 | plain text без пояснений | локальный текст, `generateText.instructions` |
| `src/controllers/voice.ts:147` | `voice-summarize` | 4 | plain text-саммари | локальный шаблон с `author` |
| `src/ai/controllet.ts:397` | `chat-generation` | 3 | system instructions + JSON user/assistant history, строковый ответ | локальный base и append-only context |
| `src/ai/guest-generation.ts:101` | `chat-generation` | 3 | тот же формат, guest/read-only tools | локальный base и guest thread settings |
| `src/ai/image-description.ts:16` | `image-description` | 1 | plain text description | локальный текст |
| `src/domain/user/fact-analyzer.ts:384` | `meta-analyzer` | 2 | active schema `{ facts: [{ content, type, sourceMessageId }] }` | локальный snapshot + существующий schema contract |
| `src/domain/user/meta-analyzer.ts:103` | `meta-analyzer` | 2 | legacy five-category `User.metaInfo` JSON | удалить runtime caller после проверки импортов |

`image-description` v1 из Langfuse содержит один перевод строки перед «Опиши», тогда как утверждённая spec фиксирует два; fixture и registry следуют утверждённой spec. Содержимое `meta-analyzer` v2 сохранено без редакторских изменений.
