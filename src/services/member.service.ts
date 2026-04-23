// src/services/member.service.ts
// Handles all database operations related to team Members.
// A Member is a Telegram user who has joined a Project via /join command.
// Members are the humans the bot tracks tasks for and sends DMs to.

import { prisma } from "../db/prisma";
import logger from "../utils/logger";

// Shape of data needed to register a new member
interface UpsertMemberData {
  telegramUserId: bigint;
  telegramHandle: string | undefined;
  displayName: string;
  projectId: string;
}

export const memberService = {
  /**
   * Create or update a member record.
   * Called when a user runs /join in a group.
   * Uses upsert so running /join twice doesn't create duplicates.
   * it just updates the display name and handle if they changed.
   * Throws on failure so caller must tell the user if registration failed.
   */
  async upsert(data: UpsertMemberData) {
    try {
      const member = await prisma.member.upsert({
        where: { telegramUserId: data.telegramUserId },
        update: {
          // Update name/handle in case user changed their Telegram profile
          telegramHandle: data.telegramHandle,
          displayName: data.displayName,
        },
        create: {
          telegramUserId: data.telegramUserId,
          telegramHandle: data.telegramHandle,
          displayName: data.displayName,
          projectId: data.projectId,
        },
      });
      logger.info(
        { memberId: member.id, handle: member.telegramHandle },
        "Member upserted",
      );
      return member;
    } catch (err) {
      logger.error({ err, data }, "Failed to upsert member");
      throw new Error("Could not register member. Please try again.");
    }
  },

  /**
   * Find a member by their Telegram @handle within a specific project.
   * Used by tools when the AI says "assign to @john"
   * we look up @john in this project to get their DB record and telegramUserId.
   * Returns null if handle not found so caller should warn user to /join first.
   */
  async findByHandle(handle: string, projectId: string) {
    try {
      // Strip the @ prefix if the AI included it
      const cleanHandle = handle.replace(/^@/, "");

      return await prisma.member.findFirst({
        where: {
          projectId,
          telegramHandle: { equals: cleanHandle, mode: "insensitive" },
        },
      });
    } catch (err) {
      logger.error(
        { err, handle, projectId },
        "Failed to find member by handle",
      );
      return null;
    }
  },

  /**
   * Find a member by their Telegram user ID.
   * Used when we receive a message and need to match the sender
   * to a registered project member.
   * Returns null if user hasn't run /join yet.
   */
  async findByTelegramId(telegramUserId: bigint) {
    try {
      return await prisma.member.findUnique({
        where: { telegramUserId },
        include: { project: true },
      });
    } catch (err) {
      logger.error(
        { err, telegramUserId: telegramUserId.toString() },
        "Failed to find member by telegramId",
      );
      return null;
    }
  },

  /**
   * Get all members of a project.
   * Used when the agent needs to know the full team,
   * or when the scheduler is looking for people to follow up with.
   * Returns empty array on failure so scheduler skips silently, safe fallback.
   */
  async findAllByProject(projectId: string) {
    try {
      return await prisma.member.findMany({
        where: { projectId },
        orderBy: { displayName: "asc" },
      });
    } catch (err) {
      logger.error({ err, projectId }, "Failed to fetch members for project");
      return [];
    }
  },

  /**
   * Check if a Telegram user is already registered in a project.
   * Used before /join to give a helpful "already joined" message.
   */
  async isMember(telegramUserId: bigint, projectId: string): Promise<boolean> {
    try {
      const member = await prisma.member.findFirst({
        where: { telegramUserId, projectId },
      });
      return member !== null;
    } catch (err) {
      logger.error(
        { err, telegramUserId: telegramUserId.toString(), projectId },
        "Failed to check membership",
      );
      return false; // safe fallback - treat as not a member, prompt to /join
    }
  },
};
