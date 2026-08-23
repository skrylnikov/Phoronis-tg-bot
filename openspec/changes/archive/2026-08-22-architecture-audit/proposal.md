# Proposal: Комплексный аудит архитектуры и зависимостей

## Summary

Проведён глубокий аудит архитектуры кодовой базы Phoronis Telegram Bot для выявления структурных проблем, избыточных зависимостей и улучшения разделения ответственности между модулями. Аудит выявил 8 критических архитектурных проблем и 5 зависимостей, которые можно удалить или заменить.

## Why

### Проблема 1: Путаница src/tools/ vs src/ai/tools/

**Текущее состояние:** Инструменты разбросаны по двум директориям без чёткого разделения:
- `src/tools/` - language, memory, user, shared (не AI-специфичные утилиты)
- `src/ai/tools/` - weather, wikipedia, chat-history, memory, user-info (AI tools для LLM)

**Проблема:** Дублирование memory tools, непонятное разделение ответственности.

**Места в коде:**
- `src/tools/memory/index.ts` - утилиты для работы с памятью (не используются?)
- `src/ai/tools/memory.ts` - AI tool для LLM (используется в chat-generation)
- `src/tools/user/` - fact-analyzer, meta-analyzer (используются напрямую, не через AI tools)

### Проблема 2: Минимальное использование LangChain

**Текущее состояние:** LangChain установлен как зависимость (@langchain/community + @langchain/core), но используется только в одном месте:

```typescript
// src/ai/tools/wikipedia.ts
import { WikipediaQueryRun } from '@langchain/community/tools/wikipedia_query_run';
```

**Проблема:** Тяжёлая зависимость (LangChain + подзависимости) ради одного простого wrapper для Wikipedia API.

**Альтернатива:** Простой fetch к Wikipedia API (wikipedia.org/w/api.php).

### Проблема 3: Дублирование AI SDK и LangChain

**Текущее состояние:** 
- AI SDK (Vercel AI) используется для text generation (`generateText`, `streamText`)
- LangChain используется для Wikipedia tool
- Оба предназначены для работы с LLM, но используются параллельно

**Проблема:** Концептуальное дублирование. AI SDK уже предоставляет tool system (dynamicTool), LangChain не нужен.

### Проблема 4: shared/ - слишком общее название

**Текущее состояние:** `src/shared/` содержит:
- quota-service.ts (бизнес-логика квот)
- subscriptions.ts (бизнес-логика подписок)
- save-chat.ts, save-user.ts, save-message.ts (data persistence)
- analysis-limiter.ts (rate limiting для analysis)
- guest-interaction.ts (бизнес-логика guest mode)

**Проблема:** "shared" не отражает содержимого. Это не утилиты, а domain logic + data access.

**Альтернатива:** Переименовать в `src/domain/` или разбить на `src/services/` + `src/repositories/`.

### Проблема 5: Нет чёткого разделения слоёв

**Текущее состояние:** Вызовы идут хаотично:
- controllers → ai → shared → database
- controllers → shared → database
- ai → tools/user → database (fact-analyzer обращается к БД напрямую)

**Проблема:** Нарушение layered architecture. Domain logic (ai, shared) смешана с data access.

**Желаемое состояние:**
```
controllers (handlers)
  ↓
services (business logic: quota, subscriptions, ai)
  ↓
repositories (data access: database)
```

### Проблема 6: Редкое использование date-fns

**Факт:** date-fns используется только 2 раза:
- `src/ai/controllet.ts`: `import { format } from 'date-fns'` - для форматирования даты в prompt
- (возможно ещё где-то в тестах)

**Проблема:** date-fns - тяжёлая зависимость (tree-shaking помогает, но всё равно overhead). `format()` можно заменить на:
```typescript
new Date().toLocaleString('ru-RU', { 
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
})
```

### Проблема 7: Редкое использование remeda

**Факт:** remeda используется 4 раза:
- `src/tools/language/tokenizator.ts`: `map`, `piped`
- `src/tools/language/cleaner.ts`: `piped`
- `src/ai/controllet.ts`: `unique`
- `src/ai/guest-generation.ts`: `unique`

