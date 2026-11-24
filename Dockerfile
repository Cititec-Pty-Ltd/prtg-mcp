# Multi-stage build for efficient container size
FROM node:22-alpine AS builder

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS production

RUN apk -U upgrade --no-cache

RUN addgroup -g 1001 -S prtg && \
    adduser -S prtg -u 1001 -G prtg

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

RUN chown -R prtg:prtg /app

# Remove bundled npm/npx from the runtime image - not needed at runtime; CMD
# runs node directly, and this trims a class of Trivy findings against npm's
# own bundled dependencies in the base image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER prtg

# stdio only: the Cititec MCP host runs one container per connection
# (docker run --rm -i) with the service's env file
# (PRTG_URL, PRTG_API_TOKEN, PRTG_ACCEPT_SELF_SIGNED, PRTG_TIME_ZONE). There is no HTTP listener.
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=stdio

CMD ["node", "dist/index.js"]

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

LABEL version="${VERSION}"
LABEL description="PRTG MCP Server - Model Context Protocol server for Paessler PRTG Network Monitor"
LABEL org.opencontainers.image.title="prtg-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for Paessler PRTG Network Monitor (classic HTTP API, read-only)"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/Cititec-Pty-Ltd/prtg-mcp"
LABEL org.opencontainers.image.vendor="Cititec Pty Ltd"
LABEL org.opencontainers.image.licenses="Apache-2.0"
