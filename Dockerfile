# syntax=docker/dockerfile:1

# ---- dependencies (all packages, dev included) -------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build -------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- test runner (keeps devDependencies) -------------------------------------
FROM deps AS test
WORKDIR /app
COPY . .
CMD ["npm", "test"]

# ---- runtime -----------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# migrations are plain SQL, applied by dist/db/migrate.js on startup
COPY drizzle ./drizzle
EXPOSE 3000
# Apply migrations, then serve. Migrations run before the server accepts traffic.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]