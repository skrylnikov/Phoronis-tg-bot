## Context

См. `proposal.md` — Why. Риски проходят через одни и те же доверительные границы: Telegram update и AI tool arguments, долговременные пользовательские данные, lifecycle PostgreSQL-dependent задач и ограничения Telegram transport. Текущий runtime уже имеет durable update/job processing, abort signal, Prisma repositories, Rich Messages и S3-клиент; design переиспользует их и не вводит новый framework.

## Goals / Non-Goals

**Goals:**

- Закрыть утечки credential и межчатовых данных fail-closed правилами в общих точках сборки контекста и выполнения tools.
- Восстановить соответствие действующим private/quota/update контрактам с проверяемой DB-идемпотентностью.
- Ограничить долговременный рост AI context и плановых агрегатов без изменения пользовательской модели диалога.
- Сделать cron lifecycle частью graceful shutdown и добавить DB-backed acceptance gate в CI.

**Non-Goals:**

- Не менять тарифные значения, модели RouterAI/Yandex, тексты локальных промптов или общую семантику ответов.
- Не обещать exactly-once для внешней Telegram delivery за пределами уже принятого durable update-контракта.
- Не строить универсальную policy/ACL-систему, собственную очередь cron jobs или новый media pipeline.
- Не пытаться угадывать приватность старых `Memory`, для которых в данных отсутствует надёжный private-маркер.

## Decisions

### 1. Private mode использует обычный context pipeline без последующего наследования private-turn

Обычный AI controller в private mode читает durable thread, public retrieval/vector search, recent public history, сохранённые memory/facts и упомянутых пользователей по тем же scope-правилам, что и неприватный запрос. Writable tools, включая `save_memory`, остаются доступными: явная просьба пользователя сохранить память является намеренным persistent действием, а не автоматическим наследованием текста сообщения. Автоматический fact analysis private-сообщения не запускается.

Все context events, созданные при сборке private-turn, связываются с текущим `Message.private = true`. Repository включает эти events только в текущий запрос по точной паре chat/message, а при любом следующем запросе фильтрует их вместе с private `USER_MESSAGE` и `ASSISTANT`. Compaction на private-turn не запускается, чтобы private payload не попал в общий boundary snapshot. Ответ бота сначала сохраняется с private-признаком, затем assistant event связывается с этим сообщением. FK context event на message использует `ON DELETE CASCADE`, поэтому семидневная очистка не превращает отфильтрованное событие в несвязанное и снова видимое.

Идентифицируемое историческое нарушение устраняется миграцией: любой `AiThreadContext`, содержащий event со ссылкой на `Message.private = true`, удаляется целиком каскадом. Это намеренно может удалить неприватный хвост смешанного треда, зато не оставляет summary/boundary с уже сжатым private payload. Старые `Memory` без маркера не переклассифицируются автоматически.

Reply FK меняется с `RESTRICT` на `SET NULL`, чтобы истёкший parent удалялся без каскадного удаления более нового сообщения. Для регулярной очистки добавляется индекс по private/retention полям.

**Альтернатива:** строить отдельный transient context pipeline без repositories и writable tools. Отклонено: private mode должен сохранять все возможности текущего запроса; достаточно уже существующей связи event → message и fail-closed фильтра по `Message.private`.

### 2. Один evidence-механизм решает идемпотентность и chat scope фактов

Добавляется `UserFactEvidence` с `factId`, `sourceChatId`, `sourceMessageId`, временем и unique constraint на тройку полей. Существующие `UserFact.source*` сохраняются для совместимости, а текущие ссылки backfill-ятся как первая evidence запись.

При duplicate/contradiction analyzer в одной transaction сначала создаёт evidence через conflict-safe insert. Вес и history меняются только когда evidence создана впервые; retry того же source становится no-op. Ошибка embeddings/vector/model не преобразуется в «новый факт», а пробрасывается durable job для release quota и retry.

При формировании контекста текущий отправитель сохраняет доступ к своим глобальным фактам и personal memory. Для другого пользователя разрешены только факты с evidence в текущем чате; его personal memory не читается. Shared memory по-прежнему фильтруется текущим `chatId`. `get_user_info` дополнительно подтверждает актуальный membership через Telegram и при ошибке отказывает.

**Альтернатива:** считать единственный `UserFact.sourceChatId` достаточным. Отклонено: поле перезаписывается при усилении и не доказывает все источники факта или идемпотентность старого retry.

### 3. Greeting tool не принимает authority identifiers

Input schema tool содержит только `greeting`. Исполнение использует `ctx.chatId` и `ctx.from.id`, требует group/supergroup и проверяет реального отправителя через `getChatAdministrators` текущего чата. Валидация ограничивает trimmed-текст диапазоном 1–4096 символов. Контроллер новых участников выбирает только реальные поля `greeting` и `id`; отдельный `greetingEnabled` не вводится, отсутствие текста уже является выключенным состоянием.

**Альтернатива:** оставить `chatId`/`userId` в schema и сверять с context. Отклонено: параметры не нужны модели и расширяют поверхность prompt injection.

### 4. Telegram media скачивается внутри приложения с общим bounded helper

Минимальный helper скачивает Telegram file по `file_path`, использует текущий abort signal, накапливает поток только до переданного byte limit и никогда не возвращает или логирует credential URL. Image path передаёт AI SDK `Uint8Array`, поэтому OpenAI-compatible adapter формирует data payload вместо URL с token.

Voice/video note использует тот же helper с пределом 20 MiB — текущим максимумом официального Bot API download. Превышение считается контролируемой пользовательской ошибкой с release VOICE quota. Explicit `x-data-logging-enabled: true` удаляется.

