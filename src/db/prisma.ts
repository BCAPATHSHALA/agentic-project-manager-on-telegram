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

    const currentSslMode = url.searchParams.get("sslmode")?.toLowerCase();
    const useLibpqCompat =
      url.searchParams.get("uselibpqcompat")?.toLowerCase() === "true";
    const legacyAliasModes = new Set(["prefer", "require", "verify-ca"]);

    // pg/pg-connection-string will change semantics for some sslmode values.
    // Default to verify-full now (current secure behavior) unless the URL
    // explicitly opts into libpq compatibility.
    if (!currentSslMode) {
      url.searchParams.set("sslmode", "verify-full");
    } else if (legacyAliasModes.has(currentSslMode) && !useLibpqCompat) {
      url.searchParams.set("sslmode", "verify-full");
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
