import "dotenv/config";
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

function withRequiredSsl(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const protocol = url.protocol.toLowerCase();
    const isPostgres = protocol === "postgres:" || protocol === "postgresql:";

    if (!isPostgres) {
      return connectionString;
    }

    const hostname = url.hostname.toLowerCase();
    const isLocalHost =
      hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    if (isLocalHost) {
      return connectionString;
    }

    if (!url.searchParams.has("sslmode")) {
      url.searchParams.set("sslmode", "require");
    }

    return url.toString();
  } catch {
    // If parsing fails, keep the original value so Prisma surfaces a clear error.
    return connectionString;
  }
}

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString?.trim()) {
    throw new Error("DATABASE_URL is not set or is empty");
  }

  const adapter = new PrismaPg({
    connectionString: withRequiredSsl(connectionString),
  });

  return new PrismaClient({
    adapter,
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined;
};

const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export { prisma };
