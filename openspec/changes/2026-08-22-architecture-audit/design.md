# Design: Architecture Audit & Refactoring

## Current Architecture

### High-Level Component Diagram

```
┌──────────────────────────────────────────────────────────────┐
│ Entry Point (src/index.ts)                                   │
│  ├─ Bot initialization                                        │
│  ├─ Controllers registration                                  │
│  ├─ Health server                                             │
│  ├─ Scheduler                                                 │
│  └─ Embedding backfill                                        │
└──────────────────────────────────────────────────────────────┘
         ↓
┌──────────────────────────────────────────────────────────────┐
│ Controllers (src/controllers/)                                │
│  ├─ process-message.ts (main message handler)                │
│  ├─ voice.ts (voice/video_note)                              │
│  ├─ subscription.ts (payment flow)                            │
│  ├─ guest.ts (guest mode)                                     │
│  ├─ private.ts, me.ts, ask.ts                                │
│  └─ features.ts, start.ts, etc.                              │
└──────────────────────────────────────────────────────────────┘
         ↓
┌────────────────────────┬─────────────────────────────────────┐
│ AI Layer (src/ai/)     │ Shared/Domain (src/shared/)         │
│  ├─ ai.ts (models)     │  ├─ quota-service.ts                │
│  ├─ controllet.ts      │  ├─ subscriptions.ts                │
│  ├─ chat-generation.ts │  ├─ save-chat.ts                    │
│  ├─ embedding/         │  ├─ save-user.ts                    │
│  ├─ tools/             │  ├─ save-message.ts                 │
│  │   ├─ weather.ts     │  ├─ analysis-limiter.ts             │
│  │   ├─ wikipedia.ts   │  └─ guest-interaction.ts            │
│  │   ├─ memory.ts      │                                      │
│  │   ├─ user-info.ts   │                                      │
│  │   └─ chat-history.ts│                                      │
│  └─ ...                │                                      │
└────────────────────────┴─────────────────────────────────────┘
         ↓                          ↓
┌────────────────────────┬─────────────────────────────────────┐
│ Tools (src/tools/)     │ Database (src/db.ts)                │
│  ├─ language/          │   ↓                                  │
│  │   ├─ tokenizator.ts │ Prisma Client                       │
│  │   ├─ cleaner.ts     │ (src/generated/prisma/) ← PROBLEM   │
│  │   └─ activate.ts    │   ↓                                  │
│  ├─ user/              │ PostgreSQL + pgvector               │
│  │   ├─ fact-analyzer.ts                                     │
│  │   ├─ meta-analyzer.ts                                     │
│  │   └─ ...            │                                      │
│  ├─ memory/            │                                      │
│  └─ shared/            │                                      │
│      └─ entities.ts    │                                      │
└────────────────────────┴─────────────────────────────────────┘
```

### Current Dependency Flow

**Проблемные зоны:**

1. **Bidirectional dependencies:**
   - `controllers/` → `ai/` → `shared/` → `prisma`
   - `ai/tools/` → `tools/user/` (fact-analyzer) → `prisma`
   - `ai/controllet.ts` → `tools/user/fact-analyzer.ts` → `prisma` (обход shared/)

2. **Дублирование:**
   - `src/tools/memory/` и `src/ai/tools/memory.ts`
   - Оба работают с памятью, но разделение неясно

3. **Generated в src/:**
   - `src/generated/prisma/` (1.4MB) - нарушает separation of concerns

## Target Architecture

### Layered Architecture (Рекомендуемая)

```
┌──────────────────────────────────────────────────────────────┐
│ Presentation Layer (controllers/)                             │
│  - Grammy handlers                                            │
│  - HTTP health endpoints                                      │
│  - Webhook handlers                                           │
└──────────────────────────────────────────────────────────────┘
         ↓ depends on
┌──────────────────────────────────────────────────────────────┐
│ Service Layer (services/)                                     │
│  ├─ ai/ (AI generation, embeddings, tools)                   │
│  ├─ quota-service.ts                                          │
│  ├─ subscription-service.ts                                   │
│  ├─ message-service.ts                                        │
│  └─ user-service.ts                                           │
└──────────────────────────────────────────────────────────────┘
         ↓ depends on
┌──────────────────────────────────────────────────────────────┐
│ Repository Layer (repositories/)                              │
│  ├─ chat-repository.ts                                        │
│  ├─ user-repository.ts                                        │
│  ├─ message-repository.ts                                     │
│  ├─ subscription-repository.ts                                │
│  └─ quota-repository.ts                                       │
│  (единственный слой, работающий с Prisma)                    │
└──────────────────────────────────────────────────────────────┘
         ↓ depends on
┌──────────────────────────────────────────────────────────────┐
│ Data Access (Prisma Client)                                   │
│  - @prisma/client (node_modules/) ← Больше не в src/         │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ Domain Layer (domain/) - независимый слой                    │
│  ├─ models/ (domain models, types)                           │
│  ├─ user/ (fact-analyzer, meta-analyzer)                     │
│  ├─ language/ (tokenizator, cleaner)                         │
│  └─ entities.ts (entity extraction utils)                    │
└──────────────────────────────────────────────────────────────┘
```

