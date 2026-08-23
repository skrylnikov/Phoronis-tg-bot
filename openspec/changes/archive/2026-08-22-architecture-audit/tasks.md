# Tasks: Architecture Audit Implementation

## Этап 1: Удалить избыточные зависимости

### Task 1.1: Удалить LangChain и переписать Wikipedia tool

#### 1.1.1: Переписать Wikipedia tool
- [x] Открыть `src/ai/tools/wikipedia.ts`
- [ ] Сохранить backup: `cp src/ai/tools/wikipedia.ts src/ai/tools/wikipedia.ts.backup`
- [x] Заменить код на новую реализацию (см. design.md)
- [x] Добавить функцию `searchWikipedia()` с fetch
- [x] Обновить `wikipediaTool` для использования новой функции
- [x] Удалить `import { WikipediaQueryRun } from '@langchain/community'`

#### 1.1.2: Тестирование Wikipedia tool
- [ ] Запустить бота: `bun run dev`
- [ ] Отправить боту запрос: "найди информацию про TypeScript в википедии"
- [ ] Проверить что tool вызывается и возвращает результаты
- [ ] Проверить что нет ошибок в логах

#### 1.1.3: Удалить LangChain пакеты
- [ ] Выполнить `bun remove @langchain/community`
- [ ] Выполнить `bun remove @langchain/core`
- [x] Проверить что LangChain удалён: `rg "@langchain" package.json` (должно быть пусто)
- [x] Проверить что нет импортов: `rg "from '@langchain" src/` (должно быть пусто)

#### 1.1.4: Верификация LangChain removal
- [x] Выполнить `bun run typecheck`
- [x] Выполнить `bun run test:unit`
- [ ] Commit: `git commit -m "refactor: remove LangChain, implement Wikipedia tool with fetch"`

### Task 1.2: Заменить axios на fetch

#### 1.2.1: Обновить voice.ts
- [x] Открыть `src/controllers/voice.ts`
- [x] Найти использование `axios.get()`
- [x] Заменить на:
  ```typescript
  const response = await fetch(file.file_path);
  if (!response.ok) {
    throw new Error(`Failed to fetch file: ${response.statusText}`);
  }
  const data = await response.arrayBuffer();
  ```
- [x] Удалить `import axios from 'axios';`
- [x] Сохранить файл

