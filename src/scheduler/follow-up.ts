import { Bot } from "grammy";
import dayjs from "dayjs";
import { runScheduledAgent } from "../agent/agent";
import { taskService } from "../services/task.service";
import logger from "../utils/logger";

const STALE_AFTER_HOURS = 4;
const ESCALATE_AFTER_HOURS = 24;
const MAX_TASKS_PER_RUN = 20;
const DM_DELAY_MS = 500;

interface FollowUpRunOptions {
  staleAfterHours?: number;
  escalateAfterHours?: number;
}

export interface FollowUpRunResult {
  processed: number;
  dmSent: number;
  dmFailed: number;
  dmForbidden: number;
  escalationsPosted: number;
}

type FollowUpTask = Awaited<ReturnType<typeof taskService.findStaleTasks>>[number];
type FollowUpTaskResult = Pick<
  FollowUpRunResult,
  "dmSent" | "dmFailed" | "dmForbidden" | "escalationsPosted"
>;

export async function runFollowUps(
  bot: Bot,
  options: FollowUpRunOptions = {},
): Promise<FollowUpRunResult> {
  const result: FollowUpRunResult = {
    processed: 0,
    dmSent: 0,
    dmFailed: 0,
    dmForbidden: 0,
    escalationsPosted: 0,
  };

  const staleAfterHours = options.staleAfterHours ?? STALE_AFTER_HOURS;
  const escalateAfterHours =
    options.escalateAfterHours ?? ESCALATE_AFTER_HOURS;

  const staleTasks = await taskService.findStaleTasks(staleAfterHours);
  const tasksToProcess = staleTasks.slice(0, MAX_TASKS_PER_RUN);

  if (!tasksToProcess.length) {
    logger.info("No stale tasks found - skipping follow-ups");
    return result;
  }

  logger.info(
    { count: tasksToProcess.length, staleAfterHours, escalateAfterHours },
    "Processing stale tasks for follow-up",
  );

  for (const task of tasksToProcess) {
    if (!task.assignee) {
      logger.debug({ taskId: task.id }, "Skipping stale task - no assignee");
      continue;
    }

    try {
      result.processed += 1;
      const taskResult = await processFollowUp(bot, task, escalateAfterHours);
      result.dmSent += taskResult.dmSent;
      result.dmFailed += taskResult.dmFailed;
      result.dmForbidden += taskResult.dmForbidden;
      result.escalationsPosted += taskResult.escalationsPosted;
    } catch (err) {
      logger.error({ err, taskId: task.id }, "Follow-up failed for task");
    }

    await sleep(DM_DELAY_MS);
  }

  return result;
}

async function processFollowUp(
  bot: Bot,
  task: FollowUpTask,
  escalateAfterHours: number,
): Promise<FollowUpTaskResult> {
  const taskResult: FollowUpTaskResult = {
    dmSent: 0,
    dmFailed: 0,
    dmForbidden: 0,
    escalationsPosted: 0,
  };

  const assignee = task.assignee!;
  const lastUpdate = task.updates[0];
  const lastUpdatedAt = lastUpdate?.createdAt ?? task.createdAt;
  const hoursSince = dayjs().diff(dayjs(lastUpdatedAt), "hour");
  const shouldEscalate = hoursSince >= escalateAfterHours;

  logger.debug(
    {
      taskId: task.id,
      assignee: assignee.telegramHandle,
      hoursSince,
      shouldEscalate,
    },
    "Processing follow-up",
  );

  const prompt = buildFollowUpPrompt(
    task,
    lastUpdate,
    hoursSince,
    shouldEscalate,
    escalateAfterHours,
  );

  const { reply, pendingDMs } = await runScheduledAgent(
    prompt,
    task.project.id,
    `dm_${assignee.telegramUserId}`,
  );

  for (const dm of pendingDMs) {
    try {
      await bot.api.sendMessage(Number(assignee.telegramUserId), dm.message);
      taskResult.dmSent += 1;
      logger.info(
        { taskId: task.id, handle: assignee.telegramHandle },
        "Follow-up DM sent",
      );
    } catch (err) {
      const maybeGrammy = err as { error_code?: number; description?: string };
      const isForbiddenDm =
        maybeGrammy?.error_code === 403 &&
        maybeGrammy?.description?.includes("can't initiate conversation with a user");

      if (isForbiddenDm) {
        taskResult.dmForbidden += 1;
        logger.warn(
          {
            handle: assignee.telegramHandle,
            telegramUserId: assignee.telegramUserId.toString(),
          },
          "DM blocked by Telegram policy: user must open a PRIVATE chat with the bot and send /start there (group /start does not count)",
        );
      } else {
        taskResult.dmFailed += 1;
        logger.warn(
          { err, handle: assignee.telegramHandle },
          "Could not send DM",
        );
      }
    }
  }

  if (shouldEscalate && reply.trim()) {
    try {
      await bot.api.sendMessage(Number(task.project.groupChatId), reply);
      taskResult.escalationsPosted += 1;
      logger.info({ taskId: task.id }, "Group escalation posted");
    } catch (err) {
      logger.error({ err, taskId: task.id }, "Failed to post group escalation");
    }
  }

  await taskService.markChecked(task.id);
  return taskResult;
}

function buildFollowUpPrompt(
  task: FollowUpTask,
  lastUpdate: { content: string; createdAt: Date } | undefined,
  hoursSince: number,
  shouldEscalate: boolean,
  escalateAfterHours: number,
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
      `This task has been silent for over ${escalateAfterHours} hours.`,
      "Do two things:",
      `1. Use send_dm to send a firm but friendly DM to @${assignee.telegramHandle} asking for an immediate update.`,
      "2. Compose a short group escalation message (returned as your reply) so the team is aware.",
      "The group message should be non-blaming - just flag that the task needs attention.",
    );
  } else {
    lines.push(
      `This task has not been updated in ${hoursSince} hours.`,
      `Use send_dm to send a brief, friendly DM to @${assignee.telegramHandle} asking for a quick status update.`,
      "Do NOT post anything to the group chat. This is a private check-in only.",
    );
  }

  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