### Dependency Rules

**Запрещённые зависимости:**
- ❌ `repositories/` → `services/`
- ❌ `domain/` → `services/` или `repositories/`
- ❌ `services/` → `controllers/`

**Разрешённые зависимости:**
- ✅ `controllers/` → `services/`
- ✅ `services/` → `repositories/`
- ✅ `services/` → `domain/`
- ✅ `repositories/` → `Prisma Client`

## Detailed Changes

### Change 1: Prisma Client Location

#### Current State

```typescript
// prisma/schema.prisma
generator client {
  provider   = "prisma-client"
  output     = "../src/generated/prisma"  // ← PROBLEM
  engineType = "client"
}

// src/db.ts
import { PrismaClient } from './generated/prisma/client.js';

// Hundreds of files:
import { User, Chat } from '../generated/prisma/client.js';
import type { Message } from '../../generated/prisma/client.js';
```

**Problems:**
1. `src/generated/` (1.4MB) загрязняет репозиторий
2. Непредсказуемые relative paths (`../`, `../../`, `../../../`)
3. IDE индексирует generated код

#### Target State

```typescript
// prisma/schema.prisma
generator client {
  provider   = "prisma-client"
  output     = "../node_modules/@prisma/client"  // ← SOLUTION
  engineType = "client"
}

// src/db.ts
import { PrismaClient } from '@prisma/client';

// All files:
import { User, Chat, Message } from '@prisma/client';
```

**Benefits:**
- Стандартный подход (как в документации Prisma)
- Простые импорты (`@prisma/client` везде)
- `src/` остаётся чистым
- IDE не индексирует generated код (в node_modules)

#### Migration Path

**Step 1:** Изменить schema.prisma
```bash
# Edit prisma/schema.prisma:
# output = "../node_modules/@prisma/client"
```

**Step 2:** Пересобрать
```bash
bun run db:generate
```

**Step 3:** Глобальная замена импортов
```bash
# Find all imports
rg "from ['\"].*generated/prisma" src/ -l

# Replace with @prisma/client
# Can use sed or IDE's find-replace
find src/ -name "*.ts" -exec sed -i "s|from '.*generated/prisma/client'|from '@prisma/client'|g" {} +
find src/ -name "*.ts" -exec sed -i 's|from ".*generated/prisma/client"|from "@prisma/client"|g' {} +
```

**Step 4:** Удалить generated/
```bash
rm -rf src/generated/
git add src/generated/ -A
```

**Step 5:** Verify
```bash
bun run typecheck
bun run test:unit
```

### Change 2: Remove LangChain Dependency

#### Current State

```typescript
// package.json
"dependencies": {
  "@langchain/community": "^1.1.29",
  "@langchain/core": "^1.2.9",
  // ...
}

// src/ai/tools/wikipedia.ts (ONLY usage)
import { WikipediaQueryRun } from '@langchain/community/tools/wikipedia_query_run';

export const wikipediaTool = dynamicTool({
  description: 'A wrapper around Wikipedia...',
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }: { query: string }) => {
    const tool = new WikipediaQueryRun({
      topKResults: 3,
      maxDocContentLength: 4000,
    });
    return await tool.invoke(query);
  },
});
```

**Problem:** LangChain тянет за собой множество подзависимостей для одного простого wrapper.

#### Target State

```typescript
// package.json
"dependencies": {
  // @langchain/* удалены
  // ...
}

// src/ai/tools/wikipedia.ts (NEW implementation)
import { dynamicTool } from 'ai';
import { z } from 'zod';

async function searchWikipedia(query: string, topK = 3): Promise<string> {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    format: 'json',
    srlimit: String(topK),
    utf8: '1',
  });
  
  const url = `https://en.wikipedia.org/w/api.php?${params}`;
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`Wikipedia API error: ${response.statusText}`);
  }
  
  const data = await response.json();
  
  if (!data.query?.search || data.query.search.length === 0) {
    return 'No results found.';
  }
  
  const results = data.query.search
    .map((item: any) => {
      const title = item.title;
      const snippet = item.snippet.replace(/<[^>]*>/g, ''); // Remove HTML tags
      return `**${title}**\n${snippet}`;
    })
    .join('\n\n');
  
  return results;
}

