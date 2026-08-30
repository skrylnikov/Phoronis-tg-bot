## ADDED Requirements

### Requirement: Vision-запрос не раскрывает Telegram credential

Система MUST загружать файл Telegram внутри доверенной границы приложения и MUST передавать vision-провайдеру байты либо безопасный объект без Telegram bot token. Bot token MUST NOT присутствовать в AI request body, URL, telemetry или error metadata.

#### Scenario: Фото отправляется на распознавание

- **WHEN** система получила `file_path` Telegram и вызывает vision API
- **THEN** приложение само загружает файл с Telegram и передаёт провайдеру содержимое без credential в URL

#### Scenario: Telegram download завершился ошибкой

- **WHEN** приложение не смогло получить байты изображения
- **THEN** vision API не вызывается, IMAGE-квота возвращается, а логи не содержат bot token

