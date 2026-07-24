FROM node:22.13.1-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY packages/relay/package.json packages/relay/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/plugin/package.json packages/plugin/package.json
RUN npm ci --workspace @vault-relay/oauth-relay --include-workspace-root=false
COPY packages/relay packages/relay
RUN npm run build --workspace @vault-relay/oauth-relay

FROM node:22.13.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/packages/relay/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "dist/server.js"]