#### 1.2.2: Обновить weather.ts
- [x] Открыть `src/ai/tools/weather.ts`
- [x] Найти использование `axios.get()`
- [x] Заменить на:
  ```typescript
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Weather API error: ${response.statusText}`);
  }
  const data = await response.json();
  ```
- [x] Удалить `import axios from 'axios';`
- [x] Сохранить файл

#### 1.2.3: Тестирование
- [ ] Запустить бота
- [ ] Отправить голосовое сообщение - проверить обработку
- [ ] Запросить погоду через weather tool - проверить ответ
- [ ] Проверить логи на ошибки

#### 1.2.4: Удалить axios
- [x] Проверить что нет других использований: `rg "import.*axios" src/`
- [x] Выполнить `bun remove axios`
- [x] Выполнить `bun run typecheck`
- [ ] Commit: `git commit -m "refactor: replace axios with native fetch"`

### Task 1.3: Заменить date-fns на toLocaleString

#### 1.3.1: Обновить controllet.ts
- [x] Открыть `src/ai/controllet.ts`
- [x] Найти `import { format } from 'date-fns'`
- [x] Найти строку: `format(new Date(), 'dd.MM.yyyy HH:mm:ss')`
- [x] Заменить на:
  ```typescript
  const time = new Date().toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(',', '');
  ```
- [x] Удалить импорт date-fns
- [x] Сохранить файл

#### 1.3.2: Проверить другие использования
- [x] Выполнить `rg "from 'date-fns'" src/`
- [x] Если найдены другие места - обновить их аналогично
- [x] Проверить тесты: `rg "from 'date-fns'" src/__tests__/`

#### 1.3.3: Тестирование форматирования даты
- [ ] Запустить бота
- [ ] Отправить сообщение и проверить prompt с датой в Langfuse
- [ ] Убедиться что формат даты: "22.08.2026 23:45:30"

#### 1.3.4: Удалить date-fns
- [x] Выполнить `bun remove date-fns`
- [x] Выполнить `bun run typecheck`
- [ ] Commit: `git commit -m "refactor: replace date-fns with toLocaleString"`

### Task 1.4: Заменить remeda на нативные методы

#### 1.4.1: Заменить unique() в controllet.ts
- [x] Открыть `src/ai/controllet.ts`
- [x] Найти `import { unique } from 'remeda'`
- [x] Найти все использования `unique(array)`
- [x] Заменить на `[...new Set(array)]`
- [x] Удалить импорт remeda

#### 1.4.2: Заменить unique() в guest-generation.ts
- [x] Открыть `src/ai/guest-generation.ts`
- [x] Найти `import { unique } from 'remeda'`
- [x] Найти использования `unique(array)`
- [x] Заменить на `[...new Set(array)]`
- [x] Удалить импорт remeda

#### 1.4.3: Заменить piped() в tokenizator.ts
- [x] Открыть `src/domain/language/tokenizator.ts`
- [x] Найти `import { map, piped } from 'remeda'`
- [x] Найти `piped(tokens, map(fn))`
- [x] Заменить на `tokens.map(fn)`
- [x] Удалить импорт remeda

#### 1.4.4: Заменить piped() в cleaner.ts
- [x] Открыть `src/domain/language/cleaner.ts`
- [x] Найти `import { piped } from 'remeda'`
- [x] Найти использования `piped()`
- [x] Заменить на цепочку `.map().filter()`
- [x] Удалить импорт remeda

#### 1.4.5: Удалить remeda
- [x] Проверить что нет других использований: `rg "from 'remeda'" src/`
- [x] Выполнить `bun remove remeda`
- [x] Выполнить `bun run typecheck`
- [ ] Commit: `git commit -m "refactor: replace remeda with native JS methods"`

### Task 1.5: Финальная верификация Этапа 1
- [x] Выполнить `bun run typecheck` - должно пройти без ошибок
- [x] Выполнить `bun run lint` - должно пройти без ошибок
- [x] Выполнить `bun run test:unit` - все тесты должны пройти
- [ ] Выполнить `bun install` - проверить обновлённый lockfile
- [ ] Замерить размер: `du -sh node_modules/` - сравнить с начальным размером
- [x] Проверить package.json - должны отсутствовать: langchain, axios, date-fns, remeda

---

## Этап 2: Реорганизация структуры папок (Optional)

### Task 2.1: Переименовать shared/ в domain/

#### 2.1.1: Переместить директорию
- [x] Выполнить `git mv src/shared src/domain`
- [x] Проверить что директория перемещена: `ls src/domain`

#### 2.1.2: Обновить импорты в src/
- [x] Найти все импорты: `rg "from ['\"].*shared" src/ -l`
- [x] Заменить паттерны:
  - Из: `from '../shared'`
  - На: `from '../domain'`
  - Из: `from './shared'`
  - На: `from './domain'`
  - Из: `from '../../shared'`
  - На: `from '../../domain'`

#### 2.1.3: Обновить index.ts экспорты
- [x] Открыть `src/domain/index.ts` (бывший shared/index.ts)
- [x] Проверить что все экспорты валидны
- [x] Сохранить файл

#### 2.1.4: Верификация переименования
- [x] Выполнить `bun run typecheck`
- [x] Проверить что `src/shared/` больше не существует
- [ ] Commit: `git commit -m "refactor: rename shared/ to domain/"`

### Task 2.2: Реорганизовать tools/

#### 2.2.1: Переместить language/ в domain/
- [x] Выполнить `git mv src/tools/language src/domain/language`
- [x] Найти импорты: `rg "from ['\"].*/tools/language" src/ -l`
- [x] Заменить на: `from '../domain/language'` (или соответствующий путь)

#### 2.2.2: Переместить user/ в domain/
- [x] Выполнить `git mv src/tools/user src/domain/user`
- [x] Найти импорты: `rg "from ['\"].*/tools/user" src/ -l`
- [x] Заменить на: `from '../domain/user'` (или соответствующий путь)

#### 2.2.3: Переместить entities.ts
- [x] Выполнить `git mv src/tools/shared/entities.ts src/domain/entities.ts`
- [x] Найти импорты: `rg "from ['\"].*/tools/shared/entities" src/ -l`
- [x] Заменить на: `from '../domain/entities'`

#### 2.2.4: Удалить пустую директорию tools/
- [x] Проверить что `src/tools/` пуста: `ls src/tools/`
- [x] Удалить `src/tools/memory/` если не используется
- [x] Удалить `src/tools/` если полностью пуста: `rmdir src/tools`

#### 2.2.5: Верификация реорганизации tools/
- [x] Выполнить `bun run typecheck`
- [x] Проверить что все импорты работают
- [ ] Commit: `git commit -m "refactor: consolidate tools/ into domain/"`

### Task 2.3: Обновить документацию

#### 2.3.1: Обновить AGENTS.md
- [x] Открыть `AGENTS.md`
- [x] Найти секцию "Project Structure"
- [ ] Обновить структуру директорий:
  ```
  src/
  ├── controllers/     - Bot message handlers and route logic
  ├── ai/              - AI/LLM integration
  ├── domain/          - Business logic and domain utilities (was shared/)
  ├── features/        - Feature implementations
  ├── bot.ts           - Bot initialization and context type
  ├── db.ts            - Database client export
  ├── config.ts        - Environment configuration and validation
  ├── logger.ts        - Pino logger instance
  ├── scheduler.ts     - Cron job scheduler
  └── index.ts         - Application entry point
  ```
- [ ] Обновить примеры импортов (если упоминаются)
- [ ] Сохранить файл

#### 2.3.2: Обновить README.md (если нужно)
- [x] Открыть `README.md`
- [x] Проверить секцию "Architecture" / "Code Structure"
- [ ] Обновить структуру папок если она упоминается
- [ ] Обновить список зависимостей (удалить langchain, axios, date-fns, remeda)
- [ ] Сохранить файл

#### 2.3.3: Верификация документации
- [ ] Прочитать обновлённые секции
- [ ] Убедиться что информация актуальна
- [ ] Commit: `git commit -m "docs: update structure in AGENTS.md and README.md"`

### Task 2.4: Финальная верификация Этапа 2
- [x] Выполнить `bun run typecheck` - должно пройти без ошибок
- [x] Выполнить `bun run lint` - должно пройти без ошибок
- [x] Выполнить `bun run test:unit` - все тесты должны пройти
- [ ] Выполнить `bun run dev` - бот должен запуститься без ошибок
- [ ] Проверить структуру:
  - [x] `src/domain/` существует
  - [x] `src/shared/` не существует
  - [x] `src/tools/` не существует или пуста
- [x] Проверить что все импорты корректны

---

## Финальные задачи

### Task 4.1: Замеры и метрики

#### 4.1.1: Замерить bundle size
- [ ] Выполнить `du -sh node_modules/ > after-size.txt`
- [ ] Сравнить с начальным размером (before-size.txt)
- [ ] Записать результаты в PR description

#### 4.1.2: Сравнить зависимости
- [ ] Выполнить `bun list > after-deps.txt`
- [ ] Сравнить с before-deps.txt
- [ ] Подсчитать удалённые пакеты

#### 4.1.3: Проверить coverage
- [ ] Выполнить `bun run test:unit` с coverage (если настроен)
- [ ] Убедиться что coverage не упал

### Task 4.2: Smoke Testing

#### 4.2.1: Базовые команды
- [ ] Запустить бота локально: `bun run dev`
- [ ] Отправить `/start` - должен ответить
- [ ] Отправить `/me` - должен показать информацию
- [ ] Отправить `/subscribe` - должен показать тарифы

#### 4.2.2: AI функциональность
- [ ] Отправить простой текст "привет" - должен ответить
- [ ] Отправить вопрос "какая погода?" - должен использовать weather tool
- [ ] Отправить "найди в википедии TypeScript" - должен использовать wikipedia tool
- [ ] Проверить что нет ошибок в логах

#### 4.2.3: Media processing
- [ ] Отправить голосовое сообщение - должен обработать
- [ ] Отправить фото с текстом - должен распознать
- [ ] Проверить квоты работают

#### 4.2.4: Memory и context
- [ ] Отправить несколько сообщений подряд
- [ ] Проверить что контекст сохраняется
- [ ] Проверить что memory tools работают

### Task 4.3: Создание PR

#### 4.3.1: Подготовить PR description
- [ ] Написать краткое описание изменений
- [ ] Добавить метрики (bundle size reduction, dependencies removed)
- [ ] Добавить ссылку на OpenSpec change folder
- [ ] Перечислить breaking changes (если есть)
- [ ] Добавить скриншоты/логи smoke testing

#### 4.3.2: Создать PR
- [ ] Проверить что все commits на месте
- [ ] Выполнить `git push -u origin feature/architecture-audit-fbe8`
- [ ] Создать PR в GitHub
- [ ] Заполнить описание PR
- [ ] Добавить labels (если нужно)

#### 4.3.3: Self-review
- [ ] Просмотреть все изменённые файлы
- [ ] Убедиться что нет закомментированного кода
- [ ] Убедиться что нет debug логов
- [ ] Убедиться что .gitignore актуален

### Task 4.4: Финальная проверка

- [ ] CI/CD pipeline проходит (если настроен)
- [ ] Все тесты зелёные
- [ ] Typecheck проходит
- [ ] Lint проходит
- [ ] PR готов к review
- [ ] OpenSpec документация актуальна

---

## Опциональные улучшения (не в scope текущего change)

### Future Task: Выделить repositories layer
- [x] Создать `src/repositories/`
- [ ] Переместить data access logic из domain/
- [x] Создать chat-repository.ts
- [x] Создать user-repository.ts
- [x] Создать message-repository.ts
- [ ] Обновить services для использования repositories

### Future Task: Унифицировать error handling
- [ ] Проверить все try-catch блоки
- [ ] Создать централизованный error handler
- [ ] Добавить proper error types
- [ ] Логировать все ошибки через logger

### Future Task: Добавить integration tests
- [ ] Настроить test database
- [ ] Написать тесты для controllers
- [ ] Написать тесты для AI tools
- [ ] Написать тесты для quota system

---

## Критерии приёмки (Acceptance Criteria)

### Обязательные (Must Have)

- ✅ LangChain, axios, date-fns, remeda удалены из package.json
- ✅ `bun run typecheck` проходит без ошибок
- ✅ `bun run lint` проходит без ошибок
- ✅ `bun run test:unit` проходит без ошибок
- ✅ Бот запускается и работает без ошибок

### Желательные (Should Have)

- ✅ `src/shared/` переименована в `src/domain/`
- ✅ `src/tools/` консолидирована в `src/domain/`
- ✅ AGENTS.md обновлён с новой структурой
- ✅ node_modules/ уменьшился на 20%+
- ✅ Wikipedia tool работает без LangChain
- ✅ Weather и voice processing работают без axios

### Опциональные (Nice to Have)

- ⭕ README.md обновлён
- ⭕ Добавлены новые тесты для переписанных модулей
- ⭕ CI/CD pipeline обновлён (если нужно)
- ⭕ Performance benchmarks показывают улучшение

---

## Приоритизация задач

### High Priority (сделать обязательно)
1. Task 1.1: Удалить LangChain
2. Task 1.5: Финальная верификация Этапа 1

### Medium Priority (желательно сделать)
3. Task 1.2: Заменить axios
4. Task 1.3: Заменить date-fns
5. Task 1.4: Заменить remeda
6. Task 2.1: Переименовать shared/ в domain/

### Low Priority (можно отложить)
7. Task 2.2: Реорганизовать tools/
8. Task 2.3: Обновить документацию
10. Опциональные улучшения (repositories layer)

---

## Риски и митигация

### Риск: Регрессия в работе бота
**Митигация:**
- Поэтапный подход (3 независимых этапа)
- Тестирование после каждого этапа
- Smoke testing перед PR

### Риск: Сломанные тесты
**Митигация:**
- Обновлять импорты в тестах сразу после изменения src/
- Запускать `bun run test:unit` после каждого коммита

### Риск: Несовместимость с production
**Митигация:**
- Проверять что DATABASE_URL, ENV vars остаются совместимыми
- Не менять схему базы данных
- Не менять API контроллеров

### Риск: Большой PR (трудно review)
**Митигация:**
- Разбить на 3 отдельных PR (по этапам)
- Или сделать один PR с чёткими commit'ами (один commit = один этап)
- Добавить подробное описание в PR
