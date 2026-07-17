# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Runtime stage
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

RUN addgroup -S bankai && adduser -S bankai -G bankai
USER bankai

EXPOSE 4000
CMD ["node", "dist/server.js"]
