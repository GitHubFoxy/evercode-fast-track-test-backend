FROM node:18-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev \
    && node -e "const { SqliteDatabase } = require('./dist/database'); const db = new SqliteDatabase(':memory:'); db.prepare('SELECT 1').get(); db.close();"

FROM node:18-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/evercode.sqlite
WORKDIR /app
COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/dist ./dist
VOLUME ["/data"]
EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]
