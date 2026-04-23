// src/index.ts
// Application entry point - bootstraps everything in the correct order.
//
// Startup sequence:
//  1. Validate all required environment variables (crash early if missing)
//  2. Connect to PostgreSQL via Prisma (crash if DB unreachable)
//  3. Create the Grammy bot instance
//  4. Register all command + message handlers
//  5. Start the cron scheduler (proactive follow-ups + daily summaries)
//  6. Register graceful shutdown handlers (SIGINT, SIGTERM)
//  7. Start long-polling - bot is now live and listening
//
// Why long-polling and not webhooks?
//  Long-polling is simpler to run locally and on Railway without
//  a public HTTPS URL. For production scale, switch to webhooks.

import { Bot } from "grammy";
import { config } from "./utils/config";
import { setupHandlers } from "./bot/handlers";
import { startScheduler } from "./scheduler/scheduler";
import { prisma } from "./db/prisma";
import logger from "./utils/logger";

// ─────────────────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info({ env: config.NODE_ENV }, "🚀 Starting Agentic PM...");

  // ── Step 1: Verify database connection ──
  // If the DB is unreachable at startup, there's no point running.
  // Fail loudly and immediately rather than silently later.
  try {
    await prisma.$connect();
    logger.info("✅ Database connected");
  } catch (err) {
    logger.fatal(
      { err },
      "❌ Database connection failed — cannot start without DB",
    );
    process.exit(1);
  }

  // ── Step 2: Create the Telegram bot instance ──
  // Grammy validates the BOT_TOKEN format but not its validity.
  // An invalid token will only surface when the bot tries to poll.
  const bot = new Bot(config.BOT_TOKEN);

  // ── Step 3: Register all handlers ──
  // All /commands and message:text listeners are set up here.
  setupHandlers(bot);
  logger.info("✅ Bot handlers registered");

  // ── Step 4: Start the cron scheduler ──
  // Registers all proactive jobs (follow-ups, daily summary, overdue alerts).
  // Must be started before bot.start() so jobs are ready when bot goes live.
  startScheduler(bot);

  // ── Step 5: Graceful shutdown ──
  // Railway and Docker send SIGTERM when redeploying or stopping.
  // SIGINT is sent when you press Ctrl+C locally.
  // We stop polling and disconnect from DB cleanly before exiting.
  process.once("SIGINT", () => shutdown(bot, "SIGINT"));
  process.once("SIGTERM", () => shutdown(bot, "SIGTERM"));

  // ── Step 6: Start bot (long-polling) ──
  // bot.start() blocks and continuously polls Telegram for new updates.
  // onStart fires once when the connection is confirmed, good for logging.
  await bot.start({
    onStart: (botInfo) => {
      logger.info(
        { username: botInfo.username, id: botInfo.id },
        `🤖 @${botInfo.username} is live and listening!`,
      );
    },
    // Tell Telegram to only send us message and callback_query updates.
    // Filtering here reduces bandwidth and speeds up polling.
    allowed_updates: ["message", "callback_query"],
  });
}

// ─────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// Called when process receives SIGINT (Ctrl+C) or SIGTERM (Railway deploy).
// Stops polling, disconnects from DB, then exits cleanly.
// ─────────────────────────────────────────────────────────

async function shutdown(bot: Bot, signal: string): Promise<void> {
  logger.info({ signal }, "Shutdown signal received - stopping gracefully...");
  try {
    await bot.stop();
    await prisma.$disconnect();
    logger.info("👋 Shutdown complete");
  } catch (err) {
    logger.error({ err }, "Error during shutdown");
  } finally {
    process.exit(0);
  }
}

// ─────────────────────────────────────────────────────────
// RUN
// ─────────────────────────────────────────────────────────

main().catch((err) => {
  // Any unhandled error during startup lands here
  logger.fatal({ err }, "💥 Fatal startup error - process exiting");
  process.exit(1);
});
