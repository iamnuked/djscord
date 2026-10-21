FROM node:22.23.1-bookworm-slim AS test

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run lint \
    && pnpm exec tsc --noEmit \
    && pnpm test

CMD ["node", "--test", "tests/rendered-html.test.mjs"]
