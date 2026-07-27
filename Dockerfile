FROM oven/bun:1.3.9-alpine AS dependencies

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.9-alpine AS runtime

LABEL org.opencontainers.image.source="https://github.com/skrylnikov/Phoronis-tg-bot"
WORKDIR /app
ENV NODE_ENV=production
ENV HEALTH_PORT=3000

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

USER bun
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