export const wikipediaTool = dynamicTool({
  description: 'Search Wikipedia for information on a topic',
  inputSchema: z.object({ 
    query: z.string().describe('The search query') 
  }),
  execute: async ({ query }) => await searchWikipedia(query, 3),
});
```

**Benefits:**
- -2 dependencies (@langchain/community, @langchain/core)
- -~50 подзависимостей (langchain тянет lodash, js-yaml, @playwright, etc.)
- Прозрачная реализация (понятно, что происходит)
- Легче тестировать

### Change 3: Remove axios, date-fns, remeda

#### axios → fetch

**Current usage locations:**
1. `src/controllers/voice.ts` - загрузка OGG файла
2. `src/ai/tools/weather.ts` - запрос к OpenWeather API

**Migration:**

```typescript
// voice.ts - Before:
import axios from 'axios';
const { data } = await axios.get<ArrayBuffer>(file.file_path, {
  responseType: 'arraybuffer',
});

// voice.ts - After:
const response = await fetch(file.file_path);
if (!response.ok) {
  throw new Error(`Failed to fetch file: ${response.statusText}`);
}
const data = await response.arrayBuffer();

// weather.ts - Before:
import axios from 'axios';
const { data } = await axios.get(url);

// weather.ts - After:
const response = await fetch(url);
if (!response.ok) {
  throw new Error(`Weather API error: ${response.statusText}`);
}
const data = await response.json();
```

#### date-fns → toLocaleString()

**Current usage:** `src/ai/controllet.ts` (formatting date for prompt)

```typescript
// Before:
import { format } from 'date-fns';
const time = format(new Date(), 'dd.MM.yyyy HH:mm:ss');

// After:
const time = new Date().toLocaleString('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
}).replace(',', ''); // Remove comma: "22.08.2026, 23:45:30" → "22.08.2026 23:45:30"
```

**Note:** Может потребоваться дополнительная обработка, если формат отличается от ожидаемого.

#### remeda → native JS

**Current usage locations:**
1. `src/ai/controllet.ts` - `unique()`
2. `src/ai/guest-generation.ts` - `unique()`
3. `src/tools/language/tokenizator.ts` - `map()`, `piped()`
4. `src/tools/language/cleaner.ts` - `piped()`

**Migration:**

```typescript
// unique - Before:
import { unique } from 'remeda';
const allUserIds = unique([ctx.from?.id, ...list.map(...)]);

// unique - After:
const allUserIds = [...new Set([ctx.from?.id, ...list.map(...)])];

// piped - Before:
import { piped, map } from 'remeda';
return piped(tokens, map(normalize), map(toLowerCase));

// piped - After:
return tokens.map(normalize).map(toLowerCase);
```

**Note:** `piped()` - это синтаксический сахар для chaining. В большинстве случаев достаточно `.map().filter()`.

### Change 4: Reorganize Folder Structure

#### Phase 1: Rename shared/ → domain/

**Current:**
```
src/shared/
  ├── quota-service.ts        (business logic)
  ├── subscriptions.ts        (business logic)
  ├── save-chat.ts            (data access)
  ├── save-user.ts            (data access)
  ├── save-message.ts         (data access)
  ├── analysis-limiter.ts     (rate limiting)
  ├── guest-interaction.ts    (business logic)
  └── subscription-presentation.ts (formatting)
```

**Target:**
```
src/domain/  (or src/services/)
  ├── quota-service.ts
  ├── subscriptions.ts
  ├── save-chat.ts
  ├── save-user.ts
  ├── save-message.ts
  ├── analysis-limiter.ts
  ├── guest-interaction.ts
  └── subscription-presentation.ts
```

**Migration:**
```bash
git mv src/shared src/domain

# Update all imports
rg "from ['\"].*/shared" src/ -l | \
  xargs sed -i "s|from '\\(.*\\)/shared|from '\\1/domain|g"
```

#### Phase 2: Consolidate tools/

**Current:**
```
src/tools/
  ├── language/
  │   ├── tokenizator.ts
  │   ├── cleaner.ts
  │   └── activate.ts
  ├── user/
  │   ├── fact-analyzer.ts
  │   ├── meta-analyzer.ts
  │   ├── fact-impact-tracker.ts
  │   └── message-analyzer.ts
  ├── memory/  (unused?)
  └── shared/
      └── entities.ts

