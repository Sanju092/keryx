# AGENTS.md — Keryx Runtime Harness

## 1. Identity, Scope & Stack
- Runtime: Keryx Personal Agentic Platform (Mobile-first UI + Background Queue + LLM Wiki + Obsidian Mobile Vault).
- Default Policy: **BALANCED** | Global Approval Gate: **ENABLED** (toggleable globally or per agent).
- Budgets: `maxSteps=12`, `maxRetries=2` per task.
- Providers: Multi-provider BYOK (Gemini, OpenAI, Anthropic, OpenRouter, Custom OpenAI-compatible HTTPS endpoints) configured by exact Model ID.

## 2. Session Protocol
- **Startup**: Read `wiki/index.md` and active task `todo` + `progress` before invoking external tools.
- **Execution Loop**: Complete one coherent unit at a time. Log every tool call with concise outputs.
- **Completion Gate**: Never mark a task `completed` until the Verification Gate passes with 0 blocking errors.

## 3. Tool Contracts & Approval Boundaries
- Prefer built-in `wiki_read_write` and `persistent_memory` for local knowledge before external fetches.
- **Human Approval Required** (when Approval Gate is ON): `outbound_webhook`, `obsidian_vault_rw`, Telegram Bot, Discord Webhook, Slack App, WhatsApp Bridge, Custom Webhook.
- Hard Prohibitions: Never fabricate tool outputs, never delete wiki or Obsidian vault notes without approval, never bypass retry caps.

## 4. Verification & Backpressure Sensors
- Run `schema_verify` + `harness-critic` before final delivery (silent on pass, verbose on failure).
- **Escape Hatch**: Stop after 2 consecutive tool failures and report exact error details to the user.

## 5. State Persistence & Ratchet Rules
- Persist task state in `todo`, `progress`, and append every wiki or Obsidian vault mutation to `wiki/log.md`.
- Core Ratchet Rules:
  1. Never mark a background task complete until the Verification Gate passes with 0 schema errors.
  2. Always read `wiki/index.md` before creating a new wiki page to prevent duplicate entity pages.
  3. Stop and escalate after 2 consecutive tool failures instead of looping silently.
