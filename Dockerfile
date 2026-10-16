# ── Стадия сборки ───────────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN NODE_OPTIONS=--max-old-space-size=3072 npm run build

# Прод-зависимости отдельно (без dev)
RUN npm prune --omit=dev

# ── Стадия рантайма ─────────────────────────────────────────
FROM postgres:16-bookworm AS runtime
WORKDIR /app
ENV NODE_ENV=production

# PostgreSQL 16 даёт совместимый pg_dump; Node 20 нужен для приложения.
COPY --from=node:20-bookworm-slim /usr/local/bin/node /usr/local/bin/node
RUN useradd --create-home --uid 1000 --shell /bin/bash app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER app
EXPOSE 3000
ENTRYPOINT []

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
