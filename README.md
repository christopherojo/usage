# ChatGPT Usage Meter

A Chrome extension (Manifest V3) that shows, right from the toolbar:

- **5-hour and weekly limits**: % used, % left, reset countdown and a history sparkline
  (from the same endpoint ChatGPT's Codex usage page reads).
- **Per-query cost**: estimated tokens for your prompt, the conversation context re-sent with it,
  the reply, the reasoning summary and tool calls, plus how much each query moved your limit %.
- **Activity**: messages and estimated tokens over the last 5h / 7d, and per-model counts.

No extra login, API key or server. It runs inside your signed-in chatgpt.com tab and stores
everything in `chrome.storage.local` on your machine. Message text is tokenized and then discarded;
only counts and a 140-character preview are stored.

## Install

```bash
npm install
npm run build        # bundles the o200k_base tokenizer into extension/vendor/
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Open (or reload) a chatgpt.com tab, then click the toolbar icon.

The badge shows your 5-hour usage % (green / orange ≥70 / red ≥90).

## How it works

| File | Role |
|---|---|
| `extension/inject.js` | Runs in the page's own JS world. Wraps `fetch` to *observe* ChatGPT's requests: sending a message (`POST /backend-api/conversation`), starting a Codex task (`POST /backend-api/wham/tasks`), and usage reads (`GET /backend-api/wham/usage`). |
| `extension/content.js` | Snapshots usage before and after each query, fetches the finished conversation to split prompt / context / reply / reasoning / tool text, and polls usage every 5 minutes while the tab is visible. |
| `extension/background.js` | Counts tokens (o200k_base, the GPT-4o/GPT-5 tokenizer), stores history, sets the badge. |
| `extension/popup/` | The dashboard, with CSV / JSON export. |

## Accuracy caveats

- **Limits are exact** when `/backend-api/wham/usage` returns data. That endpoint is internal and
  undocumented, so if OpenAI changes it the Limits section will show an error. The parser is
  deliberately loose: any object with `used_percent` is picked up.
- **These limits meter Codex.** Plain ChatGPT chats may not move the 5h/weekly %, so per-query
  deltas will usually be 0 for chats and non-zero for Codex work.
- **Token counts are estimates.** They count visible text with the real tokenizer, but the model also
  sees a hidden system prompt, tool schemas, memory and file contents, and hidden reasoning tokens
  (only the reasoning *summary* is visible). Treat `think` as a lower bound.
- "ctx" assumes the full visible history is re-sent each turn. Long chats may be truncated server-side.
