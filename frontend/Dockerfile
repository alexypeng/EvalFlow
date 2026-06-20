FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@8.14.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/package.json

RUN pnpm install --frozen-lockfile

COPY frontend ./frontend

WORKDIR /app/frontend

EXPOSE 5173

CMD ["pnpm", "exec", "vite", "--host", "0.0.0.0"]
