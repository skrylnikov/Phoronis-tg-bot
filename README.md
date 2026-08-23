# Phoronis Telegram Bot

A sophisticated Telegram bot with AI capabilities, context awareness, and user behavior tracking.

## Improvements Made

### 1. Enhanced Error Handling
- Added `handleError` utility function for consistent error logging
- Added `isTelegramError` type guard for better error identification
- Improved error handling throughout the application with better context information

### 2. Better Type Safety
- Added proper TypeScript types to all functions
- Improved type definitions for database models and API responses
- Enhanced type safety in message processing

### 3. Robust Database Operations
- Added try-catch blocks around database operations
- Added error handling to saveChat, saveUser, and saveMessage functions
- Better caching with error recovery

### 4. Testing Framework Setup
- Added vitest as dev dependency
- Created basic test structure for error handling utilities
- Prepared foundation for comprehensive unit testing

## Architecture

### Core Components
- **Telegram Integration**: Grammy.js framework for Telegram API
- **Database**: PostgreSQL with Prisma ORM
- **AI Services**: RouterAI via the Vercel AI SDK with Gemini models
- **Context Management**: PostgreSQL with pgvector and local multilingual embeddings
- **Observability**: Langfuse for prompt management and tracing

### Code Structure
```
src/
├── controllers/       - Bot message handlers and route logic
├── ai/              - AI/LLM integration (AI SDK, RouterAI, TEI)
├── tools/           - Utility functions organized by domain
├── features/        - Feature implementations (selfie-saturday, etc.)
├── shared/          - Shared utilities and helpers
├── generated/prisma/ - Generated Prisma client
├── bot.ts           - Bot initialization and context type
├── db.ts            - Prisma client export
├── config.ts        - Environment configuration and validation
├── logger.ts        - Pino logger instance
├── scheduler.ts     - Cron job scheduler
└── index.ts         - Application entry point
```

## Development

### Running the Bot
```bash
# Install dependencies
bun install

# Run in development mode with auto-reload
bun run dev

# Run in production mode
bun run start

# Run type checking
bun run typecheck

# Run linter
bun run lint
```

### Testing
```bash
# Run the unit test suite
bun run test
```

## Configuration

Create a `.env` file with the following variables:
```
TOKEN=your_telegram_bot_token
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/phoronis
BOT_MODE=polling
WEBHOOK_URL=
WEBHOOK_SECRET=
OPEN_WEATHER_TOKEN=your_openweather_token
YANDEX_CLOUD_TOKEN=your_yandex_cloud_token
YANDEX_S3_ID=your_yandex_s3_id
YANDEX_S3_SECRET=your_yandex_s3_secret
ROUTERAI_API_KEY=your_routerai_key
PAYMENT_SUPPORT_CONTACT=@your_support_username
ANALYTICS_CHAT_ID=your_private_telegram_chat_id
EMBEDDING_BASE_URL=http://localhost:3001
EMBEDDING_MODEL=intfloat/multilingual-e5-small
EMBEDDING_VERSION=1
EMBEDDING_TIMEOUT_MS=2000
LANGFUSE_SECRET_KEY=your_langfuse_secret_key
LANGFUSE_PUBLIC_KEY=your_langfuse_public_key
QUEUE_NORMAL_WORKERS=3
JOB_WORKERS=1
SHUTDOWN_DRAIN_MS=30000
```

Local development uses long polling with `BOT_MODE=polling`. Use a separate
Telegram bot token for local development: Telegram cannot deliver updates for
the same token through both polling and a webhook at the same time. Production
uses `BOT_MODE=webhook`, `WEBHOOK_URL`, and `WEBHOOK_SECRET`.

## Features

- RouterAI-powered responses with context awareness
- User behavior tracking and fact analysis
- Memory management tools
- Image recognition and description
- Custom greeting settings for chats
- Private mode support
- Guest Mode support for answering mentions in chats where the bot isn't a member
- Media handling (photos, videos)

Guest Mode must also be enabled in the bot settings through BotFather's MiniApp.
