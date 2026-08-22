# Phoronis Telegram Bot - Agent Guidelines

## Build & Run Commands

- `bun run start` - Start the bot in production mode
- `bun run dev` - Start bot with watch mode for development
- `bun run typecheck` - Run TypeScript type checking (always run after changes)
- `bun run lint` - Run Biome linter for code quality checks
- `bun run lint:fix` - Run Biome linter with auto-fix for code issues
- `bun run db:generate` - Generate Prisma client from schema
- `bun run db:deploy` - Deploy database migrations
- `bun run postinstall` - Runs automatically after install; generates Prisma client

**No test framework is currently configured** - Tests must be added manually. To add tests: install vitest or jest and configure in package.json.

## Development Philosophy

### Ponytail (YAGNI Ladder)

This project follows the **Ponytail** approach for efficient, maintainable code. When writing code, agents should follow the YAGNI ladder defined in `.cursor/rules/ponytail.mdc`:

1. Does this need to be built at all? (YAGNI)
2. Does it already exist in this codebase? Reuse it.
3. Does the standard library do this? Use it.
4. Does a native platform feature cover it? Use it.
5. Does an already-installed dependency solve it? Use it.
6. Can this be one line? Make it one line.
7. Only then: write the minimum code that works.

**Key principles:**
- Lazy means efficient, not careless. The best code is the code never written.
- Shortest working diff wins, but only after understanding the problem.
- No abstractions, dependencies, or boilerplate unless explicitly requested.
- Bug fixes target root causes, not symptoms.
- Mark deliberate simplifications with `ponytail:` comments naming the ceiling and upgrade path.

**Not lazy about:** Input validation, error handling preventing data loss, security, accessibility, product safety/quota rules, anything explicitly requested.

This complements (does not replace) the product-specific guidelines, OpenSpec workflow, and safety/quota/product rules defined throughout this document.

## Code Style Guidelines

### Imports & Formatting
- Use named imports from libraries: `import { Bot, Context } from 'grammy'`
- ES modules require .js extensions in imports: `import { bot } from './bot.js'`
- Single quotes for strings (enforced by Biome)
- 2-space indentation (enforced by .editorconfig)
- Always insert final newline
- Group imports: external libraries first, then project modules

### TypeScript & Types
- Strict TypeScript mode is enabled
- Custom types defined inline when simple, separate files when complex
- BotContext type: `export type BotContext = Context`
- Import Prisma types from `@grammyjs/types` and generated client
- Never use `any` - use proper types or `unknown` when needed

### Naming Conventions
- Variables and functions: `camelCase`
- Types and interfaces: `PascalCase`
- Constants: `camelCase` (e.g., `routerAIToken`, `token`)
- File names: `kebab-case` for folders and files (e.g., `meta-analyzer.ts`, `save-chat.ts`)
- Prisma models: `PascalCase` (User, Chat, Message)

### Type Guards & Patterns
- Use type guards for runtime type checking: `function hasProperty(obj: unknown): obj is MyType { ... }`
- Type guards return `obj is Type` for proper TypeScript narrowing
- See `src/controllers/process-message.ts:32-38` for example

### Project Structure
```
src/
├── controllers/       - Bot message handlers and route logic
├── ai/              - AI/LLM integration (LangChain, RouterAI)
├── tools/           - Utility functions organized by domain
├── features/        - Feature implementations (selfie-saturday, etc.)
├── shared/          - Shared utilities and helpers
├── generated/prisma/ - Generated Prisma client (don't edit)
├── bot.ts           - Bot initialization and context type
├── db.ts            - Prisma client export
├── config.ts        - Environment configuration and validation
├── logger.ts        - Pino logger instance
├── scheduler.ts     - Cron job scheduler
└── index.ts         - Application entry point
```

### Error Handling
- Wrap async operations in try-catch blocks
- Use `logger.error(error, "context message")` for logging errors
- Global error handler in `src/index.ts:11-23`
- Global handlers for `uncaughtException` and `unhandledRejection` in index.ts:31-37
- Graceful shutdown on SIGINT and SIGTERM in index.ts:39-47
- Config validation: `const token = process.env.TOKEN || showError('msg')` throws if missing

