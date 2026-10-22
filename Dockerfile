# syntax=docker/dockerfile:1

# ── Зависимости (кэш не зависит от исходников) ──────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# Прод-зависимости готовим до копирования кода: изменение src не запускает prune.
FROM deps AS prod-deps
RUN --mount=type=cache,target=/root/.npm \
    npm prune --omit=dev --no-audit --no-fund

# ── Стадия сборки ───────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY scripts/copy-assets.mjs ./scripts/copy-assets.mjs
RUN NODE_OPTIONS=--max-old-space-size=3072 npm run build

# ── Стадия рантайма ─────────────────────────────────────────
FROM postgres:16-bookworm AS runtime
WORKDIR /app
ENV NODE_ENV=production

# PostgreSQL 16 даёт совместимый pg_dump; Node 20 нужен для приложения.
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
RUN useradd --create-home --uid 1000 --shell /bin/bash app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER app
EXPOSE 3000
ENTRYPOINT []

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
