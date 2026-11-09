// Background service worker: tokenizes, stores, and badges.
importScripts("lib/shared.js");
try {
  importScripts("vendor/tokenizer.js");
} catch (e) {
  console.warn("[usage-meter] tokenizer bundle missing, falling back to ~4 chars/token", e);
}

const MAX_QUERIES = 2000;
const MAX_HISTORY = 3000;

function countTokens(text) {
  if (!text) return 0;
  if (self.UsageTokenizer) return self.UsageTokenizer.count(text);
  return Math.ceil(text.length / 4);
}

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

// Serialize storage writes so concurrent messages don't clobber each other.
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

function sameWindows(a, b) {
  if (!a || !b || a.windows.length !== b.windows.length) return false;
  return a.windows.every((w, i) => w.key === b.windows[i].key && w.usedPercent === b.windows[i].usedPercent);
}

async function saveUsage(snapshot) {
  const { usageHistory = [] } = await get("usageHistory");
  // Keep a history point whenever a value changes, or at least every 30 minutes.
  const prev = usageHistory[usageHistory.length - 1];
  if (!prev || !sameWindows(prev, snapshot) || snapshot.ts - prev.ts > 30 * 60 * 1000) {
    usageHistory.push({
      ts: snapshot.ts,
      windows: snapshot.windows.map(({ key, usedPercent, resetAt }) => ({ key, usedPercent, resetAt })),
    });
    if (usageHistory.length > MAX_HISTORY) usageHistory.splice(0, usageHistory.length - MAX_HISTORY);
  }
  await set({ latestUsage: snapshot, usageHistory, usageError: null });
  updateBadge(snapshot);
}


async function updateBadge(snap) {
  const wins = (snap && snap.windows) || [];
  if (!wins.length) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  const prefs = await UsageShared.loadPrefs();
  const showLeft = prefs.view === "left";
  // Badge tracks whichever window is closest to running out.
  const tight = UsageShared.pickWindow(wins, "tightest");
  const left = Math.max(0, 100 - tight.usedPercent);
  chrome.action.setBadgeText({ text: `${Math.round(showLeft ? left : tight.usedPercent)}` });
  chrome.action.setBadgeBackgroundColor({ color: UsageShared.LEVEL_COLORS[UsageShared.levelFor(left, prefs.thresholds)] });
  chrome.action.setTitle({
    title:
      wins.map((w) => `${w.label}: ${w.usedPercent}% used · ${Math.round((100 - w.usedPercent) * 10) / 10}% left`).join("\n") +
      `\nBadge: ${tight.label} ${showLeft ? "left" : "used"}`,
  });
}

// Re-badge when the Used/Left toggle changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.prefs) get("latestUsage").then(({ latestUsage }) => latestUsage && updateBadge(latestUsage));
});

function delta(before, after) {
  if (!before || !after) return null;
  const d = {};
  for (const k of Object.keys(after)) {
    if (typeof before[k] === "number") d[k] = Math.round((after[k] - before[k]) * 10) / 10;
  }
  return d;
}

async function saveQuery(record, texts) {
  const t = texts || {};
  const tokens = {
    user: countTokens(t.user),
    context: countTokens(t.context),
    output: countTokens(t.output),
    reasoning: countTokens(t.reasoning),
    tool: countTokens(t.tool),
  };
  // Rough model-side view: the whole visible history is re-read as input on each turn.
  tokens.inputEst = tokens.user + tokens.context + tokens.tool;
  tokens.outputEst = tokens.output + tokens.reasoning;
  tokens.totalEst = tokens.inputEst + tokens.outputEst;

  const full = {
    ...record,
    tokens,
    tokenizer: self.UsageTokenizer ? self.UsageTokenizer.name : "chars/4",
    usageDelta: delta(record.usageBefore, record.usageAfter),
    preview: (t.user || "").replace(/\s+/g, " ").trim().slice(0, 140),
  };

  const { queries = [] } = await get("queries");
  queries.push(full);
  if (queries.length > MAX_QUERIES) queries.splice(0, queries.length - MAX_QUERIES);
  await set({ queries });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case "usage":
      serial(() => saveUsage(msg.snapshot));
      break;
    case "usage-error":
      serial(() => set({ usageError: { status: msg.status, error: msg.error || null, authed: msg.authed, ts: msg.ts } }));
      break;
    case "diag":
      serial(async () => {
        const { diag = {} } = await get("diag");
        await set({ diag: { ...diag, ...msg.patch } });
      });
      break;
    case "diag-endpoint":
      serial(async () => {
        const { diag = {} } = await get("diag");
        const eps = (diag.endpoints || []).filter((e) => e.endpoint !== msg.endpoint);
        eps.push({ endpoint: msg.endpoint, ts: msg.ts });
        await set({ diag: { ...diag, endpoints: eps.slice(-60) } });
      });
      break;
    case "query":
      serial(() => saveQuery(msg.record, msg.texts));
      break;
    case "open-dashboard":
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
      break;
    case "open-settings":
      chrome.runtime.openOptionsPage();
      break;
    case "clear-data":
      serial(async () => {
        const { prefs } = await get("prefs");
        await chrome.storage.local.clear();
        if (prefs) await set({ prefs });
      }).then(() => {
        chrome.action.setBadgeText({ text: "" });
        sendResponse({ ok: true });
      });
      return true;
  }
});

// Restore badge after the worker restarts.
get("latestUsage").then(({ latestUsage }) => latestUsage && updateBadge(latestUsage));

serial(async () => {
  const { diag = {} } = await get("diag");
  await set({ diag: { ...diag, tokenizer: self.UsageTokenizer ? self.UsageTokenizer.name : "fallback (chars/4)" } });
});
