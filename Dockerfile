# gum-bot: one Node process serving the runner, the dashboard and /metrics.
FROM node:24-slim AS build
WORKDIR /app
# pnpm at the version pinned in package.json's "packageManager".
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY dev ./dev
COPY scripts ./scripts
COPY web ./web
RUN pnpm build && pnpm prune --prod

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
# SIGTERM → the bot stops starting cycles, lets in-flight payments land, persists and exits.
STOPSIGNAL SIGTERM
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/src/index.js"]
