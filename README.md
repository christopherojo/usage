# ChatGPT Usage Meter

A Chrome extension that shows your ChatGPT / Codex **5-hour and weekly limits**, forecasts when you'll
run out, and estimates the **token cost of every query and conversation**. It runs inside your signed-in
chatgpt.com tab, so there's no extra login, API key or server.

**Version 1.0.0** · Manifest V3 · Chrome / Chromium-based browsers

## Features

**Limits**
- 5-hour and weekly usage with reset countdowns and a history graph for the current window.
- **Used / Left** toggle, remembered across sessions.
- Colour levels by % left: green, yellow, orange, red. You can change the thresholds.
- A low-limit banner when any limit is running out.

**Burn-rate forecast**
- "⚠ At this pace you run out ~3:40 PM (in 1h 12m)", or "✓ On pace for ~41% used at reset".
- An even-pace marker on each bar, and a dashed projection to reset on the graph.
- Uses your recent pace, blended with the window's average when history is still short, so one busy
  session isn't projected across nights and weekends.

**Cost tracking**
- Per query: estimated tokens for your prompt, the earlier conversation re-sent as context, the reply,
  reasoning and tool calls, plus how much the query moved each limit.
- Per conversation: the costliest chats, and a flag on long chats where every message re-sends a lot of history.
- Per model: average cost, thinking time and limit used per message.

**Where you see it**
- **Toolbar icon:** a live ring gauge with a number badge. It fills up in Used mode and drains in Left mode.
- **Popup:** limits, forecast, activity, costliest chats, recent queries, a status panel, and CSV / JSON export.
- **Dashboard:** daily or weekly charts of tokens, messages or limit used; a sortable conversation table;
  a model comparison.
- **On-page pill** on chatgpt.com. Click it to expand, drag it anywhere. It can show the 5-hour limit,
  the weekly limit, both, or whichever is closest to running out.

**Settings**
- Default view, and the colour thresholds.
- Which limit the toolbar icon tracks.
- How often to check limits (1–15 minutes).
- Pill on/off, position, and what it shows.

## Install

The tokenizer bundle is committed, so no build step is needed.

1. Clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.
4. Open (or reload) a chatgpt.com tab while signed in, then click the toolbar icon.

Pin the extension from the puzzle-piece menu to keep the gauge visible.

### Updating

After pulling changes, click **reload** on the extension in `chrome://extensions`. Chrome reads the
popup and settings pages fresh from disk, but keeps running the old background script until you do.
If you forget, the popup shows an **"Update not fully loaded"** banner with a one-click **Reload
extension** button. That button re-attaches to open chatgpt.com tabs without reloading them.

## Privacy

- Everything stays in `chrome.storage.local` in your browser. Nothing is sent anywhere except the
  same chatgpt.com requests the page itself makes.
- Message text is tokenized and then discarded. Only token counts, the chat title and a 140-character
  preview of your prompt are stored.
- **Clear data** in the popup deletes all history but keeps your settings.

## Accuracy

- **Limits are exact** when ChatGPT's usage endpoint (`/backend-api/wham/usage`) returns data. That
  endpoint is internal and undocumented. If OpenAI changes it, the Limits section shows the error and
  the Status panel says why.
- **These limits meter Codex.** Plain ChatGPT chats may not move the 5-hour or weekly %, so per-query
  limit changes are usually 0 for chats and non-zero for Codex work.
- **Token counts are estimates.** They use the real o200k tokenizer on visible text, but the model also
  sees hidden system prompts, tool definitions, memory, file contents and hidden reasoning. Treat
  "think" as a lower bound.
- "ctx" assumes the full visible history is re-sent each turn. Very long chats may be truncated server-side.
- The forecast learns from snapshots taken while chatgpt.com is open. A shorter check interval in
  Settings gives it more data.

## Troubleshooting

Open the popup and expand **Status**. It shows:
- whether the extension is attached to your chatgpt.com tab
- whether it's seeing your messages
- the limits request's HTTP status and error
- which ChatGPT endpoints it has seen

**Copy diagnostics** copies a report without tokens or prompt text.

| Symptom | Fix |
|---|---|
| "Reload your chatgpt.com tab" | The tab was open before the extension was installed. Reload it. |
| Badge or icon doesn't match the popup | The background is out of date. Click **Reload extension** in the popup banner. |
| Limits show HTTP 401/403 | Sign in to chatgpt.com again, then press ↻. |
| Old errors on `chrome://extensions` | Chrome keeps errors until deleted. Click **Clear all**. |

## How it works

| File | Role |
|---|---|
| `extension/inject.js` | Runs in the page's JS world. Wraps `fetch` to *observe* (never modify) ChatGPT's requests: sending a message, starting a Codex task, and usage reads. |
| `extension/content.js` | Snapshots usage before and after each query, reads the finished conversation to split prompt / context / reply / reasoning / tool text, and checks usage on a timer while the tab is visible. |
| `extension/pill.js` | The on-page pill (Shadow DOM, reads from storage only). |
| `extension/background.js` | Counts tokens, stores history, draws the toolbar gauge and badge, and re-attaches to open tabs after a reload. |
| `extension/popup/` | Toolbar popup. |
| `extension/dashboard/` | Full-page charts and tables. |
| `extension/options/` | Settings page. |
| `extension/lib/shared.js` | Settings defaults, colour levels, formatting, conversation totals, build stamp. |
| `extension/lib/forecast.js` | Burn-rate maths. |
| `extension/vendor/tokenizer.js` | o200k_base tokenizer, bundled from `js-tiktoken` by `npm run build`. |

## Development

```bash
npm install
npm run build   # rebuild extension/vendor/tokenizer.js
npm test        # forecast unit tests
```

When releasing, bump the version in **both** `extension/manifest.json` and `BUILD` in
`extension/lib/shared.js`. The popup compares them to detect a stale background script.

## License

See [LICENSE](LICENSE).
