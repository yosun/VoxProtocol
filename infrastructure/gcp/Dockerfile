FROM node:22-bookworm-slim AS build
WORKDIR /workspace
ARG VITE_API_URL=https://vox.gold
ARG VITE_REALIZE_DEVNET_ENABLED=false
ARG VITE_REALIZE_MAINNET_ENABLED=false
ARG VITE_SOLANA_CLUSTER=devnet
ARG VITE_SOLANA_RPC_URL=https://api.devnet.solana.com
ENV VITE_API_URL=$VITE_API_URL \
    VITE_REALIZE_DEVNET_ENABLED=$VITE_REALIZE_DEVNET_ENABLED \
    VITE_REALIZE_MAINNET_ENABLED=$VITE_REALIZE_MAINNET_ENABLED \
    VITE_SOLANA_CLUSTER=$VITE_SOLANA_CLUSTER \
    VITE_SOLANA_RPC_URL=$VITE_SOLANA_RPC_URL
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/settlement ./apps/settlement
COPY apps/web ./apps/web
COPY docs ./docs
COPY workers ./workers
COPY integrations ./integrations
RUN npm ci
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/package.json /workspace/package-lock.json /workspace/tsconfig.base.json ./
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/apps/api ./apps/api
COPY --from=build /workspace/apps/web/dist ./apps/web/dist
COPY --from=build /workspace/docs ./docs
COPY --from=build /workspace/workers/anchor ./workers/anchor
COPY --from=build /workspace/apps/settlement ./apps/settlement
EXPOSE 8080
USER node
CMD ["node", "apps/api/dist/server.js"]
