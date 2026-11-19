FROM node:22-alpine
WORKDIR /app
COPY package.json server.js index.html manifest.webmanifest service-worker.js task-vault-icon.svg ./
ENV NODE_ENV=production PORT=4173 DATA_DIR=/app/data
EXPOSE 4173
CMD ["npm", "start"]