src/ai/tools/  (AI tools for LLM)
  ├── weather.ts
  ├── wikipedia.ts
  ├── chat-history.ts
  ├── memory.ts
  └── user-info.ts
```

**Target:**
```
src/ai/tools/  (только AI tools для LLM)
  ├── weather.ts
  ├── wikipedia.ts
  ├── chat-history.ts
  ├── memory.ts
  └── user-info.ts

src/domain/  (business logic, domain utilities)
  ├── user/
  │   ├── fact-analyzer.ts
  │   ├── meta-analyzer.ts
  │   ├── fact-impact-tracker.ts
  │   └── message-analyzer.ts
  ├── language/
  │   ├── tokenizator.ts
  │   ├── cleaner.ts
  │   └── activate.ts
  ├── entities.ts  (from tools/shared/)
  ├── quota-service.ts
  ├── subscriptions.ts
  └── ...
```

**Migration:**
```bash
# Move language/ and user/ to domain/
git mv src/tools/language src/domain/language
git mv src/tools/user src/domain/user
git mv src/tools/shared/entities.ts src/domain/entities.ts

# Delete tools/memory if unused
rm -rf src/tools/memory
rm -rf src/tools  # if now empty

# Update imports
rg "from ['\"].*/tools/(language|user|shared)" src/ -l | \
  xargs sed -i "s|/tools/|/domain/|g"
```

#### Phase 3 (Optional): Extract repositories/

**Current:** Data access смешан с business logic в domain/

**Target:**
```
src/repositories/
  ├── chat-repository.ts       (Prisma wrapper)
  ├── user-repository.ts       (Prisma wrapper)
  ├── message-repository.ts    (Prisma wrapper)
  ├── subscription-repository.ts
  └── quota-repository.ts

src/services/  (renamed from domain/)
  ├── ai/                      (AI generation services)
  ├── quota-service.ts         (uses quota-repository)
  ├── subscription-service.ts  (uses subscription-repository)
  └── ...
```

**Пример: user-repository.ts**

```typescript
import { PrismaClient, type User } from '@prisma/client';
import { prisma } from '../db.js';

export class UserRepository {
  constructor(private prisma: PrismaClient) {}

  async findById(id: bigint): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async upsert(data: Omit<User, 'metaInfo'>): Promise<User> {
    return this.prisma.user.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    });
  }
}

