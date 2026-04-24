# 🤖 Agentic Project Manager on Telegram

> An autonomous AI-powered project management bot that lives inside your Telegram group, manages tasks via natural language, chases teammates for updates, and posts daily standups without being asked.

---

## What Is The Actual Problem?

Most teams use Telegram to communicate but switch to Jira/Notion/Trello for task tracking, creating a painful context switch. Updates get lost in chat, tasks go stale, no one follows up.

**Agentic PM solves this by bringing the project manager INTO Telegram:**

1. **Lives in the group**: reads messages, replies, and posts updates directly in Telegram
2. **Manages tasks**: create, assign, update, and close tasks via plain English
3. **Actively chases people**: DMs: _"Hey @john, task X hasn't been updated in 2 days. What's the status?"_
4. **Posts daily standups**: _"3 done ✅, 2 in progress 🔄, 1 blocked 🚫"_

> ⚡ **"AGENTIC"** = the bot thinks and acts on its own. It decides _WHEN to ask_, _WHO to ask_, _WHAT to say_. That's what separates an AI agent from a simple command bot.

---

## 🎬 Try It Yourself

[![YouTube](https://img.shields.io/badge/YouTube-Demo-FF0000?style=for-the-badge&logo=youtube)](https://youtu.be/5pu6o4oJprI)
[![Notion](https://img.shields.io/badge/Notion-Walkthrough-000000?style=for-the-badge&logo=notion)](https://www.notion.so/10xtechinfinity/Demo-for-Agentic-PM-34ca49df5d688025b0adeb2f22fb78b1#34ca49df5d688065be8acd2b0a72c3ef)

---

## How It Works (HIGH LEVEL)

<img src="images/1. HOW IT WORKS (HIGH LEVEL).png" alt="How It Works" width="900" />

---

## 🏗️ System Design

### Architecture

<img src="images/2. Architecture.png" alt="Architecture" width="900" />

### Request Flow (How One Message Works)

<img src="images/3. Request Flow (How One Message Works).png" alt="Request Flow" width="900" />

### Proactive Behavior (The Agentic Part)

<img src="images/4. Proactive Behavior (The Agentic Part).png" alt="Proactive Behavior" width="900" />

#### Stale Task Detection & Follow-Up Logic

Every 4 hours, the scheduler scans for **stale tasks** and proactively contacts assignees via DM, no manual trigger needed.

**A task is considered stale when:**
- Status is `IN_PROGRESS` or `BLOCKED`
- Has an assignee
- `lastCheckedAt` is `null` OR older than 4 hours

**Two-tier response based on how long the task has been silent:**

| Silence Duration | Bot Action |
| ---------------- | ---------- |
| > **4 hours** | Private DM to assignee, friendly check-in, nothing posted to group |
| > **24 hours** | Private DM to assignee (firm) **+** non-blaming group escalation message |

**Flow inside the scheduler:**

<img src="images/11. Flow inside the scheduler.png" alt="Flow inside the scheduler" width="900" />

**DM blocked by Telegram (403 error)?**
The bot can only initiate a DM if the user has previously opened a private chat. Fix: open `@AgenticPM_bot` in private and send `/start` once (group `/start` does not count).

---

## 🗄️ Database Schema

<img src="images/5. Database Schema.png" alt="Database Schema" width="900" />

---

## 📁 Folder Structure

<img src="images/6. Folder Structure.png" alt="Folder Structure" width="900" />

---

## 🛠️ Agent Tools List

<img src="images/7. Agent Tools List.png" alt="Agent Tools List" width="900" />

---

## 🧠 Complete System Prompt (Brain of the Agent)

<img src="images/8. System Prompt - What's inside this file.png" alt="System Prompt" width="900" />

---

## 🧰 Our Final Stack

<img src="images/9. Our Stack.png" alt="Our Stack" width="900" />

---

## ⚙️ Setup & Run

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Docker](https://docker.com) (for PostgreSQL)
- A Telegram Bot Token from [@BotFather](https://t.me/BotFather)
- An OpenAI API Key

### 1. Clone & Install

```bash
git clone https://github.com/BCAPATHSHALA/agentic-project-manager-on-telegram.git
cd agentic-project-manager-on-telegram
bun install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Fill in your `.env`:

```env
# ── Telegram ──
# Get this from @BotFather on Telegram
BOT_TOKEN="7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# ── OpenAI ──
# Get from platform.openai.com
OPENAI_API_KEY="sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# ── Database ──
# Local:      postgresql://postgres:password@localhost:5432/agenticpm
# Railway/Neon:    paste the DATABASE_URL from your Railway/Neon PostgreSQL service
DATABASE_URL="postgresql://postgres:password@localhost:5432/agenticpm"

# ── App ──
NODE_ENV="development"
LOG_LEVEL="info"
```

### 3. Start the Database

```bash
bun run db:up
```

### 4. Run Migrations

```bash
bun run db:migrate
bun run db:generate
```

### 5. Start the Bot

```bash
# Development (auto-reload)
bun run dev

# Production
bun run start
```

---

## 💬 Bot Commands

| Command    | Description                        | Where      |
| ---------- | ---------------------------------- | ---------- |
| `/setup`   | Initialize project for this group  | Group only |
| `/join`    | Register yourself as a team member | Group only |
| `/status`  | Get project status overview        | Group + DM |
| `/tasks`   | List all tasks                     | Group + DM |
| `/mytasks` | Show your assigned tasks           | Group + DM |
| `/help`    | Show all available commands        | Anywhere   |

### Natural Language Examples

```
@AgenticPM_bot add a task: build login page, assign to @john, high priority, due May 1
@AgenticPM_bot the auth task is now in progress
@AgenticPM_bot mark the login page as done
@AgenticPM_bot what's blocked right now?
@AgenticPM_bot who is working on the database?
```

---

## 🤖 Proactive Behavior

| Trigger                   | Action                              |
| ------------------------- | ----------------------------------- |
| Task idle for **4h**      | Sends a friendly DM to the assignee |
| Task idle for **24h**     | DM + gentle group escalation        |
| Every day at **9:00 AM**  | Posts daily standup summary         |
| Every day at **10:00 AM** | Flags overdue tasks in the group    |

---

## 🧪 How the Agentic Loop Works

<img src="images/10. How the Agentic Loop Works.png" alt="Our Stack" width="900" />

---

## 📜 Scripts

```bash
bun run dev           # Start with auto-reload
bun run start         # Start production
bun run build         # Bundle to dist/
bun run typecheck     # Type check only
bun run db:up         # Start PostgreSQL via Docker
bun run db:down       # Stop PostgreSQL
bun run db:migrate    # Run DB migrations
bun run db:generate   # Regenerate Prisma client
bun run db:studio     # Open Prisma Studio
```

---

## 🏛️ Tech Stack

| Layer      | Technology                           |
| ---------- | ------------------------------------ |
| Runtime    | Bun                                  |
| Language   | TypeScript                           |
| Telegram   | Grammy                               |
| AI Agent   | OpenAI Agents SDK (`@openai/agents`) |
| LLM        | gpt-4o-mini                          |
| Database   | PostgreSQL (via Docker)              |
| ORM        | Prisma                               |
| Scheduler  | node-cron                            |
| Logging    | pino + pino-pretty                   |
| Validation | Zod                                  |

---

## Follow-Up Testing (Manual)

Use this to test follow-up scheduler behavior immediately without waiting 4 hours.

### Run DM follow-up test now

Linux/macOS:

```bash
FOLLOWUP_TEST_STALE_HOURS=0 FOLLOWUP_TEST_ESCALATE_HOURS=24 bun run test:followup
```

Windows PowerShell:

```powershell
$env:FOLLOWUP_TEST_STALE_HOURS="0"
$env:FOLLOWUP_TEST_ESCALATE_HOURS="24"
bun run test:followup
```

### Run escalation test now (DM + group escalation)

Linux/macOS:

```bash
FOLLOWUP_TEST_STALE_HOURS=0 FOLLOWUP_TEST_ESCALATE_HOURS=0 bun run test:followup
```

Windows PowerShell:

```powershell
$env:FOLLOWUP_TEST_STALE_HOURS="0"
$env:FOLLOWUP_TEST_ESCALATE_HOURS="0"
bun run test:followup
```

### Telegram DM requirement

If you see this error:

`403 Forbidden: bot can't initiate conversation with a user`

Do this once:
1. Open a private chat with `@AgenticPM_bot`.
2. Send `/start` there (group `/start` does not count).
3. Re-run `bun run test:followup`.

---

<div align="center">

### Built with ❤️ by [Manoj Kumar](https://github.com/BCAPATHSHALA)

> _"The best project manager is one that never sleeps, never forgets, and always follows up."_

**If this project helped you, give it a ⭐ on GitHub!**

[![GitHub](https://img.shields.io/badge/GitHub-BCAPATHSHALA-181717?style=for-the-badge&logo=github)](https://github.com/BCAPATHSHALA)
[![Telegram Bot](https://img.shields.io/badge/Telegram-@AgenticPM__bot-26A5E4?style=for-the-badge&logo=telegram)](https://t.me/AgenticPM_bot)
[![YouTube](https://img.shields.io/badge/YouTube-Demo-FF0000?style=for-the-badge&logo=youtube)](https://youtu.be/5pu6o4oJprI)
[![Notion](https://img.shields.io/badge/Notion-Walkthrough-000000?style=for-the-badge&logo=notion)](https://www.notion.so/10xtechinfinity/Demo-for-Agentic-PM-34ca49df5d688025b0adeb2f22fb78b1#34ca49df5d688065be8acd2b0a72c3ef)

</div>