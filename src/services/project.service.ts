// src/services/project.service.ts
// Handles all database operations related to Projects.
// One Telegram group = one Project. This is the root entity everything hangs off.

import { prisma } from "../db/prisma";
import logger from "../utils/logger";

export const projectService = {
  /**
   * Create a new project record when a group runs /setup.
   * Throws on failure so the bot must tell the user if this fails.
   */
  async create(data: { name: string; groupChatId: string }) {
    try {
      const project = await prisma.project.create({ data });
      logger.info(
        { projectId: project.id, name: project.name },
        "Project created",
      );
      return project;
    } catch (err) {
      logger.error({ err, data }, "Failed to create project");
      throw new Error("Could not create project. Please try again.");
    }
  },

  /**
   * Look up a project by its Telegram group chat ID.
   * Used in every group message handler to identify which project the group belongs to.
   * Returns null if not found - caller should prompt the group to run /setup.
   */
  async findByGroupChatId(groupChatId: string) {
    try {
      return await prisma.project.findUnique({ where: { groupChatId } });
    } catch (err) {
      logger.error(
        { err, groupChatId },
        "Failed to find project by groupChatId",
      );
      return null; // safe fallback - handler will ask user to run /setup
    }
  },

  /**
   * Find a project via a member's Telegram user ID.
   * Used in DM context where there is no group chat ID available.
   * A member can only belong to one project (for now).
   * Returns null if the user hasn't joined any project yet.
   */
  async findByMember(telegramUserId: bigint) {
    try {
      const member = await prisma.member.findUnique({
        where: { telegramUserId },
        include: { project: true }, // join to get the project details
      });
      return member?.project ?? null;
    } catch (err) {
      logger.error(
        { err, telegramUserId: telegramUserId.toString() },
        "Failed to find project by member",
      );
      return null; // safe fallback - bot will prompt user to /join first
    }
  },

  /**
   * Get high-level project stats: task counts by status + overdue list.
   * Used by the agent's get_project_summary tool and the daily summary scheduler.
   * Throws on failure so the summary is a core feature, caller must handle the error.
   */
  async getSummary(projectId: string) {
    try {
      // Load tasks and members in parallel for performance
      const [tasks, members] = await Promise.all([
        prisma.task.findMany({
          where: { projectId },
          include: { assignee: true }, // need assignee handle for overdue list
        }),
        prisma.member.findMany({ where: { projectId } }),
      ]);

      const now = new Date();

      return {
        totalMembers: members.length,
        todo: tasks.filter((t) => t.status === "TODO").length,
        inProgress: tasks.filter((t) => t.status === "IN_PROGRESS").length,
        blocked: tasks.filter((t) => t.status === "BLOCKED").length,
        inReview: tasks.filter((t) => t.status === "IN_REVIEW").length,
        done: tasks.filter((t) => t.status === "DONE").length,
        // Overdue = has a due date, due date is in the past, and not yet done
        overdue: tasks.filter(
          (t) => t.dueDate && t.dueDate < now && t.status !== "DONE",
        ),
      };
    } catch (err) {
      logger.error({ err, projectId }, "Failed to get project summary");
      throw new Error("Could not load project summary.");
    }
  },

  /**
   * Return all projects in the database.
   * Used by the scheduler to iterate over every project and run
   * daily summaries + follow-ups for each group.
   * Returns empty array on failure so scheduler skips silently.
   */
  async findAll() {
    try {
      return await prisma.project.findMany();
    } catch (err) {
      logger.error({ err }, "Failed to fetch all projects");
      return []; // safe fallback — scheduler continues without crashing
    }
  },
};