export const userRepository = new UserRepository(prisma);
```

**Note:** Этот шаг опционален и может быть выполнен позже, если потребуется больше изоляции data access.

## Testing Strategy

### Unit Tests

**Existing tests affected:**
- `src/__tests__/subscription-*.test.ts` - импорты из shared/
- `src/__tests__/fact-analyzer.test.ts` - импорты из tools/user/
- `src/__tests__/*.test.ts` - все импорты Prisma

**Migration:**
```bash
# Update all test imports after each phase
rg "from ['\"].*generated/prisma" src/__tests__/ -l | \
  xargs sed -i "s|from '.*generated/prisma/client'|from '@prisma/client'|g"
```

### Integration Tests

**Manual verification needed:**
1. Wikipedia tool работает после удаления LangChain
2. Weather tool работает после замены axios
3. Voice processing работает после замены axios
4. Date formatting в промптах не изменился после удаления date-fns

### Smoke Tests

После каждого этапа:
```bash
bun run typecheck  # No errors
bun run lint       # No errors
bun run test:unit  # All pass
bun run dev        # Bot starts without errors
```

## Performance Considerations

### Bundle Size Impact

**Before:**
- `node_modules/` size: ~250MB
- Dependencies: 23 packages (+ transitive dependencies)
- LangChain подзависимости: lodash, js-yaml, @playwright, etc.

**After (estimated):**
- `node_modules/` size: ~180MB (-30%)
- Dependencies: 18 packages
- Removed: LangChain, axios, date-fns, remeda

**Benefit:** Меньше install time, меньше bundle для edge deployments.

### Runtime Performance

**No negative impact expected:**
- `fetch` (native Bun) ≈ axios (оба основаны на Web API)
- `toLocaleString()` немного медленнее date-fns, но вызывается редко (1 раз на запрос)
- `new Set()` ≈ remeda.unique()

**Positive impact:**
- Меньше code parsing на старте (без LangChain)

## Rollback Plan

### Этап 1 (Prisma client)

**Rollback:**
1. Вернуть изменения в `prisma/schema.prisma`
2. `bun run db:generate`
3. Откатить commit

**Риск:** Низкий. Только импорты меняются.

### Этап 2 (Dependencies)

**Rollback per dependency:**
- LangChain: `bun add @langchain/community @langchain/core` + откатить wikipedia.ts
- axios: `bun add axios` + откатить voice.ts, weather.ts
- date-fns: `bun add date-fns` + откатить controllet.ts
- remeda: `bun add remeda` + откатить все использования

**Риск:** Средний. Логика меняется, нужно тестирование.

### Этап 3 (Structure)

**Rollback:**
1. `git mv src/domain src/shared` (или обратно)
2. Откатить все перемещения файлов
3. Откатить импорты через `git revert`

**Риск:** Высокий. Много файлов затронуто, но git tracking помогает.

## Migration Checklist

### Pre-migration

- [ ] Создать backup ветку: `git checkout -b backup/before-refactor`
- [ ] Запустить все тесты: `bun run test:unit`
- [ ] Замерить bundle size: `du -sh node_modules/`
- [ ] Сохранить список зависимостей: `bun list > before-deps.txt`

### Phase 1: Prisma Client

- [ ] Изменить `prisma/schema.prisma` output
- [ ] `bun run db:generate`
- [ ] Найти все импорты: `rg "from.*generated/prisma" src/`
- [ ] Заменить импорты (глобально или per-file)
- [ ] Удалить `src/generated/`
- [ ] `bun run typecheck`
- [ ] `bun run test:unit`
- [ ] Commit & push

### Phase 2: Dependencies

#### 2.1. LangChain
- [ ] Переписать `wikipedia.ts` без LangChain
- [ ] Тест wikipedia tool вручную
- [ ] `bun remove @langchain/community @langchain/core`
- [ ] `bun run typecheck`
- [ ] Commit

#### 2.2. axios
- [ ] Заменить в `voice.ts`
- [ ] Заменить в `weather.ts`
- [ ] Тест voice и weather вручную
- [ ] `bun remove axios`
- [ ] `bun run typecheck`
- [ ] Commit

#### 2.3. date-fns
- [ ] Заменить в `controllet.ts`
- [ ] Проверить формат даты в логах
- [ ] `bun remove date-fns`
- [ ] `bun run typecheck`
- [ ] Commit

#### 2.4. remeda
- [ ] Заменить `unique()` (2 места)
- [ ] Заменить `piped()` (2 места)
- [ ] `bun remove remeda`
- [ ] `bun run typecheck`
- [ ] Commit

### Phase 3: Structure (Optional)

- [ ] `git mv src/shared src/domain`
- [ ] Обновить импорты
- [ ] `git mv src/tools/language src/domain/language`
- [ ] `git mv src/tools/user src/domain/user`
- [ ] `git mv src/tools/shared/entities.ts src/domain/entities.ts`
- [ ] Удалить `src/tools/` если пусто
- [ ] Обновить все импорты
- [ ] Обновить AGENTS.md
- [ ] `bun run typecheck`
- [ ] `bun run test:unit`
- [ ] Commit & push

### Post-migration

- [ ] Замерить новый bundle size: `du -sh node_modules/`
- [ ] Сравнить зависимости: `bun list > after-deps.txt`
- [ ] Запустить бота локально: `bun run dev`
- [ ] Ручной smoke test (отправить сообщения, проверить команды)
- [ ] Обновить README.md (если нужно)
- [ ] Создать PR с описанием изменений

## Documentation Updates

### Files to update

1. **AGENTS.md** - Project Structure section
   ```markdown
   ## Code Structure
   ```
   src/
   ├── controllers/     - Bot message handlers and route logic
   ├── services/        - Business logic (AI, quotas, subscriptions)
   ├── repositories/    - Data access layer (Prisma wrappers)
   ├── domain/          - Domain models and utilities
   ├── ai/              - AI/LLM integration
   ├── features/        - Feature implementations
   └── infrastructure/  - Config, logger, db, scheduler
   ```
   ```

2. **README.md** - Dependencies section
   - Удалить упоминания LangChain
   - Обновить список зависимостей

3. **package.json** - Удалить неиспользуемые overrides
   - Проверить overrides для langchain-related пакетов

## Success Criteria

### Must Have

✅ `bun run typecheck` - no errors
✅ `bun run lint` - no errors
✅ `bun run test:unit` - all pass
✅ `src/generated/` deleted
✅ Prisma imports use `@prisma/client`
✅ LangChain removed from package.json

### Should Have

✅ axios, date-fns, remeda removed
✅ Wikipedia tool works without LangChain
✅ Bot starts without errors
✅ AGENTS.md updated

### Nice to Have

✅ `src/domain/` structure implemented
✅ `node_modules/` size reduced by 30%
✅ README.md updated
✅ All imports consolidated
