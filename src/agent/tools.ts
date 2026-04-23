// src/agent/tools.ts
// Defines all 10 tools the AI agent can call.
// Each tool uses the @openai/agents tool() factory with Zod parameter validation.
// The execute() function runs when the LLM decides to call that tool.
// Tools return a plain string that the LLM reads this string and decides what to say next.

import { tool } from "@openai/agents";
import { z } from "zod";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { taskService } from "../services/task.service";
import { projectService } from "../services/project.service";
import type { AgentContext } from "./agent";

dayjs.extend(relativeTime);

// ─────────────────────────────────────────────────────────
// EMOJI HELPERS
// ─────────────────────────────────────────────────────────

const statusEmoji = (s: string): string =>
  ({
    TODO: "⬜",
    IN_PROGRESS: "🔄",
    BLOCKED: "🚫",
    IN_REVIEW: "👀",
    DONE: "✅",
  })[s] ?? "❓";

const priorityEmoji = (p: string): string =>
  ({ LOW: "🟢", MEDIUM: "🟡", HIGH: "🟠", URGENT: "🔴" })[p] ?? "";

// Short ID helper — always show first 6 chars only
const shortId = (id: string) => id.slice(0, 6);

function requireAgentContext(
  ctx: { context?: unknown } | undefined,
): AgentContext {
  const context = ctx?.context as AgentContext | undefined;
  if (!context) {
    throw new Error("Missing agent context.");
  }
  return context;
}

// ─────────────────────────────────────────────────────────
// 1. CREATE TASK
// ─────────────────────────────────────────────────────────

export const createTaskTool = tool({
  name: "create_task",
  description:
    "Create a new task in the project. Use this when someone describes work that is not yet tracked.",
  parameters: z.object({
    title: z.string().describe("Short, clear task title"),
    description: z.string().nullable().describe(
      "More detail about what needs to be done. Use null if not provided.",
    ),
    assignee_handle: z.string().nullable().describe(
      "Telegram @handle of the person responsible. Use null if unassigned.",
    ),
    priority: z
      .enum(["LOW", "MEDIUM", "HIGH", "URGENT"])
      .nullable()
      .describe("Task priority. Use null to default to MEDIUM."),
    due_date: z
      .string()
      .nullable()
      .describe("Due date as ISO string e.g. 2025-05-01. Use null if unknown."),
  }),
  async execute(
    { title, description, assignee_handle, priority, due_date },
    ctx,
  ) {
    try {
      const context = requireAgentContext(ctx);
      const resolvedPriority = priority ?? "MEDIUM";
      const task = await taskService.create({
        title,
        description: description ?? undefined,
        assignee_handle: assignee_handle ?? undefined,
        priority: resolvedPriority,
        due_date: due_date ?? undefined,
        projectId: context.projectId,
      });
      const assignee = assignee_handle
        ? `@${assignee_handle.replace(/^@/, "")}`
        : "unassigned";
      const due = due_date ? ` · due ${dayjs(due_date).format("DD MMM")}` : "";
      return `✅ Task #${shortId(task.id)} created: "${task.title}" ${priorityEmoji(resolvedPriority)} → ${assignee}${due}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return `❌ Failed to create task: ${msg}`;
    }
  },
});

// ─────────────────────────────────────────────────────────
// 2. UPDATE TASK STATUS
// ─────────────────────────────────────────────────────────

export const updateTaskStatusTool = tool({
  name: "update_task_status",
  description:
    "Update the status of an existing task, and optionally update its description. Call record_status_update first if there is a note to save.",
  parameters: z.object({
    task_id: z.string().describe("Task ID — full UUID or first 6 characters"),
    status: z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE"]),
    description: z
      .string()
      .nullable()
      .describe("Optional new task description. Use null to keep existing description."),
    note: z
      .string()
      .nullable()
      .describe("Optional note explaining the status change. Use null if none."),
  }),
  async execute({ task_id, status, description, note }, ctx) {
    try {
      const context = requireAgentContext(ctx);
      const task = await taskService.updateStatus(
        task_id,
        status,
        description ?? undefined,
        note ?? undefined,
        context.userId,
      );
      return `${statusEmoji(status)} Task #${shortId(task.id)} "${task.title}" → ${status}${description ? "\n🧾 Description updated." : ""}${note ? `\n📝 ${note}` : ""}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return `❌ Failed to update task status: ${msg}`;
    }
  },
});

// ─────────────────────────────────────────────────────────
// 3. ASSIGN TASK
// ─────────────────────────────────────────────────────────

