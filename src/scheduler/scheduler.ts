// src/scheduler/scheduler.ts
// Registers all cron jobs for proactive agent behavior.
// This is what makes the bot "agentic", it acts without being asked.
// All jobs are started once at startup from index.ts via startScheduler().
//
// ─────────────────────────────────────────────────────────
// CRON JOBS
// ─────────────────────────────────────────────────────────
//
//  Daily Summary  → every day at 9:00 AM
//                   Posts a standup summary to every project group
//
//  Follow-ups     → every 4 hours (12AM, 4AM, 8AM, 12PM, 4PM, 8PM)
//                   DMs team members about stale IN_PROGRESS or BLOCKED tasks
//
//  Overdue Alert  → every day at 10:00 AM
//                   Posts overdue tasks to the group + DMs the assignees
//
// ─────────────────────────────────────────────────────────

import cron from "node-cron";
import { Bot } from "grammy";
import { runDailySummary } from "./daily-summary";
import { runFollowUps } from "./follow-up";
import logger from "../utils/logger";

export function startScheduler(bot: Bot): void {
  const TZ = "Asia/Kolkata";

  // ── Daily Summary — 9:00 AM IST every day ──
  // Posts a concise standup to every project group chat.
  // Gives the team a consistent morning briefing without anyone asking.
  cron.schedule("0 9 * * *", async () => {
    logger.info("⏰ Cron triggered: daily summary");
    try {
      await runDailySummary(bot);
    } catch (err) {
      // Catch here so one failed project doesn't stop the whole cron job
      logger.error({ err }, "Daily summary cron job failed");
    }
  }, { timezone: TZ });

  // ── Proactive Follow-ups - every 4 hours ──
  // Finds tasks that haven't been updated in 4+ hours.
  // Sends friendly DMs asking for a status update.
  // If ignored for 24h, escalates gently in the group.
  cron.schedule("0 */4 * * *", async () => {
    logger.info("⏰ Cron triggered: follow-up check");
    try {
      await runFollowUps(bot);
    } catch (err) {
      logger.error({ err }, "Follow-up cron job failed");
    }
  }, { timezone: TZ });

  // ── Overdue Alert - 10:00 AM IST every day ──
  // Runs after the daily summary to flag any tasks past their due date.
  // Posts directly to group without agent, simple and fast.
  cron.schedule("0 10 * * *", async () => {
    logger.info("⏰ Cron triggered: overdue alert");
    try {
      await runOverdueAlert(bot);
    } catch (err) {
      logger.error({ err }, "Overdue alert cron job failed");
    }
  }, { timezone: TZ });

  logger.info(
    "📅 Scheduler started — daily@9AM IST · follow-ups every 4h · overdue@10AM IST",
  );
}

// ─────────────────────────────────────────────────────────
// OVERDUE ALERT
// Simple function, no agent needed, just a formatted DB query + message.
// Kept here rather than its own file since it's a small, self-contained job.
// ─────────────────────────────────────────────────────────

async function runOverdueAlert(bot: Bot): Promise<void> {
  // Lazy import to avoid circular dependency issues at startup
  const { prisma } = await import("../db/prisma");

  // Find all projects that have at least one overdue task
  const projects = await prisma.project.findMany({
    include: {
      tasks: {
        where: {
          dueDate: { lt: new Date() }, // due date is in the past
          status: { notIn: ["DONE", "IN_REVIEW"] }, // not already finished
        },
        include: { assignee: true },
      },
    },
  });

  for (const project of projects) {
    // Skip projects with no overdue tasks
    if (!project.tasks.length) continue;

    const lines = project.tasks.map(
      (t) =>
        `🔴 #${t.id.slice(0, 6)} "${t.title}" — @${t.assignee?.telegramHandle ?? "unassigned"}`,
    );

    const message =
      `⚠️ Overdue Tasks - Action Required\n\n` +
      `${lines.join("\n")}\n\n` +
      `These tasks are past their due date. Please update their status or due date.`;

    try {
      await bot.api.sendMessage(Number(project.groupChatId), message);
      logger.info(
        { projectId: project.id, count: project.tasks.length },
        "Overdue alert sent",
      );
    } catch (err) {
      // Log and continue, one failed send shouldn't stop other projects
      logger.error(
        { err, projectId: project.id },
        "Failed to send overdue alert",
      );
    }
  }
}
