// scripts/test-followup.ts
// Run with: bun run scripts/test-followup.ts
// Tests the follow-up scheduler manually without waiting for cron.

import { Bot } from "grammy";
import { config } from "../src/utils/config";
import { runFollowUps } from "../src/scheduler/follow-up";
import logger from "../src/utils/logger";

const bot = new Bot(config.BOT_TOKEN);
const staleAfterHours = Number(Bun.env.FOLLOWUP_TEST_STALE_HOURS ?? 0);
const escalateAfterHours = Number(Bun.env.FOLLOWUP_TEST_ESCALATE_HOURS ?? 24);

logger.info("🧪 Manually triggering follow-up scheduler...");

try {
  const result = await runFollowUps(bot, { staleAfterHours, escalateAfterHours });
  logger.info(
    {
      processed: result.processed,
      dmSent: result.dmSent,
      dmFailed: result.dmFailed,
      dmForbidden: result.dmForbidden,
      escalationsPosted: result.escalationsPosted,
    },
    "✅ Follow-up run complete",
  );

  if (result.dmForbidden > 0) {
    logger.warn(
      "Some DMs were blocked by Telegram. Send /start in a PRIVATE chat with @AgenticPM_bot (not in group), then rerun this test.",
    );
  }
} catch (err) {
  logger.error({ err }, "❌ Follow-up test failed");
}

process.exit(0);