export const assignTaskTool = tool({
  name: "assign_task",
  description:
    "Assign or reassign a task to a team member. The member must have already run /join.",
  parameters: z.object({
    task_id: z.string().describe("Task ID — full UUID or first 6 characters"),
    assignee_handle: z
      .string()
      .describe("Telegram @handle of the new assignee"),
  }),
  async execute({ task_id, assignee_handle }, ctx) {
    try {
      const context = requireAgentContext(ctx);
      const task = await taskService.assign(
        task_id,
        assignee_handle,
        context.projectId,
      );
      return `📌 Task #${shortId(task.id)} "${task.title}" assigned to @${assignee_handle.replace(/^@/, "")}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return `❌ Failed to assign task: ${msg}`;
    }
  },
});

// ─────────────────────────────────────────────────────────
// 4. LIST TASKS
// ─────────────────────────────────────────────────────────

export const listTasksTool = tool({
  name: "list_tasks",
  description:
    "List tasks with optional filters by status, assignee, or priority. Use ALL to see every task.",
  parameters: z.object({
    status: z
      .enum(["TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "ALL"])
      .nullable()
      .describe("Status filter. Use ALL for no status filter, or null to default to ALL."),
    assignee_handle: z
      .string()
      .nullable()
      .describe("Filter by @handle. Use null for no assignee filter."),
    priority: z
      .enum(["LOW", "MEDIUM", "HIGH", "URGENT"])
      .nullable()
      .describe("Priority filter. Use null for no priority filter."),
  }),
  async execute({ status, assignee_handle, priority }, ctx) {
    try {
      const context = requireAgentContext(ctx);
      const resolvedStatus = status ?? "ALL";
      const tasks = await taskService.list(context.projectId, {
        status: resolvedStatus,
        assignee_handle: assignee_handle ?? undefined,
        priority: priority ?? undefined,
      });
      if (!tasks.length) return "No tasks found matching those filters.";
      return tasks
        .map((t) => {
          const assignee = t.assignee?.telegramHandle
            ? `@${t.assignee.telegramHandle}`
            : "unassigned";
          const due = t.dueDate
            ? ` · due ${dayjs(t.dueDate).format("DD MMM")}`
            : "";
          return `${statusEmoji(t.status)} ${priorityEmoji(t.priority)} #${shortId(t.id)} ${t.title} — ${assignee}${due}`;
        })
        .join("\n");
    } catch (err) {
      return `❌ Failed to list tasks: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  },
});

// ─────────────────────────────────────────────────────────
// 5. GET TASK DETAILS
// ─────────────────────────────────────────────────────────

export const getTaskDetailsTool = tool({
  name: "get_task_details",
  description:
    "Get full details and recent update history of a specific task. Always call this before following up on a task.",
  parameters: z.object({
    task_id: z.string().describe("Task ID — full UUID or first 6 characters"),
  }),
  async execute({ task_id }) {
    try {
      const task = await taskService.getDetails(task_id);
      if (!task) return `Task #${task_id} not found.`;
      const assignee = task.assignee?.telegramHandle
        ? `@${task.assignee.telegramHandle}`
        : "unassigned";
      const due = task.dueDate
        ? dayjs(task.dueDate).format("DD MMM YYYY")
        : "not set";
      const recentUpdates =
        task.updates
          .slice(0, 3)
          .map(
            (u) =>
              `  • ${dayjs(u.createdAt).fromNow()} — @${u.member.telegramHandle}: "${u.content}"`,
          )
          .join("\n") || "  No updates yet.";
      return [
        `📋 *${task.title}* (#${shortId(task.id)})`,
        `Status:   ${statusEmoji(task.status)} ${task.status}`,
        `Priority: ${priorityEmoji(task.priority)} ${task.priority}`,
        `Assignee: ${assignee}`,
        `Due:      ${due}`,
        `Created:  ${dayjs(task.createdAt).fromNow()}`,
        `Updated:  ${dayjs(task.updatedAt).fromNow()}`,
        `Recent updates:\n${recentUpdates}`,
      ].join("\n");
    } catch (err) {
      return `❌ Failed to get task details: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  },
});

// ─────────────────────────────────────────────────────────
// 6. GET MEMBER TASKS
// ─────────────────────────────────────────────────────────

export const getMemberTasksTool = tool({
  name: "get_member_tasks",
  description:
    "Get all active tasks assigned to a specific team member. Useful before assigning new work to check someone's workload.",
  parameters: z.object({
    member_handle: z.string().describe("Telegram @handle of the member"),
  }),
  async execute({ member_handle }, ctx) {
    try {
      const context = requireAgentContext(ctx);
      const tasks = await taskService.getByMember(
        member_handle,
        context.projectId,
      );
      if (!tasks.length)
        return `@${member_handle.replace(/^@/, "")} has no active tasks.`;
      const lines = tasks
        .map(
          (t) =>
            `  ${statusEmoji(t.status)} ${priorityEmoji(t.priority)} #${shortId(t.id)} ${t.title}`,
        )
        .join("\n");
      return `Tasks for @${member_handle.replace(/^@/, "")}:\n${lines}`;
    } catch (err) {
      return `❌ Failed to get member tasks: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  },
});

// ─────────────────────────────────────────────────────────
// 7. GET PROJECT SUMMARY
// ─────────────────────────────────────────────────────────

export const getProjectSummaryTool = tool({
  name: "get_project_summary",
  description:
    "Get a high-level project overview: task counts by status and list of overdue items.",
  parameters: z.object({}),
  async execute(_, ctx) {
    try {
      const context = requireAgentContext(ctx);
      const summary = await projectService.getSummary(context.projectId);
      const overdueLines = summary.overdue
        .map(
          (t) =>
            `  🔴 #${shortId(t.id)} "${t.title}" — @${t.assignee?.telegramHandle ?? "unassigned"} (due ${dayjs(t.dueDate).fromNow()})`,
        )
        .join("\n");
      return [
        `📊 *Project Summary*`,
        `✅ Done:        ${summary.done}`,
        `🔄 In Progress: ${summary.inProgress}`,
        `👀 In Review:   ${summary.inReview}`,
        `🚫 Blocked:     ${summary.blocked}`,
        `⬜ Todo:        ${summary.todo}`,
        `👥 Members:     ${summary.totalMembers}`,
        summary.overdue.length
          ? `\n⚠️ Overdue (${summary.overdue.length}):\n${overdueLines}`
          : "\n✅ No overdue tasks",
      ].join("\n");
    } catch (err) {
      return `❌ Failed to get project summary: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  },
});

// ─────────────────────────────────────────────────────────
// 8. RECORD STATUS UPDATE
// ─────────────────────────────────────────────────────────

export const recordStatusUpdateTool = tool({
  name: "record_status_update",
  description:
    "Save what a team member said about a task. Call this whenever someone reports progress, even casually.",
  parameters: z.object({
    task_id: z.string().describe("Task ID - full UUID or first 6 characters"),
    update_content: z
      .string()
      .describe("Exactly what the member said or reported about this task"),
  }),
  async execute({ task_id, update_content }, ctx) {
    try {
      const context = requireAgentContext(ctx);
      await taskService.recordUpdate(task_id, context.userId, update_content);
      return `📝 Update recorded for task #${task_id.slice(0, 6)}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return `❌ Failed to record update: ${msg}`;
    }
  },
});

