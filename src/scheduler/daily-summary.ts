// src/scheduler/daily-summary.ts
// Generates and posts a daily standup summary to every project group.
// Runs at 9:00 AM every day via the cron scheduler.
//
// What it does:
//  1. Fetches all projects from the DB
//  2. For each project, loads all tasks with assignee info
//  3. Builds a structured prompt with task counts and categorized lists
//  4. Asks the AI agent to write a concise standup summary
//  5. Posts the summary to the project's Telegram group chat
//
// Design decisions:
//  - One message per project group, never multiple messages
//  - Agent writes the summary (natural, human-like tone)
//  - 1 second delay between projects to respect Telegram rate limits
//  - Non-fatal: one failed project doesn't stop others

import { Bot } from "grammy";
import { prisma } from "../db/prisma";
import { runScheduledAgent } from "../agent/agent";
import logger from "../utils/logger";
import dayjs from "dayjs";

// ─────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────

export async function runDailySummary(bot: Bot): Promise<void> {
  // Load all projects from the DB, each one gets its own summary message
  const projects = await prisma.project.findMany();

  if (!projects.length) {
    logger.info("No projects found - skipping daily summary");
    return;
  }

  logger.info(
    { count: projects.length },
    "Running daily summary for all projects",
  );

  for (const project of projects) {
    try {
      await generateAndSendSummary(bot, project);
    } catch (err) {
      // Log and continue - one project failing must not stop the rest
      logger.error(
        { err, projectId: project.id },
        "Daily summary failed for project",
      );
    }

    // Delay between projects to avoid Telegram rate limits
    await sleep(1000);
  }
}

// ─────────────────────────────────────────────────────────
// GENERATE AND SEND - for one project
// ─────────────────────────────────────────────────────────

async function generateAndSendSummary(
  bot: Bot,
  project: { id: string; name: string; groupChatId: string },
): Promise<void> {
  // Load all tasks for this project with assignee details
  const tasks = await prisma.task.findMany({
    where: { projectId: project.id },
    include: {
      assignee: true,
      updates: {
        orderBy: { createdAt: "desc" },
        take: 1, // only need the most recent update for context
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  // If no tasks exist yet, skip - nothing useful to summarize
  if (!tasks.length) {
    logger.info(
      { projectId: project.id },
      "No tasks found — skipping summary for this project",
    );
    return;
  }

  // Categorize tasks by status for the prompt
  const done = tasks.filter((t) => t.status === "DONE");
  const inProgress = tasks.filter((t) => t.status === "IN_PROGRESS");
  const blocked = tasks.filter((t) => t.status === "BLOCKED");
  const inReview = tasks.filter((t) => t.status === "IN_REVIEW");
  const todo = tasks.filter((t) => t.status === "TODO");
  const now = new Date();
  const overdue = tasks.filter(
    (t) => t.dueDate && t.dueDate < now && t.status !== "DONE",
  );

  // Build the prompt with categorized task data
  const prompt = buildSummaryPrompt({
    projectName: project.name,
    done,
    inProgress,
    blocked,
    inReview,
    todo,
    overdue,
  });

  // Run the agent to generate a natural-sounding summary
  const { reply } = await runScheduledAgent(
    prompt,
    project.id,
    project.groupChatId,
  );

  // Skip sending if agent returned nothing
  if (!reply.trim()) {
    logger.warn(
      { projectId: project.id },
      "Agent returned empty summary - skipping send",
    );
    return;
  }

  // Post the summary as plain text to avoid parse-mode failures
  const message = `📅 Daily Standup - ${dayjs().format("ddd, DD MMM YYYY")}\n\n${reply}`;

  await bot.api.sendMessage(Number(project.groupChatId), message);

  logger.info({ projectId: project.id }, "Daily summary posted successfully");
}

// ─────────────────────────────────────────────────────────
// PROMPT BUILDER
// Gives the agent structured task data so it can write a clean summary.
// The agent decides the exact wording, tone, and what to highlight.
// ─────────────────────────────────────────────────────────

interface SummaryPromptData {
  projectName: string;
  done: ReturnType<typeof filterTasks>;
  inProgress: ReturnType<typeof filterTasks>;
  blocked: ReturnType<typeof filterTasks>;
  inReview: ReturnType<typeof filterTasks>;
  todo: ReturnType<typeof filterTasks>;
  overdue: ReturnType<typeof filterTasks>;
}

// Helper type alias for the task shape returned by Prisma
type FilteredTask = {
  id: string;
  title: string;
  dueDate: Date | null;
  assignee: { telegramHandle: string | null } | null;
};

function filterTasks(tasks: FilteredTask[]): FilteredTask[] {
  return tasks;
}

function formatTaskList(tasks: FilteredTask[]): string {
  if (!tasks.length) return "  None";
  return tasks
    .map((t) => {
      const assignee = t.assignee?.telegramHandle
        ? `@${t.assignee.telegramHandle}`
        : "unassigned";
      const due = t.dueDate
        ? ` (due ${dayjs(t.dueDate).format("DD MMM")})`
        : "";
      return `  - "${t.title}" - ${assignee}${due}`;
    })
    .join("\n");
}

function buildSummaryPrompt(data: SummaryPromptData): string {
  const lines = [
    `Generate a concise daily standup summary for the Telegram group.`,
    `Project: ${data.projectName}`,
    `Date: ${dayjs().format("dddd, DD MMM YYYY")}`,
    ``,
    `DONE (${data.done.length}):`,
    formatTaskList(data.done),
    ``,
    `IN PROGRESS (${data.inProgress.length}):`,
    formatTaskList(data.inProgress),
    ``,
    `IN REVIEW (${data.inReview.length}):`,
    formatTaskList(data.inReview),
    ``,
    `BLOCKED (${data.blocked.length}):`,
    formatTaskList(data.blocked),
    ``,
    `TODO (${data.todo.length}):`,
    formatTaskList(data.todo),
  ];

  if (data.overdue.length) {
    lines.push(
      ``,
      `OVERDUE (${data.overdue.length}):`,
      formatTaskList(data.overdue),
    );
  }

  lines.push(
    ``,
    `Instructions:`,
    `- Keep the summary under 10 lines`,
    `- Use status emojis: ✅ Done 🔄 In Progress 👀 In Review 🚫 Blocked ⬜ Todo`,
    `- Highlight blockers and overdue tasks prominently`,
    `- End with one clear call-to-action if anything needs attention`,
    `- Do NOT repeat the date in the header if it is already in the message header`,
  );

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
