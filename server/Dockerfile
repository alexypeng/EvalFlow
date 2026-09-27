FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@8.14.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/package.json

RUN pnpm install --frozen-lockfile

COPY server ./server

WORKDIR /app/server

# prisma.config.ts requires DATABASE_URL, but generate never connects to the
# database. The real URL is provided at runtime (see docker-compose.yml).
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build pnpm exec prisma generate
RUN pnpm build

EXPOSE 3000

CMD ["pnpm", "start:api"]