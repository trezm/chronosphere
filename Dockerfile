# Chronosphere runs on Node with a file-backed SQLite database (see db/index.ts).
# Debian rather than Alpine: @libsql/client ships prebuilt glibc binaries.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# `vinext start` is a devDependency and the server applies ./drizzle migrations
# at boot, so the runtime keeps the whole built checkout.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    SQLITE_PATH=/data/chronosphere.sqlite
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["npm", "run", "start"]
