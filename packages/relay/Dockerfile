# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/relay/package.json packages/relay/package.json
RUN npm ci --workspace=packages/relay --include-workspace-root=false --ignore-scripts

COPY packages/relay packages/relay
RUN npm run build --workspace=packages/relay

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/relay/package.json packages/relay/package.json
RUN npm ci --workspace=packages/relay --include-workspace-root=false --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY --from=build /app/packages/relay/dist packages/relay/dist

USER node
EXPOSE 8787
CMD ["node", "packages/relay/dist/cli.js"]
