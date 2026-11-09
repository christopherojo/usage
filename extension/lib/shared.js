// Shared settings + colour levels. Loaded by background (importScripts), content scripts,
// popup, dashboard and options pages. Exposes self.UsageShared.
(function (root) {
  // Bump on every change. Pages read this file fresh from disk; the background keeps whatever
  // was loaded at the last extension reload, so a mismatch means "reload the extension".
  const BUILD = "0.3.3";

  const DEFAULT_PREFS = {
    view: "used", // "used" | "left"
    badgeWindow: "tightest", // toolbar icon/number: tightest | <window key> e.g. "5-hour", "Weekly"
    thresholds: { caution: 50, warn: 25, critical: 10 }, // colour levels by % LEFT
    pollMinutes: 5,
    pill: {
      enabled: true,
      position: "bottom-right", // bottom-right | bottom-left | top-right | top-left
      window: "tightest", // tightest | all (both limits) | <window key>; legacy "first" = shortest
    },
  };

  const LEVEL_COLORS = { ok: "#188038", caution: "#b58100", warn: "#e37400", critical: "#d93025" };
  const LEVEL_TEXT = { ok: "Plenty left", caution: "Over half used", warn: "Running low", critical: "Almost out" };

  function mergePrefs(p) {
    p = p || {};
    return {
      ...DEFAULT_PREFS,
      ...p,
      thresholds: { ...DEFAULT_PREFS.thresholds, ...(p.thresholds || {}) },
      pill: { ...DEFAULT_PREFS.pill, ...(p.pill || {}) },
    };
  }

  function levelFor(left, thresholds) {
    const t = thresholds || DEFAULT_PREFS.thresholds;
    if (left < t.critical) return "critical";
    if (left < t.warn) return "warn";
    if (left < t.caution) return "caution";
    return "ok";
  }

  async function loadPrefs() {
    try {
      const { prefs } = await chrome.storage.local.get("prefs");
      return mergePrefs(prefs);
    } catch (_) {
      return mergePrefs();
    }
  }

  // Pick the window to summarise: the one closest to running out, or a specific key.
  function pickWindow(windows, which) {
    if (!windows || !windows.length) return null;
    if (which && which !== "tightest" && which !== "first") {
      const w = windows.find((x) => x.key === which);
      if (w) return w;
    }
    if (which === "first") return windows[0];
    return windows.reduce((a, w) => (w.usedPercent > a.usedPercent ? w : a));
  }

  function fmtDur(ms) {
    if (ms <= 0) return "now";
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  }

  const fmtNum = (n) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : Number(n || 0).toLocaleString();

  // Group per-query records into conversations.
  function aggregateConversations(queries, sinceTs = 0) {
    const map = new Map();
    for (const q of queries) {
      if (q.ts < sinceTs || !q.conversationId) continue;
      let c = map.get(q.conversationId);
      if (!c) {
        c = { conversationId: q.conversationId, title: null, messages: 0, tokens: 0, output: 0, lastContext: 0, firstTs: q.ts, lastTs: q.ts, delta: {}, models: {} };
        map.set(q.conversationId, c);
      }
      const t = q.tokens || {};
      c.messages++;
      c.tokens += t.totalEst || 0;
      c.output += (t.output || 0) + (t.reasoning || 0);
      if (q.ts >= c.lastTs) {
        c.lastTs = q.ts;
        c.lastContext = (t.context || 0) + (t.user || 0);
      }
      c.firstTs = Math.min(c.firstTs, q.ts);
      if (q.title) c.title = q.title;
      if (q.model) c.models[q.model] = (c.models[q.model] || 0) + 1;
      for (const [k, v] of Object.entries(q.usageDelta || {})) if (v > 0) c.delta[k] = Math.round(((c.delta[k] || 0) + v) * 10) / 10;
    }
    return [...map.values()].sort((a, b) => b.tokens - a.tokens);
  }

  // Open (or focus) the settings tab ourselves. chrome.runtime.openOptionsPage() can throw
  // "Could not create an options page" (e.g. when the loaded manifest is stale), so avoid it.
  async function openSettings() {
    const url = chrome.runtime.getURL("options/options.html");
    try {
      const [existing] = await chrome.tabs.query({ url });
      if (existing) {
        await chrome.tabs.update(existing.id, { active: true });
        await chrome.windows.update(existing.windowId, { focused: true });
        return;
      }
    } catch (_) {}
    await chrome.tabs.create({ url });
  }

  root.UsageShared = {
    BUILD,
    openSettings,
    aggregateConversations, DEFAULT_PREFS, LEVEL_COLORS, LEVEL_TEXT, mergePrefs, levelFor, loadPrefs, pickWindow, fmtDur, fmtTime, fmtNum };
})(typeof self !== "undefined" ? self : globalThis);