Long-running speech загружает объект под уникальным key и удаляет тот же key в `finally`. Cleanup error логируется отдельно и не подменяет исходный result/error. Новая dependency не нужна: используется текущий S3 client и генератор ID.

**Альтернатива:** передавать Telegram URL vision-провайдеру и ротировать token чаще. Отклонено: ротация не делает передачу секрета допустимой.

### 5. Доставка выбирается по нативному transport ceiling

Единая финальная policy применяется после завершения stream:

1. До 4096 символов после выбранного форматирования — текущий legacy send/edit.
2. До 32768 символов — Rich Message даже для plain-текста.
3. Больше 32768 символов — короткий reply и UTF-8 `answer.txt` с полным результатом через Telegram document API.

Для ephemeral transport, который не может безопасно приложить document, generation получает консервативный output budget до вызова модели; итоговый guard не вызывает Telegram с превышенным payload. Preview остаётся ограниченным и не считается финальной доставкой.

**Альтернатива:** разбивать произвольный Markdown на много сообщений. Отклонено: корректное разбиение code fences/entities и восстановление после частичной внешней доставки требуют отдельного durable outbox, несоразмерного редкому ответу больше 32 KiB.

### 6. Cache boundary становится границей хранения, а не только prompt

Repository перестаёт include-ить всю relation. Он отдельно читает последний подтверждённый boundary и events с `sequence >= boundary.sequence`. После успешного построения snapshot append boundary, обновление cache counter и удаление более старых events выполняются в одной transaction; predicate по sequence не затрагивает конкурентно добавленный хвост. При ошибке summary/transaction старые events остаются.

**Альтернатива:** оставить физическую append-only историю и только фильтровать её в памяти. Отклонено: DB payload и scan всё равно растут на каждом turn.

### 7. Scheduler хранит handles и использует lock key на задачу

Каждая задача получает стабильный константный advisory key. `runSchedulerTask` возвращает различимый outcome: task возвращает маркер после выполнения, поэтому `undefined` от `withAdvisoryLock` означает `skipped`, а не `completed`. Все `ScheduledTask` собираются в registry; `startScheduler` идемпотентен и возвращает async `stopScheduler`, который блокирует новые запуски и дожидается tracked active promises в пределах shutdown timeout. Runtime вызывает его перед disconnect database.

Fact impact пересчитывается одним set-based SQL update либо ограниченными batches вместо загрузки всех impacts. MetaInfo migration считает и вновь созданные, и уже существующие эквивалентные факты, после чего очищает legacy payload. Обе операции остаются идемпотентными.

**Альтернатива:** отдельный queue/worker для cron. Отклонено: задачи периодические, неквотируемые и уже имеют PostgreSQL singleton primitive.

### 8. Ошибка repository check не превращается в отсутствие данных

Проверка reply parent возвращает `null` только после успешного запроса с результатом not found. Любая DB-ошибка пробрасывается, поэтому durable update retry не сохраняет необратимо оборванную цепочку. Тот же принцип применяется к similarity checks: логирование допускается, превращение ошибки в успешный пустой результат — нет.

### 9. Integration tests становятся CI gate

Quality job получает изолированный PostgreSQL с pgvector, применяет migrations и запускает существующий `test:integration` после unit suite. Добавляются минимальные DB-тесты для invalid Prisma select, `SET NULL` retention, unique fact evidence, private-context purge и scheduler outcomes/shutdown. Mocks остаются для быстрых веток, но не считаются доказательством DB-контрактов.

## Risks / Trade-offs

- [Удаление смешанного AI thread теряет неприватный контекст] → удалять только threads с доказанной private event; потеря контекста предпочтительнее сохранения private payload.
- [Старые факты имеют только один известный источник] → backfill-ить доступную ссылку и fail-closed не показывать прочие факты другим пользователям, пока не появится current-chat evidence.
- [Bot token уже мог попасть в provider logs] → после выкладки byte-upload path обязательно ротировать token и обновить runtime secret.
- [S3 delete может временно упасть] → отдельное cleanup событие/alert и однократная операционная очистка старого prefix; исходный speech result не маскировать.
- [Большой ответ как document менее удобен] → применять только выше 32768 символов; обычные ответы остаются сообщениями.
- [Context purge и FK migration могут блокировать крупные таблицы] → добавить нужные индексы, оценить count/EXPLAIN на production snapshot и выполнять migration до запуска новой версии.
- [20 MiB может измениться в Telegram] → держать значение одной именованной константой и обновлять только вместе с официальным platform limit и тестом.

## Migration Plan

1. Добавить `UserFactEvidence`, индексы и backfill из доступных `UserFact.sourceChatId/sourceMessageId`; проверить отсутствие duplicate evidence.
2. До удаления старых private messages удалить `AiThreadContext`, для которых существует связанный private event, затем заменить self-reply FK на `ON DELETE SET NULL`.
3. Развернуть приложение с private-event filtering, scoped facts/memory, server-side media download, scheduler lifecycle и bounded context reads.
4. Немедленно ротировать Telegram bot token, обновить secret и повторно выкатить pods; старый token считать скомпрометированным.
5. С отдельным операционным подтверждением удалить оставшиеся объекты старого voice prefix и проверить новые cleanup events.
6. Проверить migrations, integration suite, исключение private-turn events из следующего AI context, доступность обычных context/tools в private mode, greeting auth, длинный ответ, graceful shutdown и backlog после rollout.

Rollback приложения совместим с добавленной evidence table и `SET NULL` FK, но удалённые private contexts намеренно не восстанавливаются. После ротации rollback MUST использовать новый Telegram token; возвращать старый credential запрещено.