// ─────────────────────────────────────────────────────────
// 9. GET TASK HISTORY
// ─────────────────────────────────────────────────────────

export const getTaskHistoryTool = tool({
  name: "get_task_history",
  description:
    "Get the full update history for a task. Always call this before deciding to follow up, or maybe the task was just updated.",
  parameters: z.object({
    task_id: z.string().describe("Task ID - full UUID or first 6 characters"),
    limit: z
      .number()
      .min(1)
      .max(10)
      .nullable()
      .describe("How many recent updates to return (1-10). Use null to default to 5."),
  }),
  async execute({ task_id, limit }) {
    try {
      const history = await taskService.getHistory(task_id, limit ?? 5);
      if (!history.length)
        return `No updates recorded for task #${task_id.slice(0, 6)} yet.`;
      return history
        .map(
          (u) =>
            `• ${dayjs(u.createdAt).format("DD MMM, HH:mm")} - @${u.member.telegramHandle}: "${u.content}"`,
        )
        .join("\n");
    } catch (err) {
      return `❌ Failed to get task history: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  },
});

// ─────────────────────────────────────────────────────────
// 10. SEND DM
// ─────────────────────────────────────────────────────────

export const sendDmTool = tool({
  name: "send_dm",
  description:
    "Queue a direct Telegram message to a team member. The bot handler sends it after the agent finishes. Use for follow-ups, blockers, and sensitive messages that are not for general replies.",
  parameters: z.object({
    member_handle: z
      .string()
      .describe("Telegram @handle of the recipient (without @)"),
    message: z.string().describe("The message content to send"),
  }),
  async execute({ member_handle, message }, ctx) {
    try {
      const context = requireAgentContext(ctx);
      // Queue the DM — bot handler sends it after the agent run completes
      context.pendingDMs.push({
        handle: member_handle.replace(/^@/, ""),
        message,
      });
      return `DM queued for @${member_handle.replace(/^@/, "")}`;
    } catch (err) {
      return `❌ Failed to queue DM: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  },
});

// ─────────────────────────────────────────────────────────
// EXPORT ALL TOOLS
// Used in agent.ts to register with the Agent instance
// ─────────────────────────────────────────────────────────

export const allTools = [
  createTaskTool,
  updateTaskStatusTool,
  assignTaskTool,
  listTasksTool,
  getTaskDetailsTool,
  getMemberTasksTool,
  getProjectSummaryTool,
  recordStatusUpdateTool,
  getTaskHistoryTool,
  sendDmTool,
];
