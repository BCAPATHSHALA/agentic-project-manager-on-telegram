// src/scheduler/follow-up.ts
// Proactive follow-up logic, the core "agentic" behavior of the bot.
// Runs every 4 hours via the cron scheduler.
//
// What it does:
//  1. Finds tasks that are IN_PROGRESS or BLOCKED and haven't been updated recently
//  2. Asks the AI agent whether and how to follow up
//  3. Sends a DM to the assignee if the agent decides to
//  4. If ignored for 24h, the agent escalates gently in the group chat
//  5. Updates lastCheckedAt so the same task isn't pinged again too soon
//
// Anti-spam rules (enforced here AND in the system prompt):
//  - Only follow up if lastCheckedAt is null or > 4 hours ago
//  - Max 20 tasks per run to avoid flooding
//  - 500ms delay between DMs to respect Telegram rate limits

import { Bot } from "grammy";
import { runScheduledAgent } from "../agent/agent";
import { taskService } from "../services/task.service";
import logger from "../utils/logger";
import dayjs from "dayjs";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

/** Tasks not checked in this many hours are considered stale */
const STALE_AFTER_HOURS = 4;

/** Tasks not updated in this many hours trigger group escalation */
const ESCALATE_AFTER_HOURS = 24;

/** Max tasks to process per run, prevents flooding */
const MAX_TASKS_PER_RUN = 20;

/** Delay between Telegram messages to respect rate limits */
const DM_DELAY_MS = 500;

// ─────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────

export async function runFollowUps(bot: Bot): Promise<void> {
  // Find all stale tasks, uses taskService to keep DB logic centralised
  const staleTasks = await taskService.findStaleTasks(STALE_AFTER_HOURS);
  const tasksToProcess = staleTasks.slice(0, MAX_TASKS_PER_RUN);

  if (!tasksToProcess.length) {
    logger.info("No stale tasks found — skipping follow-ups");
    return;
  }

  logger.info(
    { count: tasksToProcess.length },
    "Processing stale tasks for follow-up",
  );

  for (const task of tasksToProcess) {
    // Skip if no assignee, nobody to follow up with
    if (!task.assignee) {
      logger.debug({ taskId: task.id }, "Skipping stale task — no assignee");
      continue;
    }

    try {
      await processFollowUp(bot, task);
    } catch (err) {
      // Log and continue, one task failure must not stop the rest
      logger.error({ err, taskId: task.id }, "Follow-up failed for task");
    }

    // Small delay between tasks to avoid Telegram rate limits (30 msgs/sec max)
    await sleep(DM_DELAY_MS);
  }
}

// ─────────────────────────────────────────────────────────
// PROCESS ONE TASK
// Builds a context-rich prompt, runs the agent, sends DMs + escalation.
// ─────────────────────────────────────────────────────────

async function processFollowUp(
  bot: Bot,
  task: Awaited<ReturnType<typeof taskService.findStaleTasks>>[number],
): Promise<void> {
  const assignee = task.assignee!;
  const lastUpdate = task.updates[0]; // most recent update (preloaded)
  const lastUpdatedAt = lastUpdate?.createdAt ?? task.createdAt;
  const hoursSince = dayjs().diff(dayjs(lastUpdatedAt), "hour");
  const shouldEscalate = hoursSince >= ESCALATE_AFTER_HOURS;

  logger.debug(
    {
      taskId: task.id,
      assignee: assignee.telegramHandle,
      hoursSince,
      shouldEscalate,
    },
    "Processing follow-up",
  );

  // Build a context-rich prompt so the agent can make a smart decision
  const prompt = buildFollowUpPrompt(
    task,
    lastUpdate,
    hoursSince,
    shouldEscalate,
  );

  // Run the scheduled agent with no user context, no memory needed
  const { reply, pendingDMs } = await runScheduledAgent(
    prompt,
    task.project.id,
    `dm_${assignee.telegramUserId}`, // synthetic chatId for DM context
  );

  // Send any DMs the agent queued
  for (const dm of pendingDMs) {
    try {
      await bot.api.sendMessage(Number(assignee.telegramUserId), dm.message);
      logger.info(
        { taskId: task.id, handle: assignee.telegramHandle },
        "Follow-up DM sent",
      );
    } catch (err) {
      // User may not have started the bot in DM - non-fatal
      logger.warn(
        { err, handle: assignee.telegramHandle },
        "Could not send DM - user may not have started the bot",
      );
    }
  }

  // If the agent produced a reply AND this task should be escalated,
  // post the escalation message to the group chat
  if (shouldEscalate && reply.trim()) {
    try {
      await bot.api.sendMessage(Number(task.project.groupChatId), reply);
      logger.info({ taskId: task.id }, "Group escalation posted");
    } catch (err) {
      logger.error({ err, taskId: task.id }, "Failed to post group escalation");
    }
  }

  // Mark task as checked — prevents re-pinging for another 4 hours
  await taskService.markChecked(task.id);
}

// ─────────────────────────────────────────────────────────
// PROMPT BUILDER
// Gives the agent full context so it can decide exactly what to say.
// The agent decides: should I DM? What tone? Should I escalate?
// ─────────────────────────────────────────────────────────

function buildFollowUpPrompt(
  task: Awaited<ReturnType<typeof taskService.findStaleTasks>>[number],
  lastUpdate: { content: string; createdAt: Date } | undefined,
  hoursSince: number,
  shouldEscalate: boolean,
): string {
  const assignee = task.assignee!;
  const lines = [
    `Task: "${task.title}" (#${task.id.slice(0, 6)})`,
    `Status: ${task.status}`,
    `Assigned to: @${assignee.telegramHandle}`,
    `Last update: ${hoursSince} hours ago`,
    lastUpdate
      ? `Last update content: "${lastUpdate.content}"`
      : "No updates have been recorded for this task.",
    task.dueDate
      ? `Due date: ${dayjs(task.dueDate).format("DD MMM YYYY")} (${dayjs(task.dueDate).fromNow()})`
      : "No due date set.",
    "",
  ];

  if (shouldEscalate) {
    lines.push(
      `This task has been silent for over ${ESCALATE_AFTER_HOURS} hours.`,
      `Do two things:`,
      `1. Use send_dm to send a firm but friendly DM to @${assignee.telegramHandle} asking for an immediate update.`,
      `2. Compose a short group escalation message (returned as your reply) so the team is aware.`,
      `The group message should be non-blaming — just flag that the task needs attention.`,
    );
  } else {
    lines.push(
      `This task has not been updated in ${hoursSince} hours.`,
      `Use send_dm to send a brief, friendly DM to @${assignee.telegramHandle} asking for a quick status update.`,
      `Do NOT post anything to the group chat. this is a private check-in only.`,
    );
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
