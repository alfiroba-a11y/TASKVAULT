FROM node:22-alpine
WORKDIR /app
COPY package.json server.js index.html manifest.webmanifest service-worker.js task-vault-icon.svg ./
RUN apk add --no-cache curl \
    && (npm install --omit=dev --no-audit --no-fund || echo "WARNING: optional MongoDB driver install failed; app will launch in degraded mode")
ENV NODE_ENV=production PORT=4173
EXPOSE 4173
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 CMD curl --fail --silent http://127.0.0.1:4173/health || exit 1
CMD ["npm", "start"]