### Database Patterns
- Use Prisma for all database operations
- Upsert pattern for chat/user updates: `prisma.chat.upsert({ create, update, where })`
- Use LRU cache for frequently accessed entities (see `src/shared/save-chat.ts`)
- Transaction operations: `await prisma.$transaction([...])`
- Generated client location: `src/generated/prisma/`

### Bot Development Patterns
- Use Grammy Composer for middleware: `export const controller = new Composer<BotContext>()`
- Message handlers: `controller.on(":text", async (ctx) => { ... })`
- Access message data: `ctx.msg.text`, `ctx.from.id`, `ctx.chatId`
- Bot instance: `import { bot } from "./bot"`
- Use BotContext type throughout: `ctx: BotContext`
- Register controllers in `src/controllers/index.ts` to compose middleware

### AI Integration
- Use LangChain for complex chains and AI SDK for text generation
- RouterAI for model access via `@ai-sdk/openai-compatible`
- Langfuse for prompt management and observability
- Local TEI embeddings with vector search in PostgreSQL/pgvector
- Stream responses where applicable
- Chat models are centralized in `src/ai/ai.ts`; embedding access is in `src/ai/embedding/`
- Use `generateText()` from 'ai' package for text generation
- Use `telegramify-markdown` imported as `MD` for formatting AI responses

### Best Practices
- Use `Promise.all()` for parallel independent operations
- Cache expensive operations with LRU cache
- Use `BigInt` for Telegram IDs in database
- Convert to `Number` for API calls: `Number(chatId)`
- Use `telegramify-markdown` for Telegram-safe markdown formatting
- Log important events: `logger.info()`, `logger.debug()`, `logger.error()`
- Always run `typecheck` after making changes - it catches issues early

### Code Comments
- Minimal comments - code should be self-documenting
- Add comments only for complex business logic or workarounds
- No inline comments for obvious operations

### Testing
- No test framework configured (no test script in package.json)
- To add tests: install vitest or jest and configure in package.json
- Example test command pattern: `bun test <filename>` for running single test

### Dependencies & Libraries
- Grammy framework for Telegram Bot API
- Prisma ORM with PostgreSQL
- LangChain for AI chains and workflows
- Text Embeddings Inference for local multilingual embeddings
- pgvector for vector storage and search in PostgreSQL
- Pino logger for structured logging
- Remeda for functional utilities
- LRU Cache for performance optimization
- Telegramify-markdown for safe markdown formatting
- Node-cron for scheduled tasks

### Environment Variables
- All required env vars are validated in `src/config.ts`
- Missing env vars throw errors at startup
- See `.env.example` for required variables (TOKEN, ROUTERAI_API_KEY, etc.)
- Tokens exported from config: `import { token, routerAIToken } from './config'`
- Required vars: TOKEN, OPEN_WEATHER_TOKEN, YANDEX_CLOUD_TOKEN, YANDEX_S3_ID, YANDEX_S3_SECRET, ROUTERAI_API_KEY, EMBEDDING_BASE_URL, LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY

### Message Processing Flow
1. Save chat and user info (cached with LRU)
2. Check if bot should respond (greeting enabled, private chat, or @mention)
3. Save message to database
4. Generate local embeddings for text content
5. Search pgvector for similar user messages (context retrieval)
6. AI generates response using LangChain/AI SDK
7. Response formatted with telegramify-markdown
8. Bot reply sent and logged to database

### Adding New Features
1. Create feature file in `src/features/` (e.g., `new-feature.ts`)
2. Implement main function following existing patterns
3. Add controller in `src/controllers/` if needed
4. Register in `src/controllers/index.ts` if it handles messages
5. Add scheduled task in `src/scheduler.ts` if needed
6. Update Prisma schema if new data required
7. Run `bun run db:generate` after schema changes
