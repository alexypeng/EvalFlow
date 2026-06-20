FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@8.14.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/package.json

RUN pnpm install --frozen-lockfile

COPY server ./server

WORKDIR /app/server

RUN pnpm exec prisma generate
RUN pnpm build

EXPOSE 3000

CMD ["pnpm", "start:api"]