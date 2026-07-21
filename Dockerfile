# Philomatic server + workbench in one container: `docker compose up`, open http://localhost:4321
FROM node:22-slim

WORKDIR /app

# pnpm via corepack, pinned by package.json's packageManager field
RUN corepack enable

# Dependency layer first, so source edits don't bust the install cache.
# (better-sqlite3 fetches a prebuilt binary for linux x64/arm64 — no toolchain needed.)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ui/package.json ui/
COPY obsidian/package.json obsidian/
RUN pnpm install --frozen-lockfile

COPY . .

# The server serves the built viewer from ui/dist at GET /
RUN pnpm ui:build

ENV NODE_ENV=production
EXPOSE 4321

# 0.0.0.0: the server's local-first default (127.0.0.1) is unreachable through the port map.
# tsx directly (not via pnpm) so the node process is PID 1 and receives signals.
CMD ["./node_modules/.bin/tsx", "src/server/ingest.ts", "--host", "0.0.0.0"]