**Проблема:** remeda - функциональная библиотека для data transformation. `unique` можно заменить на:
```typescript
[...new Set(array)]
```

`piped` - синтаксический сахар для композиции функций, можно обойтись нативным JS.

### Проблема 8: axios вместо нативного fetch

**Факт:** axios используется только 2 раза:
- `src/controllers/voice.ts`: загрузка OGG файла
- `src/ai/tools/weather.ts`: запрос к OpenWeather API

**Проблема:** Bun уже имеет встроенный fetch (Web API совместимый). axios - дополнительная зависимость.

**Альтернатива:**
```typescript
const response = await fetch(url, { headers });
const data = await response.json();
```

## What Changes

### 1. Реорганизовать tools

**Цель:** Разделить AI tools (для LLM) и domain utilities.

**Было:**
```
src/tools/
  ├── language/  (tokenizer, cleaner - domain utils)
  ├── memory/    (???)
  ├── user/      (fact-analyzer - domain logic)
  └── shared/    (entities extraction)

src/ai/tools/
  ├── weather.ts
  ├── wikipedia.ts
  ├── chat-history.ts
  ├── memory.ts
  ├── user-info.ts
  └── index.ts
```

**Станет:**
```
src/ai/tools/  (только AI tools для LLM)
  ├── weather.ts
  ├── wikipedia.ts
  ├── chat-history.ts
  ├── memory.ts
  └── user-info.ts

src/domain/  (новая директория для бизнес-логики)
  ├── user/
  │   ├── fact-analyzer.ts
  │   ├── fact-impact-tracker.ts
  │   └── meta-analyzer.ts
  ├── language/
  │   ├── tokenizator.ts
  │   ├── cleaner.ts
  │   └── activate.ts
  └── entities.ts  (из tools/shared/entities.ts)
```

**Удалить:** `src/tools/memory/` - если не используется, или объединить с ai/tools/memory.

### 2. Удалить LangChain, заменить на простой fetch

**Удалить зависимости:**
- `@langchain/community`
- `@langchain/core`

**Заменить:**
```typescript
// src/ai/tools/wikipedia.ts
// Было:
import { WikipediaQueryRun } from '@langchain/community/tools/wikipedia_query_run';

// Станет:
async function searchWikipedia(query: string): Promise<string> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json`;
  const response = await fetch(url);
  const data = await response.json();
  // Extract and format results
  return formatWikipediaResults(data);
}
```

### 3. Переименовать shared/ в domain/

**Было:** `src/shared/`

**Станет:** `src/domain/` или разбить на:
- `src/services/` - quota-service, subscription-service
- `src/repositories/` - chat-repository, user-repository, message-repository (сохранение в БД)

**Рекомендация:** На первом этапе просто переименовать в `domain/`, т.к. это уже domain logic.

### 4. Внедрить layered architecture

**Целевая структура:**
```
src/
├── controllers/     (HTTP/Telegram handlers, routing)
├── services/        (business logic: AI, quota, subscriptions)
├── repositories/    (data access wrappers)
├── domain/          (domain models, utilities)
├── ai/              (AI-specific: models, tools, prompts)
├── features/        (feature implementations)
└── infrastructure/  (config, logger, db, scheduler)
```

**Принципы:**
- controllers зависят от services
- services зависят от repositories
- repositories - единственный слой, работающий с data access
- domain - pure functions, domain models (не зависит от инфраструктуры)

### 5. Удалить date-fns

**Заменить:**
```typescript
// Было:
import { format } from 'date-fns';
const time = format(new Date(), 'dd.MM.yyyy HH:mm:ss');

// Станет:
const time = new Date().toLocaleString('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
}).replace(',', ''); // "22.08.2026 23:45:30"
```

### 6. Удалить remeda

**Заменить:**
```typescript
// unique
import { unique } from 'remeda';
const result = unique(array);
// →
const result = [...new Set(array)];

// piped
import { piped, map, filter } from 'remeda';
const result = piped(data, map(fn1), filter(fn2));
// →
const result = data.map(fn1).filter(fn2);
```

### 7. Заменить axios на fetch

**Заменить:**
```typescript
// Было:
import axios from 'axios';
const { data } = await axios.get(url, { headers });

