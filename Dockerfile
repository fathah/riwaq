# --- deps: production dependencies only ---
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- runtime: slim, non-root, prod deps only ---
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Only what the app needs at runtime — no dev toolchain (vitest, drizzle-kit, tsc).
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Drop root.
RUN addgroup --system --gid 1001 riwaq \
  && adduser --system --uid 1001 --ingroup riwaq riwaq \
  && chown -R riwaq:riwaq /app
USER riwaq
EXPOSE 3000
# tsx (a runtime dependency) executes the TypeScript entrypoint directly.
CMD ["npm", "run", "start"]
