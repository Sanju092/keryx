# Keryx — Mobile Application (Capacitor Android & iOS)

A native-ready Capacitor mobile wrapper around **Keryx** (custom multi-provider BYOK agents with exact Model IDs, background task & cron runner, Hermes-style Tools/Skills/MCP/Connectors, LLM Wiki, Obsidian mobile vault integration, configurable UI themes, and 5-layer Agent Harness).

## Option 1: Build an Android APK via GitHub Actions (No Android Studio needed)
1. Unzip this project and push it to a GitHub repository (`main` branch).
2. Open the **Actions** tab → **Build Keryx Android APK** → download the `keryx-android-debug-apk` artifact and install it on your Android phone.

## Option 2: Build Locally (Android / iOS)
```bash
npm install
npx cap add android   # or: npx cap add ios
npx cap sync
npx cap open android  # opens Android Studio to build/run on device
```

## Option 3: Test Immediately in Browser
```bash
npx serve www -l 5173
```

## Key Mobile Features Included
- **Full-bleed mobile shell** with `viewport-fit=cover` and iOS/Android safe-area insets.
- **Obsidian Mobile Vault**: Import `.md` notes or a vault folder from phone storage and push notes directly into the Obsidian app via `obsidian://` deep links.
- **Exact Model IDs & Multi-Provider BYOK**: Configure Gemini, OpenAI, Anthropic, OpenRouter, or custom HTTPS OpenAI-compatible endpoints.
- **Agent Harness (`AGENTS.md`)**: Balanced Approval Gate ON by default (toggleable globally or per agent), ratchet rules, and 3-scenario verification suite.
