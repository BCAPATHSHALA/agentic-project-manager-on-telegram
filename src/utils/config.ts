// src/utils/config.ts
// Bun automatically loads .env file - no dotenv import needed

function required(key: string): string {
  const val = Bun.env[key];
  if (!val) {
    throw new Error(
      `Missing required environment variable: "${key}"\n` +
        `   → Add it to your .env file and restart.`,
    );
  }
  return val;
}

function optional(key: string, fallback: string): string {
  return Bun.env[key] ?? fallback;
}

export const config = {
  // Telegram
  BOT_TOKEN: required("BOT_TOKEN"),

  // OpenAI
  OPENAI_API_KEY: required("OPENAI_API_KEY"),

  // Database
  DATABASE_URL: required("DATABASE_URL"),

  // App
  NODE_ENV: optional("NODE_ENV", "development"),
  LOG_LEVEL: optional("LOG_LEVEL", "info"),

  // Helpers
  isDev: Bun.env["NODE_ENV"] !== "production",
  isProd: Bun.env["NODE_ENV"] === "production",
} as const;

// Type export for use elsewhere
export type Config = typeof config;
