# syntax=docker/dockerfile:1
#
# Multi-stage build for the Webhook Registry + Dispatcher service.
#
#   docker build -t webhook-registry .
#   docker run --rm -p 3000:3000 -e PERSISTENCE=memory webhook-registry
#
# For DynamoDB persistence, pass AWS config through the environment
# (-e PERSISTENCE=dynamodb -e AWS_REGION=... plus credentials via the SDK
# provider chain — e.g. mount ~/.aws read-only, or pass AWS_* env vars).

# ---- build ---------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

# Install with the lockfile for a reproducible build.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production dependencies for the runtime image.
RUN npm ci --omit=dev

# ---- runtime ------------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# node:24-slim ships a non-root "node" user (uid 1000).
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
# Served by GET /openapi.yaml and read from the working directory at startup.
COPY --chown=node:node openapi.yaml ./openapi.yaml
COPY --chown=node:node package.json ./package.json

USER node
EXPOSE 3000

# `node` is PID 1 so SIGTERM reaches the app's graceful-shutdown handler
# directly. Run the container with `--init` if you want a zombie reaper
# (this app spawns no child processes, so it is not required).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