// Станет:
const response = await fetch(url, { headers });
const data = await response.json();
```

## Goals

### Основные цели

1. **Привести структуру папок в порядок**
   - Разделить AI tools и domain utilities
   - Переименовать shared/ в domain/ или services/
   - Удалить дублирование (tools/memory vs ai/tools/memory)

2. **Удалить избыточные зависимости**
   - Удалить LangChain (заменить на fetch)
   - Удалить date-fns (заменить на toLocaleString)
   - Удалить remeda (заменить на нативные методы)
   - Удалить axios (заменить на fetch)

3. **Внедрить layered architecture**
   - Разделить слои: controllers → services → repositories
   - Изолировать data access в repositories layer
   - Сделать domain layer независимым от инфраструктуры

4. **Улучшить maintainability**
   - Чёткое разделение ответственности между модулями
   - Снижение coupling между слоями
   - Упрощение зависимостей

### Non-goals

- Изменение бизнес-логики (квоты, подписки остаются как есть)
- Изменение API контроллеров (Grammy handlers)
- Изменение схемы базы данных
- Добавление новых фич
- Изменение используемых AI моделей

## Technical Approach

### Этап 1: Удалить избыточные зависимости (средний риск)

#### 2.1. Удалить LangChain

1. Переписать `src/ai/tools/wikipedia.ts`:
   ```typescript
   import { dynamicTool } from 'ai';
   import { z } from 'zod';
   
   async function searchWikipedia(query: string): Promise<string> {
     const params = new URLSearchParams({
       action: 'query',
       list: 'search',
       srsearch: query,
       format: 'json',
       srlimit: '3',
     });
     const url = `https://en.wikipedia.org/w/api.php?${params}`;
     const response = await fetch(url);
     const data = await response.json();
     
     const results = data.query.search.map((item: any) => 
       `${item.title}: ${item.snippet.replace(/<[^>]*>/g, '')}`
     ).join('\n\n');
     
     return results || 'No results found';
   }
   
   export const wikipediaTool = dynamicTool({
     description: 'Search Wikipedia for information',
     inputSchema: z.object({ query: z.string() }),
     execute: async ({ query }) => await searchWikipedia(query),
   });
   ```

2. Удалить пакеты:
   ```bash
   bun remove @langchain/community @langchain/core
   ```

3. Проверить:
   ```bash
   bun run typecheck
   rg "@langchain" src/  # Должно быть пусто
   ```

#### 2.2. Заменить axios на fetch

1. Обновить `src/controllers/voice.ts`:
   ```typescript
   // Было:
   const { data } = await axios.get(url, { responseType: 'arraybuffer' });
   
   // Станет:
   const response = await fetch(url);
   const data = await response.arrayBuffer();
   ```

2. Обновить `src/ai/tools/weather.ts`:
   ```typescript
   // Было:
   const { data } = await axios.get(url);
   
   // Станет:
   const response = await fetch(url);
   const data = await response.json();
   ```

3. Удалить пакет:
   ```bash
   bun remove axios
   ```

#### 2.3. Заменить date-fns

1. Найти все использования:
   ```bash
   rg "from 'date-fns'" src/
   ```

2. Заменить `format()` на `toLocaleString()`:
   ```typescript
   // src/ai/controllet.ts
   const time = new Date().toLocaleString('ru-RU', {
     day: '2-digit',
     month: '2-digit',
     year: 'numeric',
     hour: '2-digit',
     minute: '2-digit',
     second: '2-digit',
   }).replace(',', '');
   ```

3. Удалить пакет:
   ```bash
   bun remove date-fns
   ```

#### 2.4. Заменить remeda

1. Заменить `unique`:
   ```typescript
   // src/ai/controllet.ts, src/ai/guest-generation.ts
   const allUserIds = [...new Set([...ids])];
   ```

2. Заменить `piped`:
   ```typescript
   // src/tools/language/tokenizator.ts
   // Было:
   import { map, piped } from 'remeda';
   return piped(tokens, map(normalize));
   
   // Станет:
   return tokens.map(normalize);
   ```

3. Удалить пакет:
   ```bash
   bun remove remeda
   ```

### Этап 2: Реорганизовать структуру (высокий риск)

**Примечание:** Этот этап самый инвазивный. Рекомендуется выполнять постепенно.

#### 3.1. Переименовать shared/ в domain/

```bash
git mv src/shared src/domain
# Глобальная замена импортов:
rg "from '../shared" src/ -l | xargs sed -i "s|from '../shared|from '../domain|g"
rg "from './shared" src/ -l | xargs sed -i "s|from './shared|from './domain|g"
```

#### 3.2. Реорганизовать tools/

1. Переместить `src/tools/language/` → `src/domain/language/`
2. Переместить `src/tools/user/` → `src/domain/user/`
3. Переместить `src/tools/shared/entities.ts` → `src/domain/entities.ts`
4. Удалить `src/tools/memory/` (если не используется)
5. Обновить импорты

#### 3.3. Выделить repositories layer (опционально)

Создать `src/repositories/`:
- `chat-repository.ts` (обёртка над chat storage)
- `user-repository.ts` (обёртка над user storage)
- `message-repository.ts` (обёртка над message storage)

Переместить туда логику из `save-chat.ts`, `save-user.ts`, `save-message.ts`.

## Impact

### Положительное

1. **Простота зависимостей:** -4 прямых пакета (langchain, axios, date-fns, remeda + подзависимости)
3. **Меньше bundle size:** Особенно для будущих serverless/edge deployments
4. **Ясная структура:** Понятное разделение AI tools, domain logic, data access
5. **Лучший DX:** IDE быстрее индексирует код, меньше path confusion
6. **Maintainability:** Чёткие границы между модулями

### Негативное / Риски

1. **Большой scope изменений:** Затрагивает много файлов
2. **Риск регрессии:** При неаккуратной замене зависимостей
3. **Время миграции:** Несколько дней работы для полной реорганизации
4. **Тесты:** Нужно обновить импорты в тестах

### Митигация рисков

- **Этапность:** Разбить на 3 независимых этапа (можно делать отдельными PR)
- **Тестирование:** После каждого этапа запускать `bun run typecheck` + tests
- **Review:** Каждый этап проходит code review
- **Rollback plan:** Каждый этап в отдельной ветке, легко откатить

## Alternatives Considered

### 1. Оставить всё как есть

**Отклонено:** Проблемы будут накапливаться. Избыточные зависимости увеличивают attack surface и bundle size.

### 2. Удалить только самые тяжёлые зависимости (LangChain)

**Рассмотрено:** Можно начать с этого как MVP. Но date-fns, remeda, axios тоже легко заменить.

### 3. Полностью переписать на Clean Architecture

**Отклонено:** Слишком инвазивно. Текущая структура работает, нужны только точечные улучшения.

## Success Metrics

### Обязательные

- [ ] `bun run typecheck` проходит без ошибок
- [ ] `bun run lint` проходит без ошибок
- [ ] Все существующие тесты проходят
- [ ] В `package.json` удалены неиспользуемые зависимости
- [ ] Размер `node_modules/` уменьшился (замерить до/после)

### Желательные

- [ ] Создана новая структура папок (domain/, repositories/)
- [ ] Обновлён AGENTS.md с новой структурой
- [ ] Обновлён README.md с новыми зависимостями

### Метрики

**Снимок для сравнения:**
- Зависимостей: 23 (package.json dependencies)
- Размер `node_modules/` и итоговое количество зависимостей фиксируются до/после удаления избыточных пакетов.

## Timeline

**Статус:** Planning (OpenSpec документация)

Этот proposal НЕ содержит имплементацию, только анализ и рекомендации.

### Рекомендуемый порядок реализации

1. **Этап 1: Зависимости** (2-3 дня, средний риск)
   - PR #2: Удалить LangChain, заменить Wikipedia tool
   - PR #3: Удалить axios, date-fns, remeda
   
2. **Этап 2: Структура** (3-5 дней, высокий риск)
   - PR #4: Переименовать shared/ → domain/
   - PR #5: Реорганизовать tools/
   - PR #6: (опционально) Выделить repositories layer

**Общее время:** 1-2 недели при последовательной работе.

**Альтернатива:** Можно делать только Этап 1 (удаление зависимостей), отложив реорганизацию структуры.
