# Tasks: Architecture Audit Implementation

## Этап 1: Переместить Prisma Generated Client

### Task 1.1: Изменить Prisma Schema
- [ ] Открыть `prisma/schema.prisma`
- [ ] Изменить `generator client { output = "../node_modules/@prisma/client" }`
- [ ] Сохранить файл

### Task 1.2: Пересобрать Prisma Client
- [ ] Выполнить `bun run db:generate`
- [ ] Проверить что `node_modules/@prisma/client` создан
- [ ] Проверить что `src/generated/` больше не обновляется

### Task 1.3: Обновить импорты Prisma
- [ ] Найти все файлы с импортами: `rg "from ['\"].*generated/prisma" src/ -l`
- [ ] Создать резервную копию: `git stash`
- [ ] Глобально заменить импорты:
  - Из: `from '../generated/prisma/client'`
  - На: `from '@prisma/client'`
  - Из: `from './generated/prisma/client'`
  - На: `from '@prisma/client'`
  - Из: `from '../../generated/prisma/client'`
  - На: `from '@prisma/client'`
- [ ] Проверить замену в основных файлах:
  - `src/db.ts`
  - `src/shared/save-*.ts`
  - `src/ai/controllet.ts`
  - `src/controllers/*.ts`
  - `src/__tests__/*.test.ts`

### Task 1.4: Удалить generated/ директорию
- [ ] Убедиться что все импорты обновлены
- [ ] Выполнить `rm -rf src/generated/`
- [ ] Добавить изменения в git: `git add src/generated/ -A`
- [ ] Проверить что директория удалена из репозитория

### Task 1.5: Верификация Этапа 1
- [ ] Выполнить `bun run typecheck` - должно пройти без ошибок
- [ ] Выполнить `bun run lint` - должно пройти без ошибок
- [ ] Выполнить `bun run test:unit` - все тесты должны пройти
- [ ] Выполнить `bun run dev` - бот должен запуститься
- [ ] Проверить что `src/` больше не содержит `generated/`
- [ ] Commit: `git commit -m "refactor: move Prisma client to node_modules"`

---

## Этап 2: Удалить избыточные зависимости

### Task 2.1: Удалить LangChain и переписать Wikipedia tool

#### 2.1.1: Переписать Wikipedia tool
- [ ] Открыть `src/ai/tools/wikipedia.ts`
- [ ] Сохранить backup: `cp src/ai/tools/wikipedia.ts src/ai/tools/wikipedia.ts.backup`
- [ ] Заменить код на новую реализацию (см. design.md)
- [ ] Добавить функцию `searchWikipedia()` с fetch
- [ ] Обновить `wikipediaTool` для использования новой функции
- [ ] Удалить `import { WikipediaQueryRun } from '@langchain/community'`

#### 2.1.2: Тестирование Wikipedia tool
- [ ] Запустить бота: `bun run dev`
- [ ] Отправить боту запрос: "найди информацию про TypeScript в википедии"
- [ ] Проверить что tool вызывается и возвращает результаты
- [ ] Проверить что нет ошибок в логах

#### 2.1.3: Удалить LangChain пакеты
- [ ] Выполнить `bun remove @langchain/community`
- [ ] Выполнить `bun remove @langchain/core`
- [ ] Проверить что LangChain удалён: `rg "@langchain" package.json` (должно быть пусто)
- [ ] Проверить что нет импортов: `rg "from '@langchain" src/` (должно быть пусто)

#### 2.1.4: Верификация LangChain removal
- [ ] Выполнить `bun run typecheck`
- [ ] Выполнить `bun run test:unit`
- [ ] Commit: `git commit -m "refactor: remove LangChain, implement Wikipedia tool with fetch"`

### Task 2.2: Заменить axios на fetch

#### 2.2.1: Обновить voice.ts
- [ ] Открыть `src/controllers/voice.ts`
- [ ] Найти использование `axios.get()`
- [ ] Заменить на:
  ```typescript
  const response = await fetch(file.file_path);
  if (!response.ok) {
    throw new Error(`Failed to fetch file: ${response.statusText}`);
  }
  const data = await response.arrayBuffer();
  ```
- [ ] Удалить `import axios from 'axios';`
- [ ] Сохранить файл

