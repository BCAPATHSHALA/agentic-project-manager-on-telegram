// src/services/memory.service.ts
// Handles conversation memory for the AI agent.
// Stores past messages per chat so the agent remembers context across turns.
// Without this, every message would be treated as a fresh conversation.

import { prisma } from "../db/prisma";
import logger from "../utils/logger";

// Roles the SDK uses - we only store user and assistant messages
type MessageRole = "user" | "assistant";

/**
 * The format @openai/agents expects for previousMessages.
 * Fed directly into run(pmAgent, message, { previousMessages }).
 */
interface StoredMessage {
  role: MessageRole;
  content: string;
}

/**
 * The raw message shape returned by result.newMessages from the SDK.
 * Content can be a plain string or an array of content blocks.
 */
interface SDKMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

/**
 * Normalize SDK content to a plain string.
 * The SDK sometimes returns content as an array of blocks
 * e.g. [{ type: 'text', text: 'hello' }] instead of just 'hello'.
 */
function extractContent(content: SDKMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n");
}

/**
 * Guard to only store user and assistant messages.
 * The SDK also returns 'tool' and 'tool_result' roles
 * which are internal to the agent loop and not needed for memory.
 */
function isStorableRole(role: string): role is MessageRole {
  return role === "user" || role === "assistant";
}

export const memoryService = {
  /**
   * Load the last N messages for a chat in chronological order.
   * Called before every agent run to give the LLM conversation context.
   * Returns empty array on failure — agent still runs, just without memory.
   */
  async load(chatId: string, limit = 15): Promise<StoredMessage[]> {
    try {
      const rows = await prisma.conversationMemory.findMany({
        where: { chatId },
        orderBy: { createdAt: "desc" }, // newest first from DB
        take: limit,
      });

      // Reverse to chronological order - SDK expects oldest message first
      return rows.reverse().map((row) => ({
        role: row.role as MessageRole,
        content: row.content,
      }));
    } catch (err) {
      logger.error({ err, chatId }, "Failed to load conversation memory");
      return []; // safe fallback - agent still works, just stateless this turn
    }
  },

  /**
   * Save new messages from the agent result back to the DB.
   * Called after every agent run with result.newMessages.
   * Skips tool and tool_result roles - only stores user/assistant.
   * Non-fatal on failure - agent already replied, losing one save is acceptable.
   */
  async save(chatId: string, messages: SDKMessage[]): Promise<void> {
    try {
      // Filter to only storeable roles and normalize content to string
      const storable = messages
        .filter((m) => isStorableRole(m.role))
        .map((m) => ({
          chatId,
          role: m.role,
          content: extractContent(m.content),
        }))
        .filter((m) => m.content.trim().length > 0); // skip empty messages

      if (!storable.length) return;

      await prisma.conversationMemory.createMany({ data: storable });
      logger.debug(
        { chatId, count: storable.length },
        "Messages saved to memory",
      );

      // Trim old messages to keep the DB lean
      await this.trim(chatId, 50);
    } catch (err) {
      logger.error({ err, chatId }, "Failed to save conversation memory");
      // Non-fatal -do not throw, agent already replied successfully
    }
  },

  /**
   * Keep only the latest N messages per chat.
   * Prevents the memory table from growing unbounded over time.
   * Called automatically after every save().
   */
  async trim(chatId: string, keepLatest = 50): Promise<void> {
    try {
      // Load all message IDs sorted oldest first
      const all = await prisma.conversationMemory.findMany({
        where: { chatId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });

      // Nothing to trim if within the limit
      if (all.length <= keepLatest) return;

      // Delete the oldest rows beyond the limit
      const toDelete = all.slice(0, all.length - keepLatest).map((r) => r.id);

      await prisma.conversationMemory.deleteMany({
        where: { id: { in: toDelete } },
      });

      logger.debug({ chatId, deleted: toDelete.length }, "Memory trimmed");
    } catch (err) {
      logger.error({ err, chatId }, "Failed to trim memory");
      // Non-fatal, trim failure just means slightly more rows in DB
    }
  },

  /**
   * Delete all memory for a chat.
   * Useful for /reset command or when a project is re-initialized.
   * Also helpful during testing to start fresh.
   */
  async clear(chatId: string): Promise<void> {
    try {
      const { count } = await prisma.conversationMemory.deleteMany({
        where: { chatId },
      });
      logger.info({ chatId, count }, "Memory cleared");
    } catch (err) {
      logger.error({ err, chatId }, "Failed to clear memory");
      throw new Error("Could not clear conversation memory.");
    }
  },

  /**
   * Count stored messages for a chat.
   * Useful for debugging or admin commands.
   */
  async count(chatId: string): Promise<number> {
    try {
      return await prisma.conversationMemory.count({ where: { chatId } });
    } catch (err) {
      logger.error({ err, chatId }, "Failed to count memory");
      return 0;
    }
  },
};
