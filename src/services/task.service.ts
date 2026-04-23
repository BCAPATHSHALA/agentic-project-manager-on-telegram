// src/services/task.service.ts
// Handles all database operations related to Tasks.
// This is the core service — tasks are the main entity the agent manages.
// Every tool that touches a task calls a method from this service.

import { prisma } from "../db/prisma";
import logger from "../utils/logger";
import type { TaskStatus, Priority } from "../../generated/prisma/enums";

// Shape of data needed to create a new task
interface CreateTaskData {
  title: string;
  description?: string;
  assignee_handle?: string;
  priority: Priority;
  due_date?: string; // ISO date string from the AI
  projectId: string;
}

// Shape of data needed to filter tasks
interface ListTasksFilter {
  status?: TaskStatus | "ALL";
  assignee_handle?: string;
  priority?: Priority;
}

export const taskService = {
  /**
   * Create a new task.
   * Called by the create_task tool when the agent decides to track new work.
   * Looks up the assignee by @handle if provided.
   * Throws on failure — the user must know if task creation failed.
   */
  async create(data: CreateTaskData) {
    try {
      // Resolve assignee handle to a member ID if provided
      let assigneeId: string | undefined;
      if (data.assignee_handle) {
        const cleanHandle = data.assignee_handle.replace(/^@/, "");
        const member = await prisma.member.findFirst({
          where: {
            projectId: data.projectId,
            telegramHandle: { equals: cleanHandle, mode: "insensitive" },
          },
        });
        if (member) {
          assigneeId = member.id;
        } else {
          // Don't block task creation if handle not found — just leave unassigned
          logger.warn(
            { handle: data.assignee_handle },
            "Assignee not found — task created unassigned",
          );
        }
      }

      const task = await prisma.task.create({
        data: {
          title: data.title,
          description: data.description,
          priority: data.priority,
          projectId: data.projectId,
          assigneeId: assigneeId ?? null,
          // Parse ISO date string safely
          dueDate: data.due_date ? new Date(data.due_date) : null,
        },
        include: { assignee: true },
      });

      logger.info({ taskId: task.id, title: task.title }, "Task created");
      return task;
    } catch (err) {
      logger.error({ err, data }, "Failed to create task");
      throw new Error("Could not create task. Please try again.");
    }
  },

  /**
   * Update the status of an existing task.
   * Called by update_task_status tool.
   * Also records a status update entry so we have full history.
   * Throws on failure — the user must know if the update failed.
   */
  async updateStatus(
    taskId: string,
    status: TaskStatus,
    description?: string,
    note?: string,
    userId?: bigint,
  ) {
    try {
      // Find task by full ID or first-6-char prefix
      const task = await this.resolveTask(taskId);
      if (!task) throw new Error(`Task #${taskId} not found.`);

      const updated = await prisma.task.update({
        where: { id: task.id },
        data: {
          status,
          updatedAt: new Date(),
          ...(typeof description === "string" ? { description } : {}),
        },
        include: { assignee: true },
      });

      // Record the status change as a status update entry if note or userId provided
      if (note && userId) {
        const member = await prisma.member.findUnique({
          where: { telegramUserId: userId },
        });
        if (member) {
          await prisma.statusUpdate.create({
            data: {
              content: note,
              taskId: task.id,
              memberId: member.id,
            },
          });
        }
      }

      logger.info({ taskId: task.id, status }, "Task status updated");
      return updated;
    } catch (err) {
      logger.error({ err, taskId, status }, "Failed to update task status");
      throw err instanceof Error
        ? err
        : new Error("Could not update task status.");
    }
  },

  /**
   * Assign or reassign a task to a team member.
   * Called by the assign_task tool.
   * Throws on failure.
   */
  async assign(taskId: string, handle: string, projectId: string) {
    try {
      const task = await this.resolveTask(taskId);
      if (!task) throw new Error(`Task #${taskId} not found.`);

      // Look up the new assignee by handle within this project
      const cleanHandle = handle.replace(/^@/, "");
      const member = await prisma.member.findFirst({
        where: {
          projectId,
          telegramHandle: { equals: cleanHandle, mode: "insensitive" },
        },
      });

      if (!member) {
        throw new Error(
          `@${cleanHandle} is not a registered member. Ask them to run /join first.`,
        );
      }

      const updated = await prisma.task.update({
        where: { id: task.id },
        data: { assigneeId: member.id },
        include: { assignee: true },
      });

      logger.info({ taskId: task.id, handle }, "Task assigned");
      return updated;
    } catch (err) {
      logger.error({ err, taskId, handle }, "Failed to assign task");
      throw err instanceof Error ? err : new Error("Could not assign task.");
    }
  },

  /**
   * List tasks with optional filters.
   * Called by the list_tasks tool.
   * Returns empty array on failure — safe fallback.
   */
  async list(projectId: string, filters: ListTasksFilter = {}) {
    try {
      const { status, assignee_handle, priority } = filters;

      // Resolve assignee handle to ID if provided
      let assigneeId: string | undefined;
      if (assignee_handle) {
        const cleanHandle = assignee_handle.replace(/^@/, "");
        const member = await prisma.member.findFirst({
          where: {
            projectId,
            telegramHandle: { equals: cleanHandle, mode: "insensitive" },
          },
        });
        assigneeId = member?.id;
      }

      return await prisma.task.findMany({
        where: {
          projectId,
          // Only filter by status if not 'ALL'
          ...(status && status !== "ALL" ? { status } : {}),
          ...(assigneeId ? { assigneeId } : {}),
          ...(priority ? { priority } : {}),
        },
        include: { assignee: true },
        orderBy: [
          { status: "asc" }, // group by status
          { priority: "desc" }, // urgent first within each status
          { createdAt: "asc" }, // oldest first within same priority
        ],
      });
    } catch (err) {
      logger.error({ err, projectId, filters }, "Failed to list tasks");
      return []; // safe fallback
    }
  },

  /**
   * Get full details of a single task including recent update history.
   * Called by the get_task_details tool.
   * Returns null if not found — caller should tell user task doesn't exist.
   */
  async getDetails(taskId: string) {
    try {
      const task = await this.resolveTask(taskId);
      if (!task) return null;

      return await prisma.task.findUnique({
        where: { id: task.id },
        include: {
          assignee: true,
          updates: {
            include: { member: true },
            orderBy: { createdAt: "desc" },
            take: 10, // last 10 updates are enough for context
          },
        },
      });
    } catch (err) {
      logger.error({ err, taskId }, "Failed to get task details");
      return null;
    }
  },

  /**
   * Get all tasks assigned to a specific member.
   * Called by the get_member_tasks tool.
   * Returns empty array on failure.
   */
  async getByMember(handle: string, projectId: string) {
    try {
      const cleanHandle = handle.replace(/^@/, "");
      const member = await prisma.member.findFirst({
        where: {
          projectId,
          telegramHandle: { equals: cleanHandle, mode: "insensitive" },
        },
      });

      if (!member) return [];

      return await prisma.task.findMany({
        where: {
          assigneeId: member.id,
          // Exclude done tasks from personal task list
          status: { not: "DONE" },
        },
        include: { assignee: true },
        orderBy: { priority: "desc" },
      });
    } catch (err) {
      logger.error({ err, handle, projectId }, "Failed to get tasks by member");
      return [];
    }
  },

  /**
   * Record a status update (what someone said about a task).
   * Called by the record_status_update tool.
   * Stores the raw text so we have a full audit trail.
   * Throws on failure.
   */
  async recordUpdate(taskId: string, userId: bigint, content: string) {
    try {
      const task = await this.resolveTask(taskId);
      if (!task) throw new Error(`Task #${taskId} not found.`);

      const member = await prisma.member.findUnique({
        where: { telegramUserId: userId },
      });
      if (!member)
        throw new Error("You must run /join before recording updates.");

      const update = await prisma.statusUpdate.create({
        data: { content, taskId: task.id, memberId: member.id },
      });

      // Also update the task's updatedAt so follow-up logic sees fresh activity
      await prisma.task.update({
        where: { id: task.id },
        data: { updatedAt: new Date() },
      });

      logger.info(
        { taskId: task.id, memberId: member.id },
        "Status update recorded",
      );
      return update;
    } catch (err) {
      logger.error(
        { err, taskId, userId: userId.toString() },
        "Failed to record status update",
      );
      throw err instanceof Error
        ? err
        : new Error("Could not record status update.");
    }
  },

  /**
   * Get the update history for a task.
   * Called by the get_task_history tool.
   * Used by the scheduler before deciding whether to follow up.
   * Returns empty array on failure.
   */
  async getHistory(taskId: string, limit = 5) {
    try {
      const task = await this.resolveTask(taskId);
      if (!task) return [];

      return await prisma.statusUpdate.findMany({
        where: { taskId: task.id },
        include: { member: true },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
    } catch (err) {
      logger.error({ err, taskId }, "Failed to get task history");
      return [];
    }
  },

  /**
   * Find stale tasks for the follow-up scheduler.
   * Stale = IN_PROGRESS or BLOCKED, not checked in X hours.
   * Used by scheduler/follow-up.ts every 4 hours.
   */
  async findStaleTasks(olderThanHours = 4) {
    try {
      const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);

      return await prisma.task.findMany({
        where: {
          status: { in: ["IN_PROGRESS", "BLOCKED"] },
          assignee: { isNot: null },
          OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: cutoff } }],
        },
        include: {
          assignee: true,
          project: true,
          updates: {
            orderBy: { createdAt: "desc" },
            take: 1, // only need the most recent update
          },
        },
        take: 20, // process max 20 per scheduler run to avoid flooding
      });
    } catch (err) {
      logger.error({ err }, "Failed to find stale tasks");
      return [];
    }
  },

  /**
   * Update lastCheckedAt on a task after the scheduler follows up.
   * Prevents the bot from pinging the same person again too soon.
   */
  async markChecked(taskId: string) {
    try {
      await prisma.task.update({
        where: { id: taskId },
        data: { lastCheckedAt: new Date() },
      });
    } catch (err) {
      logger.error({ err, taskId }, "Failed to mark task as checked");
      // Non-fatal — worst case the bot follows up again slightly too soon
    }
  },

  // ─────────────────────────────────────────────────────
  // PRIVATE HELPER
  // ─────────────────────────────────────────────────────

  /**
   * Resolve a task by full UUID or first-6-char prefix.
   * The AI always uses short IDs like "abc123" in messages.
   * We need to match that back to the full UUID in the DB.
   */
  async resolveTask(taskIdOrPrefix: string) {
    // If it looks like a full UUID, use it directly
    if (taskIdOrPrefix.length > 6) {
      return prisma.task.findUnique({ where: { id: taskIdOrPrefix } });
    }
    // Otherwise match by prefix
    return prisma.task.findFirst({
      where: { id: { startsWith: taskIdOrPrefix } },
    });
  },
};
