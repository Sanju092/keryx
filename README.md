# Keryx — Mobile Application (Capacitor 8 · Android & iOS)

A native-ready Capacitor 8 mobile wrapper around **Keryx** (custom multi-provider BYOK agents with exact Model IDs, background task & cron runner, Hermes-style Tools/Skills/MCP/Connectors, LLM Wiki, Obsidian mobile vault integration, configurable UI themes, and 5-layer Agent Harness).

## Option 1: Build an Android APK via GitHub Actions (No Android Studio needed)
1. Push to `main` or trigger **Build Keryx Android APK** manually in the **Actions** tab.
2. Download the `keryx-android-debug-apk` artifact and install it on your Android phone.

## Option 2: Build Locally (Android / iOS)
Requires Node.js 22+ and Java 21 (for Android builds).
```bash
npm install
npm run verify
npx cap add android   # or: npx cap add ios
npx cap sync
npx cap open android  # opens Android Studio to build/run on device
```

## Option 3: Test Immediately in Browser
```bash
npm run dev
```

## Key Mobile Features Included
- **Full-bleed mobile shell** with `100dvh`, `viewport-fit=cover`, safe-area insets, and native `<dialog>` sheets with light-dismiss.
- **Capacitor 8 Native Bridges**: StatusBar theme sync, Android hardware back-button handling (`@capacitor/app`), local task/approval alerts (`@capacitor/local-notifications`), and native Markdown export to `Documents/Keryx-Wiki/` (`@capacitor/filesystem`).
- **Obsidian Mobile Vault**: Import `.md` notes or a vault folder from phone storage and push notes directly into the Obsidian app via `obsidian://` deep links.
- **Exact Model IDs & Multi-Provider BYOK**: Configure Gemini, OpenAI, Anthropic, OpenRouter, or custom HTTPS OpenAI-compatible endpoints with multi-turn context.
- **Agent Harness (`AGENTS.md`)**: Balanced Approval Gate ON by default (toggleable globally or per agent), ratchet rules, and 3-scenario verification suite.
