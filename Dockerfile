FROM node:22.23.1-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS test
COPY . .
RUN npm run check && npm test && npm run lint

FROM dependencies AS build
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22.23.1-alpine AS production
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
CMD ["node", "dist/index.js"]

