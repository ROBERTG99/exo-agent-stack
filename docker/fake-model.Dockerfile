# syntax=docker/dockerfile:1
# fake-model image: esbuild bundle on a slim Node runtime. Installs no OS packages; builds behind a proxy via HTTPS_PROXY.
FROM node:22-slim AS build
ARG HTTPS_PROXY
ENV HTTPS_PROXY=${HTTPS_PROXY}
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter . --filter @exos/fake-model... \
 && node scripts/bundle.mjs fake-model

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/fake-model/dist/server.mjs ./server.mjs
USER 1000:1000
EXPOSE 9840
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9840/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
