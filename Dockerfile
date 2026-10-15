FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY scripts/ ./scripts/

ENV NODE_ENV=production

CMD ["node", "scripts/mcp-introspect.mjs"]
