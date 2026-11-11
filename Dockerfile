# ==============================================================================
# Orion Space — Node.js Agent Backend Production Dockerfile
# ==============================================================================

FROM node:22-alpine AS runtime

WORKDIR /app

# Install curl for container health checks
RUN apk add --no-cache curl

# Copy package manifests and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application server code, analysis dataset, and config
COPY server/ ./server/
COPY src/agent/ ./src/agent/
COPY analysis/results/ ./analysis/results/
COPY .env.example ./

ENV NODE_ENV=production
ENV ORION_AGENT_PORT=3000
ENV ORION_AGENT_HOST=0.0.0.0

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/health || exit 1

CMD ["node", "server/agent/server.mjs"]