#### 2.2.2: Обновить weather.ts
- [ ] Открыть `src/ai/tools/weather.ts`
- [ ] Найти использование `axios.get()`
- [ ] Заменить на:
  ```typescript
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Weather API error: ${response.statusText}`);
  }
  const data = await response.json();
  ```
- [ ] Удалить `import axios from 'axios';`
- [ ] Сохранить файл

#### 2.2.3: Тестирование
- [ ] Запустить бота
- [ ] Отправить голосовое сообщение - проверить обработку
- [ ] Запросить погоду через weather tool - проверить ответ
- [ ] Проверить логи на ошибки

#### 2.2.4: Удалить axios
- [ ] Проверить что нет других использований: `rg "import.*axios" src/`
- [ ] Выполнить `bun remove axios`
- [ ] Выполнить `bun run typecheck`
- [ ] Commit: `git commit -m "refactor: replace axios with native fetch"`

### Task 2.3: Заменить date-fns на toLocaleString

#### 2.3.1: Обновить controllet.ts
- [ ] Открыть `src/ai/controllet.ts`
- [ ] Найти `import { format } from 'date-fns'`
- [ ] Найти строку: `format(new Date(), 'dd.MM.yyyy HH:mm:ss')`
- [ ] Заменить на:
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
- [ ] Удалить импорт date-fns
- [ ] Сохранить файл

#### 2.3.2: Проверить другие использования
- [ ] Выполнить `rg "from 'date-fns'" src/`
- [ ] Если найдены другие места - обновить их аналогично
- [ ] Проверить тесты: `rg "from 'date-fns'" src/__tests__/`

#### 2.3.3: Тестирование форматирования даты
- [ ] Запустить бота
- [ ] Отправить сообщение и проверить prompt с датой в Langfuse
- [ ] Убедиться что формат даты: "22.08.2026 23:45:30"

#### 2.3.4: Удалить date-fns
- [ ] Выполнить `bun remove date-fns`
- [ ] Выполнить `bun run typecheck`
- [ ] Commit: `git commit -m "refactor: replace date-fns with toLocaleString"`

### Task 2.4: Заменить remeda на нативные методы

#### 2.4.1: Заменить unique() в controllet.ts
- [ ] Открыть `src/ai/controllet.ts`
- [ ] Найти `import { unique } from 'remeda'`
- [ ] Найти все использования `unique(array)`
- [ ] Заменить на `[...new Set(array)]`
- [ ] Удалить импорт remeda

#### 2.4.2: Заменить unique() в guest-generation.ts
- [ ] Открыть `src/ai/guest-generation.ts`
- [ ] Найти `import { unique } from 'remeda'`
- [ ] Найти использования `unique(array)`
- [ ] Заменить на `[...new Set(array)]`
- [ ] Удалить импорт remeda

#### 2.4.3: Заменить piped() в tokenizator.ts
- [ ] Открыть `src/tools/language/tokenizator.ts`
- [ ] Найти `import { map, piped } from 'remeda'`
- [ ] Найти `piped(tokens, map(fn))`
- [ ] Заменить на `tokens.map(fn)`
- [ ] Удалить импорт remeda

#### 2.4.4: Заменить piped() в cleaner.ts
- [ ] Открыть `src/tools/language/cleaner.ts`
- [ ] Найти `import { piped } from 'remeda'`
- [ ] Найти использования `piped()`
- [ ] Заменить на цепочку `.map().filter()`
- [ ] Удалить импорт remeda

#### 2.4.5: Удалить remeda
- [ ] Проверить что нет других использований: `rg "from 'remeda'" src/`
- [ ] Выполнить `bun remove remeda`
- [ ] Выполнить `bun run typecheck`
- [ ] Commit: `git commit -m "refactor: replace remeda with native JS methods"`

### Task 2.5: Финальная верификация Этапа 2
- [ ] Выполнить `bun run typecheck` - должно пройти без ошибок
- [ ] Выполнить `bun run lint` - должно пройти без ошибок
- [ ] Выполнить `bun run test:unit` - все тесты должны пройти
- [ ] Выполнить `bun install` - проверить обновлённый lockfile
- [ ] Замерить размер: `du -sh node_modules/` - сравнить с начальным размером
- [ ] Проверить package.json - должны отсутствовать: langchain, axios, date-fns, remeda

---

## Этап 3: Реорганизация структуры папок (Optional)

### Task 3.1: Переименовать shared/ в domain/

#### 3.1.1: Переместить директорию
- [ ] Выполнить `git mv src/shared src/domain`
- [ ] Проверить что директория перемещена: `ls src/domain`

#### 3.1.2: Обновить импорты в src/
- [ ] Найти все импорты: `rg "from ['\"].*shared" src/ -l`
- [ ] Заменить паттерны:
  - Из: `from '../shared'`
  - На: `from '../domain'`
  - Из: `from './shared'`
  - На: `from './domain'`
  - Из: `from '../../shared'`
  - На: `from '../../domain'`

#### 3.1.3: Обновить index.ts экспорты
- [ ] Открыть `src/domain/index.ts` (бывший shared/index.ts)
- [ ] Проверить что все экспорты валидны
- [ ] Сохранить файл

#### 3.1.4: Верификация переименования
- [ ] Выполнить `bun run typecheck`
- [ ] Проверить что `src/shared/` больше не существует
- [ ] Commit: `git commit -m "refactor: rename shared/ to domain/"`

### Task 3.2: Реорганизовать tools/

#### 3.2.1: Переместить language/ в domain/
- [ ] Выполнить `git mv src/tools/language src/domain/language`
- [ ] Найти импорты: `rg "from ['\"].*/tools/language" src/ -l`
- [ ] Заменить на: `from '../domain/language'` (или соответствующий путь)

#### 3.2.2: Переместить user/ в domain/
- [ ] Выполнить `git mv src/tools/user src/domain/user`
- [ ] Найти импорты: `rg "from ['\"].*/tools/user" src/ -l`
- [ ] Заменить на: `from '../domain/user'` (или соответствующий путь)

#### 3.2.3: Переместить entities.ts
- [ ] Выполнить `git mv src/tools/shared/entities.ts src/domain/entities.ts`
- [ ] Найти импорты: `rg "from ['\"].*/tools/shared/entities" src/ -l`
- [ ] Заменить на: `from '../domain/entities'`

#### 3.2.4: Удалить пустую директорию tools/
- [ ] Проверить что `src/tools/` пуста: `ls src/tools/`
- [ ] Удалить `src/tools/memory/` если не используется
- [ ] Удалить `src/tools/` если полностью пуста: `rmdir src/tools`

#### 3.2.5: Верификация реорганизации tools/
- [ ] Выполнить `bun run typecheck`
- [ ] Проверить что все импорты работают
- [ ] Commit: `git commit -m "refactor: consolidate tools/ into domain/"`

### Task 3.3: Обновить документацию

#### 3.3.1: Обновить AGENTS.md
- [ ] Открыть `AGENTS.md`
- [ ] Найти секцию "Project Structure"
- [ ] Обновить структуру директорий:
  ```
  src/
  ├── controllers/     - Bot message handlers and route logic
  ├── ai/              - AI/LLM integration
  ├── domain/          - Business logic and domain utilities (was shared/)
  ├── features/        - Feature implementations
  ├── bot.ts           - Bot initialization and context type
  ├── db.ts            - Prisma client export
  ├── config.ts        - Environment configuration and validation
  ├── logger.ts        - Pino logger instance
  ├── scheduler.ts     - Cron job scheduler
  └── index.ts         - Application entry point
  ```
- [ ] Обновить примеры импортов (если упоминаются)
- [ ] Сохранить файл

#### 3.3.2: Обновить README.md (если нужно)
- [ ] Открыть `README.md`
- [ ] Проверить секцию "Architecture" / "Code Structure"
- [ ] Обновить структуру папок если она упоминается
- [ ] Обновить список зависимостей (удалить langchain, axios, date-fns, remeda)
- [ ] Сохранить файл

#### 3.3.3: Верификация документации
- [ ] Прочитать обновлённые секции
- [ ] Убедиться что информация актуальна
- [ ] Commit: `git commit -m "docs: update structure in AGENTS.md and README.md"`

### Task 3.4: Финальная верификация Этапа 3
- [ ] Выполнить `bun run typecheck` - должно пройти без ошибок
- [ ] Выполнить `bun run lint` - должно пройти без ошибок
- [ ] Выполнить `bun run test:unit` - все тесты должны пройти
- [ ] Выполнить `bun run dev` - бот должен запуститься без ошибок
- [ ] Проверить структуру:
  - `src/domain/` существует
  - `src/shared/` не существует
  - `src/tools/` не существует или пуста
- [ ] Проверить что все импорты корректны

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
- [ ] Создать `src/repositories/`
- [ ] Переместить data access logic из domain/
- [ ] Создать chat-repository.ts
- [ ] Создать user-repository.ts
- [ ] Создать message-repository.ts
- [ ] Обновить services для использования repositories
- [ ] Убедиться что Prisma используется только в repositories/

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

- ✅ `src/generated/` удалена из репозитория
- ✅ Все импорты Prisma используют `@prisma/client`
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
1. Этап 1: Prisma client (Tasks 1.1-1.5)
2. Task 2.1: Удалить LangChain
3. Task 2.5: Финальная верификация Этапа 2

### Medium Priority (желательно сделать)
4. Task 2.2: Заменить axios
5. Task 2.3: Заменить date-fns
6. Task 2.4: Заменить remeda
7. Task 3.1: Переименовать shared/ в domain/

### Low Priority (можно отложить)
8. Task 3.2: Реорганизовать tools/
9. Task 3.3: Обновить документацию
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
- Не менять Prisma schema (только output path)
- Не менять API контроллеров

### Риск: Большой PR (трудно review)
**Митигация:**
- Разбить на 3 отдельных PR (по этапам)
- Или сделать один PR с чёткими commit'ами (один commit = один этап)
- Добавить подробное описание в PR

---

## Время оценки (Estimation)

- **Этап 1:** 2-4 часа (Prisma client)
- **Этап 2:** 4-6 часов (Dependencies)
- **Этап 3:** 4-6 часов (Structure)
- **Документация и тестирование:** 2-3 часа
- **PR review и fixes:** 2-3 часа

**Итого:** 14-22 часа (2-3 рабочих дня)

**Рекомендация:** Делать поэтапно:
- День 1: Этап 1 (Prisma) + начать Этап 2 (LangChain)
- День 2: Завершить Этап 2 (остальные dependencies)
- День 3: Этап 3 (Structure) + документация + PR
