# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @4veko/api --include-workspace-root=false
COPY apps/api apps/api
RUN npm run build -w @4veko/api && npm prune --omit=dev --workspace @4veko/api

FROM node:24-alpine
ENV NODE_ENV=production PORT=4000
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/package.json apps/api/package.json
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/drizzle apps/api/drizzle
WORKDIR /repo/apps/api
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
# Apply pending migrations, then serve.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
