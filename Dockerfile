FROM oven/bun:1

WORKDIR /app

# Install dependencies (cached layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Generate Prisma client
RUN bunx prisma generate

# Run migrations then start bot
CMD sh -c "bunx prisma migrate deploy && bun src/index.ts"
