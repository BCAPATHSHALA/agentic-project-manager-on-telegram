// src/bot/handlers.ts
// Registers all Telegram bot commands and message listeners.
// This is the entry point for all user interactions.
// Every command handler builds an AgentContext and calls runAgent().
// The handler then sends the reply and any pending DMs the agent queued.
//
// ==========================================================================
// REGISTERED COMMANDS (also set in @BotFather via /setcommands)
// ==========================================================================
//
//  /start    → Onboarding message (fires on first DM open, not listed in menu)
//  /setup    → Initialize a project for this Telegram group (group only)
//  /join     → Register yourself as a team member (group only)
//  /status   → Get a concise project status summary (group + DM)
//  /tasks    → List all tasks grouped by status (group + DM)
//  /mytasks  → Show tasks assigned to the caller (group + DM)
//  /help     → Show all available commands (group + DM)
//
// NATURAL LANGUAGE (no command needed):
//  Group: mention @AgenticPM_bot + your message
//  DM:    just type directly in DM - bot always responds
//
// ==========================================================================

import { Bot } from "grammy";
import { runAgent, type AgentContext } from "../agent/agent";
import { projectService } from "../services/project.service";
import { memberService } from "../services/member.service";
import logger from "../utils/logger";

// ─────────────────────────────────────────────────────────
// HELPER: Build AgentContext from incoming Telegram data
// All commands and message handlers use this to create context.
// ─────────────────────────────────────────────────────────

function buildContext(
  chatId: string,
  userId: bigint,
  username: string,
  projectId: string,
): AgentContext {
  return {
    projectId,
    userId,
    chatId,
    username,
    pendingDMs: [], // tools push DMs here so sendPendingDMs() sends them after agent finishes
  };
}

// ─────────────────────────────────────────────────────────
// HELPER: Send all DMs the agent queued during its run
// Called after every runAgent(). DMs are sent one by one.
// Non-fatal: if a DM fails (user hasn't started the bot), log and continue.
// ─────────────────────────────────────────────────────────

async function sendPendingDMs(
  bot: Bot,
  dms: AgentContext["pendingDMs"],
  projectId: string,
): Promise<void> {
  for (const dm of dms) {
    try {
      const member = await memberService.findByHandle(dm.handle, projectId);
      if (!member) {
        logger.warn({ handle: dm.handle }, "DM skipped - member not found");
        continue;
      }
      await bot.api.sendMessage(Number(member.telegramUserId), dm.message);
      logger.info({ handle: dm.handle }, "DM sent successfully");
    } catch (err) {
      // User may not have started the bot in DM — this is non-fatal
      logger.warn(
        { handle: dm.handle, err },
        "Failed to send DM - user may not have started the bot",
      );
    }
  }
}

// ─────────────────────────────────────────────────────────
// MAIN SETUP - called once at startup from index.ts
// ─────────────────────────────────────────────────────────

