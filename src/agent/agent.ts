// src/agent/agent.ts
// Core agent definition and runner functions.
// The pmAgent is created ONCE at startup and reused for every message.
// runAgent() is called by bot handlers for user messages.
// runScheduledAgent() is called by the cron scheduler for proactive tasks.

import { Agent, assistant, run, user } from "@openai/agents";
import type { AgentInputItem } from "@openai/agents";
import { getSystemPrompt } from "./system-prompt";
import { allTools } from "./tools";
import { memoryService } from "../services/memory.service";
import logger from "../utils/logger";

// ─────────────────────────────────────────────────────────
// CONTEXT TYPE
// Passed into every tool's execute(args, ctx) as ctx.context.
// Gives tools access to the current user, project, and DM queue
// without needing to pass them as tool parameters.
// ─────────────────────────────────────────────────────────

export interface AgentContext {
  projectId: string; // which project this conversation belongs to
  userId: bigint; // Telegram user ID of the person sending the message
  chatId: string; // Telegram chat ID (group or DM)
  username: string; // @handle of the sender (for personalization)
  pendingDMs: Array<{
    // tools queue DMs here so handler sends them after agent finishes
    handle: string;
    message: string;
  }>;
}

// ─────────────────────────────────────────────────────────
// AGENT INSTANCE
// Created once at startup and never re-instantiated per message.
// The Agent holds the model, instructions, and tool definitions.
// ─────────────────────────────────────────────────────────

export const pmAgent = new Agent<AgentContext>({
  name: "PM Agent",
  model: "gpt-4o-mini", // Always set explicitly - default is gpt-4o (30x more expensive)
  instructions: getSystemPrompt(),
  tools: allTools,
});

// ─────────────────────────────────────────────────────────
// RETURN TYPE
// ─────────────────────────────────────────────────────────

export interface AgentResult {
  reply: string;
  pendingDMs: AgentContext["pendingDMs"];
}

// ─────────────────────────────────────────────────────────
// MAIN RUNNER - for user messages
// Called by bot handlers for every incoming message.
// Loads memory → runs agent loop → saves memory → returns reply + DMs.
// ─────────────────────────────────────────────────────────

export async function runAgent(
  userMessage: string,
  context: AgentContext,
): Promise<AgentResult> {
  logger.info(
    { chatId: context.chatId, username: context.username },
    "Agent invoked",
  );

  // 1. Load conversation history for this chat (last 15 messages)
  //    This gives the LLM context so it remembers what was said before
  const previousMessages = await memoryService.load(context.chatId, 15);
  const historyItems: AgentInputItem[] = previousMessages.map((message) =>
    message.role === "user"
      ? user(message.content)
      : assistant(message.content),
  );
  const input: string | AgentInputItem[] = historyItems.length
    ? [...historyItems, user(userMessage)]
    : userMessage;

  // 2. Run the agent
  //    The SDK handles the full agentic loop automatically:
  //    LLM decides → calls tool → execute() runs → result fed back to LLM → repeat → final reply
  try {
    const result = await run(pmAgent, input, {
      context,
    });

    const reply =
      result.finalOutput?.trim() ??
      "I'm not sure how to respond to that. Could you rephrase?";

    // 3. Save this turn to DB for the next run
    await memoryService.save(context.chatId, [
      { role: "user", content: userMessage },
      { role: "assistant", content: reply },
    ]);

    logger.info(
      { chatId: context.chatId, pendingDMs: context.pendingDMs.length },
      "Agent done",
    );

    return {
      reply,
      pendingDMs: context.pendingDMs,
    };
  } catch (err) {
    logger.error({ err, chatId: context.chatId }, "Agent run failed");
    return {
      reply:
        "⚠️ I ran into an issue processing your request. Please try again in a moment.",
      pendingDMs: [],
    };
  }
}

// ─────────────────────────────────────────────────────────
// SCHEDULER RUNNER for cron jobs
// Used by follow-up and daily summary schedulers.
// No user message → the scheduler builds the prompt.
// No memory → cron jobs are stateless, fresh context every run.
// ─────────────────────────────────────────────────────────

export async function runScheduledAgent(
  prompt: string,
  projectId: string,
  chatId: string,
): Promise<AgentResult> {
  // Sentinel context — no real user, triggered by the system
  const context: AgentContext = {
    projectId,
    userId: BigInt(0), // 0 = system/scheduler, tools check this if needed
    chatId,
    username: "system",
    pendingDMs: [],
  };

  logger.info({ projectId, chatId }, "Scheduled agent invoked");

  try {
    const result = await run(pmAgent, prompt, {
      context,
    });

    const reply = result.finalOutput?.trim() ?? "";

    logger.info(
      { projectId, pendingDMs: context.pendingDMs.length },
      "Scheduled agent done",
    );

    return {
      reply,
      pendingDMs: context.pendingDMs,
    };
  } catch (err) {
    logger.error({ err, projectId, chatId }, "Scheduled agent run failed");
    // Return empty reply so scheduler will skip sending a message for this project
    return { reply: "", pendingDMs: [] };
  }
}
