## MODIFIED Requirements

### Requirement: Readiness отражает готовность runtime

Система MUST возвращать ready только после успешной инициализации обязательной конфигурации, базы данных, embeddings, transport и update workers. До этого `/readyz` MUST возвращать HTTP 503. В polling mode успешная transport initialization и запуск polling loop MUST предшествовать переходу в ready; синхронная либо асинхронная ошибка polling loop MUST вернуть transport в not-ready и инициировать управляемое завершение процесса. Readiness MUST повторно проверять PostgreSQL и embeddings после временного отказа и возвращаться в ready без рестарта процесса, когда зависимости и остальные обязательные runtime-компоненты снова готовы, а shutdown не начат.

#### Scenario: База данных недоступна

- **WHEN** приложение не может установить или проверить подключение к PostgreSQL
- **THEN** `/readyz` возвращает HTTP 503 и указывает database как not-ready

#### Scenario: Embeddings недоступны

- **WHEN** embeddings являются обязательной частью текущего режима обработки и TEI недоступен
- **THEN** `/readyz` возвращает HTTP 503, а приложение не считается готовым принимать traffic

#### Scenario: PostgreSQL восстановился после временного отказа

- **WHEN** предыдущая readiness-проверка отметила database как not-ready, а PostgreSQL снова доступен
- **THEN** следующая успешная readiness-проверка возвращает HTTP 200 без рестарта процесса, если остальные обязательные runtime-компоненты готовы

#### Scenario: Embeddings восстановились после временного отказа

- **WHEN** предыдущая readiness-проверка отметила embeddings как not-ready, а TEI снова доступен
- **THEN** следующая успешная readiness-проверка возвращает HTTP 200 без рестарта процесса, если остальные обязательные runtime-компоненты готовы

#### Scenario: Transport ещё не запущен

- **WHEN** health server уже слушает порт, но webhook или polling workers ещё не запущены
- **THEN** `/readyz` возвращает HTTP 503

#### Scenario: Polling initialization завершилась ошибкой

- **WHEN** Telegram bot initialization или начальный запуск polling loop завершается ошибкой
- **THEN** transport не переходит в ready, `/readyz` возвращает HTTP 503, а процесс начинает управляемое завершение с ненулевым статусом

#### Scenario: Polling loop завершился после ready

- **WHEN** ранее запущенный polling loop неожиданно завершается или отклоняет promise
- **THEN** transport немедленно становится not-ready и приложение начинает управляемое завершение вместо продолжения работы в ложном ready-состоянии