export function setupHandlers(bot: Bot): void {
  // ── /start ──────────────────────────────────────────────
  // Fires when someone opens the bot in DM for the first time.
  // Also fires when someone clicks a t.me/bot?start=xxx link.
  // Used for onboarding - explain what the bot does.
  bot.command("start", async (ctx) => {
    try {
      await ctx.reply(
        `👋 Hi ${ctx.from?.first_name ?? "there"}!\n\n` +
          `I'm *Agentic PM*, your AI project manager on Telegram.\n\n` +
          `*How to get started:*\n` +
          `1. Add me to your project group\n` +
          `2. Run /setup in the group\n` +
          `3. Each team member runs /join\n` +
          `4. Talk to me naturally and I'll manage the tasks!\n\n` +
          `Run /help to see all commands.`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      logger.error({ err, userId: ctx.from?.id }, "/start handler failed");
    }
  });

  // ── /setup ──────────────────────────────────────────────
  // Initializes a project for this Telegram group.
  // One group = one project. Must be run before anything else.
  // Should only be used in group chats, not in DMs.
  bot.command("setup", async (ctx) => {
    try {
      // Prevent setup from being run in DMs
      if (ctx.chat.type === "private") {
        await ctx.reply("⚠️ /setup must be run inside a group, not a DM.");
        return;
      }

      const chatId = String(ctx.chat.id);
      const existing = await projectService.findByGroupChatId(chatId);

      // If project already exists, don't create a duplicate
      if (existing) {
        await ctx.reply(
          `✅ This group already has a project: *${existing.name}*\n\n` +
            `Run /status to see the current state.`,
          { parse_mode: "Markdown" },
        );
        return;
      }

      // Create a new project using the Telegram group title
      const project = await projectService.create({
        name: ctx.chat.title ?? "My Project",
        groupChatId: chatId,
      });

      await ctx.reply(
        `🚀 *${project.name}* is ready!\n\n` +
          `Each team member should now run /join to register.\n` +
          `Then just talk to me naturally and I'll manage the tasks!`,
        { parse_mode: "Markdown" },
      );

      logger.info(
        { projectId: project.id, chatId },
        "Project initialized via /setup",
      );
    } catch (err) {
      logger.error({ err, chatId: ctx.chat.id }, "/setup handler failed");
      await ctx
        .reply("⚠️ Failed to set up the project. Please try again.")
        .catch(() => {});
    }
  });

  // ── /join ───────────────────────────────────────────────
  // Registers the sender as a team member of this group's project.
  // Uses upsert so it's safe to run multiple times (won't create duplicates).
  // Members must be registered to be assigned tasks and receive DMs.
  bot.command("join", async (ctx) => {
    try {
      if (ctx.chat.type === "private") {
        await ctx.reply("⚠️ Run /join inside your project group, not in a DM.");
        return;
      }

      const chatId = String(ctx.chat.id);
      const project = await projectService.findByGroupChatId(chatId);

      if (!project) {
        await ctx.reply(
          "⚠️ This group has no project yet. Ask an admin to run /setup first.",
        );
        return;
      }

      // Register or update this member in the DB
      const member = await memberService.upsert({
        telegramUserId: BigInt(ctx.from!.id),
        telegramHandle: ctx.from!.username,
        displayName: ctx.from!.first_name,
        projectId: project.id,
      });

      await ctx.reply(
        `👋 Welcome, *${member.displayName}*!\n` +
          `You're registered on *${project.name}*.\n\n` +
          `You can DM me anytime to report task updates privately.`,
        { parse_mode: "Markdown" },
      );

      logger.info(
        { memberId: member.id, handle: member.telegramHandle },
        "Member joined via /join",
      );
    } catch (err) {
      logger.error({ err, userId: ctx.from?.id }, "/join handler failed");
      await ctx
        .reply("⚠️ Failed to register you. Please try again.")
        .catch(() => {});
    }
  });

  // ── /status ─────────────────────────────────────────────
  // Asks the agent to generate a concise project overview.
  // Works in both groups and DMs.
  bot.command("status", async (ctx) => {
    try {
      const chatId = String(ctx.chat.id);
      const isDM = ctx.chat.type === "private";

      // In DMs, find project by the user's membership
      const project = isDM
        ? await projectService.findByMember(BigInt(ctx.from!.id))
        : await projectService.findByGroupChatId(chatId);

      if (!project) {
        await ctx.reply(
          isDM
            ? "You're not part of any project yet. Join a group and run /join."
            : "⚠️ No project found. Run /setup first.",
        );
        return;
      }

      const agentCtx = buildContext(
        chatId,
        BigInt(ctx.from!.id),
        ctx.from!.username ?? ctx.from!.first_name,
        project.id,
      );

      await ctx.api.sendChatAction(ctx.chat.id, "typing");
      const { reply, pendingDMs } = await runAgent(
        "Give me a concise project status summary with counts and any blockers.",
        agentCtx,
      );

      await ctx.reply(reply, { parse_mode: "Markdown" });
      await sendPendingDMs(bot, pendingDMs, project.id);
    } catch (err) {
      logger.error({ err }, "/status handler failed");
      await ctx
        .reply("⚠️ Could not fetch project status. Please try again.")
        .catch(() => {});
    }
  });

  // ── /tasks ──────────────────────────────────────────────
  // Lists all tasks in the project grouped by status.
  bot.command("tasks", async (ctx) => {
    try {
      const chatId = String(ctx.chat.id);
      const isDM = ctx.chat.type === "private";
      const project = isDM
        ? await projectService.findByMember(BigInt(ctx.from!.id))
        : await projectService.findByGroupChatId(chatId);

      if (!project) {
        await ctx.reply(
          isDM
            ? "You're not part of any project yet. Join a group and run /join."
            : "⚠️ No project found. Run /setup first.",
        );
        return;
      }

      const agentCtx = buildContext(
        chatId,
        BigInt(ctx.from!.id),
        ctx.from!.username ?? ctx.from!.first_name,
        project.id,
      );

      await ctx.api.sendChatAction(ctx.chat.id, "typing");
      const { reply } = await runAgent(
        "List all tasks grouped by status.",
        agentCtx,
      );
      await ctx.reply(reply, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err }, "/tasks handler failed");
      await ctx
        .reply("⚠️ Could not fetch tasks. Please try again.")
        .catch(() => {});
    }
  });

  // ── /mytasks ────────────────────────────────────────────
  // Shows tasks assigned to the person who ran the command.
  // Works in both groups and DMs.
  bot.command("mytasks", async (ctx) => {
    try {
      const chatId = String(ctx.chat.id);
      const isDM = ctx.chat.type === "private";
      const userId = BigInt(ctx.from!.id);
      const handle = ctx.from!.username ?? ctx.from!.first_name;

      // Find project via membership (works in both DM and group)
      const project = isDM
        ? await projectService.findByMember(userId)
        : await projectService.findByGroupChatId(chatId);

      if (!project) {
        await ctx.reply(
          "You're not part of any project yet. Join a group and run /join.",
        );
        return;
      }

      const agentCtx = buildContext(chatId, userId, handle, project.id);

      await ctx.api.sendChatAction(ctx.chat.id, "typing");
      const { reply } = await runAgent(
        `Show all tasks assigned to @${handle}`,
        agentCtx,
      );
      await ctx.reply(reply, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err, userId: ctx.from?.id }, "/mytasks handler failed");
      await ctx
        .reply("⚠️ Could not fetch your tasks. Please try again.")
        .catch(() => {});
    }
  });

  // ── /help ───────────────────────────────────────────────
  // Static list of available commands.
  // No agent needed — just a formatted text reply.
  bot.command("help", async (ctx) => {
    try {
      await ctx.reply(
        `*🤖 Agentic PM — Commands*\n\n` +
          `/setup    — Initialize project for this group\n` +
          `/join     — Register yourself as a team member\n` +
          `/status   — Project overview and blockers\n` +
          `/tasks    — List all tasks\n` +
          `/mytasks  — Your assigned tasks\n` +
          `/help     — Show this message\n\n` +
          `*💬 Or just talk to me naturally:*\n` +
          `"Add a task: build login page, assign @john, due Friday"\n` +
          `"Mark the API task as done"\n` +
          `"Who is working on the database migration?"\n` +
          `"@AgenticPM\\_bot what's blocked right now?"`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      logger.error({ err }, "/help handler failed");
    }
  });

  // ── Natural Language Messages ────────────────────────────
  // Handles all plain text messages (not commands).
  // In groups: only responds when the bot is @mentioned.
  // In DMs: always responds if the user is talking directly to the bot.
  bot.on("message:text", async (ctx) => {
    try {
      const chatId = String(ctx.chat.id);
      const userId = BigInt(ctx.from!.id);
      const handle = ctx.from!.username ?? ctx.from!.first_name;
      const text = ctx.message.text;
      const isDM = ctx.chat.type === "private";

      // In group chats we only respond when @mentioned
      // This prevents the bot from hijacking every group conversation
      if (!isDM) {
        const botInfo = await ctx.api.getMe();
        const isMentioned = text.includes(`@${botInfo.username}`);
        if (!isMentioned) return; // silently ignore messages not addressed to the bot
      }

      // Resolve project: DM → by member, Group → by chat ID
      const project = isDM
        ? await projectService.findByMember(userId)
        : await projectService.findByGroupChatId(chatId);

      if (!project) {
        await ctx.reply(
          isDM
            ? "You're not part of any project yet. Join a group and run /join first."
            : "This group has no project. Ask an admin to run /setup first.",
        );
        return;
      }

      const agentCtx = buildContext(chatId, userId, handle, project.id);

      // Show "typing..." indicator while the agent is thinking
      await ctx.api.sendChatAction(ctx.chat.id, "typing");

      const { reply, pendingDMs } = await runAgent(text, agentCtx);

      await ctx.reply(reply, { parse_mode: "Markdown" });

      // Send any DMs the agent queued during its run
      await sendPendingDMs(bot, pendingDMs, project.id);
    } catch (err) {
      logger.error({ err, chatId: ctx.chat.id }, "Message handler failed");
      await ctx
        .reply("⚠️ Something went wrong. Please try again in a moment.")
        .catch(() => {});
    }
  });

  // ── Global Error Handler ─────────────────────────────────
  // Catches any unhandled Grammy errors (network issues, Telegram API errors, etc.)
  // Logs the error but does NOT crash the bot so it keeps polling.
  bot.catch((err) => {
    logger.error(
      { err: err.error, update: err.ctx?.update },
      "Unhandled Grammy error",
    );
  });

  logger.info("✅ Bot handlers registered");
}
