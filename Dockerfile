## Multi-stage Dockerfile for production
## Builder stage: install deps and compile TypeScript
FROM node:20-slim AS builder
WORKDIR /app

# Install dependencies (including devDependencies for TypeScript build)
COPY package.json package-lock.json* ./
COPY tsconfig.json ./
RUN npm ci --silent

# Copy source and build
COPY . .
RUN npm run build
RUN npm prune --omit=dev


## Runner stage: smaller runtime image
FROM node:20-slim AS runner
WORKDIR /app

# Copy package files and only production node_modules from builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

# Copy compiled output and public assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./dist/public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/server.js"]
