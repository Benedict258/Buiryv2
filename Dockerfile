# Buiry server image: API + MCP endpoint, background worker and migration task in one image.
#   docker build -t buiry .
#   docker run --rm -e ... buiry                          # BUIRY_ROLE=all (default)
#   docker run --rm -e BUIRY_ROLE=api ... buiry           # API service
#   docker run --rm -e BUIRY_ROLE=worker ... buiry        # worker service
#   docker run --rm ... buiry node dist-server/migrate.js # migration task (run before each deploy)
# The layout below was verified without Docker (pnpm deploy + bundle + protos + dashboard); a real docker build is
# LOCAL_CHECKS L-AWS1. Pin the base image by digest before production use (docs/DEPLOYMENT.md).

FROM node:22-bookworm-slim AS build
WORKDIR /src
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @buiry/dashboard exec vite build \
 && pnpm --filter @buiry/worker run build:server \
 && pnpm --filter @buiry/worker deploy --prod --legacy --config.node-linker=hoisted /out \
 && cp -r packages/worker/dist-server /out/dist-server \
 && cp -r packages/chain/proto /out/proto \
 && cp -r apps/dashboard/dist /out/dashboard \
 && rm -rf /out/src

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    BUIRY_PROTO_ROOT=/app/proto \
    DASHBOARD_DIR=/app/dashboard
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "if(process.env.BUIRY_ROLE==='worker')process.exit(0);fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/v1/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist-server/server.js"]
