# ---- build stage: install everything, compile TypeScript ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && rm -rf dist/test \
 && npm prune --omit=dev

# ---- runtime stage: production dependencies + compiled output only ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# The MCP server listens on 8080 inside the container; map it to any host port with HOST_PORT.
ENV PORT=8080
EXPOSE 8080

# Liveness only (no downstream calls). /ready additionally checks the DataWarehouse-API.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run as the unprivileged user that ships with the node image.
USER node

# DW_API_BASE_URL / DW_API_USERNAME / DW_API_PASSWORD / MCP_BASIC_AUTH_USERNAME /
# MCP_BASIC_AUTH_PASSWORD are supplied at `docker run` time (see docker-compose.yml) - never baked in.
CMD ["node", "dist/server.js"]
