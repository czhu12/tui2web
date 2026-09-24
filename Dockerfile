# tui2web relay: serves the web viewer and pairs CLI agents with viewers.
#   docker build -t tui2web-relay .
#   docker run -p 8787:8787 -e PUBLIC_URL=https://tui2web.com tui2web-relay

# ---- build the web viewer ----
FROM node:26-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/web/package.json packages/web/
RUN npm ci --workspace @tui2web/web --ignore-scripts
# packages/web/tsconfig.json extends this, and Vite reads it while transforming.
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/web packages/web
RUN npm run build --workspace @tui2web/web

# ---- relay runtime ----
FROM node:26-slim
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
# Only the relay's dependencies; the CLI's native node-pty is never installed.
RUN npm ci --workspace @tui2web/server --omit=dev --ignore-scripts && npm cache clean --force
COPY packages/protocol/src packages/protocol/src
COPY packages/server/src packages/server/src
COPY --from=web /app/packages/web/dist packages/web/dist

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# TypeScript sources run directly via Node's built-in type stripping.
CMD ["node", "packages/server/src/index.ts"]
