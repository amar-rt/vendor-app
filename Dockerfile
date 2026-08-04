# syntax=docker/dockerfile:1

# ---- build: full toolchain (vite/typescript etc.) to compile the SSR bundle ----
FROM node:20-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- runtime: prod-only deps + the compiled output, nothing else ----
FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
EXPOSE 3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# prisma/ is needed at container start: `docker-start` runs `prisma generate`
# (so the query engine matches this exact runtime image) and
# `prisma migrate deploy` (applies pending migrations) before serving.
COPY --from=build /app/build ./build
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/public ./public
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "run", "docker-start"]
