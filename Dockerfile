FROM oven/bun:1.3.9-alpine AS runtime

LABEL org.opencontainers.image.source="https://github.com/skrylnikov/Phoronis-tg-bot"
WORKDIR /app
ENV NODE_ENV=production
ENV HEALTH_PORT=3000

RUN apk upgrade --no-cache
COPY package.json bun.lock tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build bun install --frozen-lockfile --production --omit=dev --omit=optional --omit=peer
COPY src ./src

USER bun
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
