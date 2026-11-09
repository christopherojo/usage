// Isolated-world content script on chatgpt.com.
// - Receives events from inject.js (MAIN world)
// - Fetches usage + conversation JSON from chatgpt.com using the page's own session
// - Forwards normalized records to background.js for storage / tokenizing
(() => {
  if (window.__usageMeterContent) return;
  window.__usageMeterContent = true;
  const SRC = "chatgpt-usage-meter";
  const USAGE_PATH = "/backend-api/wham/usage";
  const POLL_MS = 5 * 60 * 1000;
  const FRESH_MS = 45 * 1000;

  let authHeader = null;
  let accountId = null;
  let latest = null; // last normalized usage snapshot
  let inflightUsage = null;
  let lastResult = null; // { ok, status, error, ts } of the most recent usage fetch
  const pending = new Map(); // queryId -> start info

  const send = (msg) => {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_) {
      // Extension was reloaded; this content script is orphaned.
    }
  };

  // ---------- auth ----------
  async function ensureAuth(force = false) {
    if (authHeader && !force) return authHeader;
    try {
      const r = await fetch("/api/auth/session", { credentials: "include" });
      if (r.ok) {
        const j = await r.json();
        if (j && j.accessToken) authHeader = `Bearer ${j.accessToken}`;
      }
    } catch (_) {}
    return authHeader;
  }

  async function api(path, retry = true) {
    const auth = await ensureAuth();
    const headers = {};
    if (auth) headers.Authorization = auth;
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const r = await fetch(path, { credentials: "include", headers });
    if ((r.status === 401 || r.status === 403) && retry) {
      await ensureAuth(true);
      return api(path, false);
    }
    return r;
  }

  // ---------- usage ----------
  const WINDOW_LABELS = [
    [5 * 3600, "5-hour"],
    [7 * 24 * 3600, "Weekly"],
    [24 * 3600, "Daily"],
    [3 * 3600, "3-hour"],
  ];

  function labelFor(seconds, fallback) {
    if (!seconds) return fallback;
    for (const [s, l] of WINDOW_LABELS) if (Math.abs(seconds - s) <= s * 0.05) return l;
    const h = seconds / 3600;
    return h >= 48 ? `${Math.round(h / 24)}-day` : `${Math.round(h)}-hour`;
  }

  function normWindow(w, key, ts, group) {
    if (!w || typeof w !== "object") return null;
    const used = w.used_percent ?? w.usedPercent ?? w.percent_used;
    if (typeof used !== "number") return null;
    const secs = w.limit_window_seconds ?? w.window_seconds ?? (w.window_minutes ? w.window_minutes * 60 : null);
    let resetAt = null;
    if (typeof w.reset_at === "number") resetAt = w.reset_at < 1e12 ? w.reset_at * 1000 : w.reset_at;
    else if (typeof w.resets_at === "number") resetAt = w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at;
    else if (typeof w.reset_after_seconds === "number") resetAt = ts + w.reset_after_seconds * 1000;
    const label = labelFor(secs, key);
    return {
      key: group ? `${group}:${label}` : label,
      label,
      group: group || null,
      usedPercent: Math.round(used * 10) / 10,
      windowSeconds: secs || null,
      resetAt,
    };
  }

  // Walk the payload and pick up every object that looks like a rate-limit window.
  // Tolerant of shape changes: { rate_limit: { primary_window, secondary_window }, ... }
  function normalizeUsage(raw, ts = Date.now()) {
    const windows = [];
    const seen = new Set();
    const walk = (obj, path, depth) => {
      if (!obj || typeof obj !== "object" || depth > 5) return;
      if (typeof (obj.used_percent ?? obj.usedPercent ?? obj.percent_used) === "number") {
        // Group = the nearest parent key that isn't a generic window name.
        const generic = /^(rate_limit|primary_window|secondary_window|primary|secondary|windows?|\d+)$/;
        const group = path.filter((p) => !generic.test(p)).pop() || null;
        const w = normWindow(obj, path[path.length - 1] || "limit", ts, group);
        if (w && !seen.has(w.key)) {
          seen.add(w.key);
          windows.push(w);
        }
        return;
      }
      for (const k of Object.keys(obj)) walk(obj[k], path.concat(k), depth + 1);
    };
    walk(raw, [], 0);
    windows.sort((a, b) => (a.windowSeconds || 1e12) - (b.windowSeconds || 1e12));
    const rl = raw && raw.rate_limit;
    return {
      ts,
      plan: (raw && (raw.plan_type || raw.plan)) || null,
      limitReached: rl ? !!rl.limit_reached || rl.allowed === false : null,
      credits: raw && raw.credits ? raw.credits : null,
      windows,
      raw,
    };
  }

  async function fetchUsage() {
    if (inflightUsage) return inflightUsage;
    inflightUsage = (async () => {
      try {
        const r = await api(USAGE_PATH);
        if (!r.ok) {
          let body = "";
          try { body = (await r.text()).slice(0, 300); } catch (_) {}
          send({ type: "usage-error", status: r.status, error: body, authed: !!authHeader, ts: Date.now() });
          lastResult = { ok: false, status: r.status, error: body, ts: Date.now() };
          return latest;
        }
        const snap = normalizeUsage(await r.json());
        latest = snap;
        send({ type: "usage", snapshot: snap });
        lastResult = { ok: true, status: r.status, ts: Date.now() };
        return snap;
      } catch (e) {
        send({ type: "usage-error", status: 0, error: String(e), authed: !!authHeader, ts: Date.now() });
        lastResult = { ok: false, status: 0, error: String(e), ts: Date.now() };
        return latest;
      } finally {
        setTimeout(() => (inflightUsage = null), 0);
      }
    })();
    return inflightUsage;
  }

  async function usageNow() {
    if (latest && Date.now() - latest.ts < FRESH_MS) return latest;
    return fetchUsage();
  }

  const pctMap = (snap) => {
    if (!snap) return null;
    const m = {};
    for (const w of snap.windows) m[w.key] = w.usedPercent;
    return m;
  };

  // ---------- conversation parsing ----------
  function msgText(msg) {
    const c = msg && msg.content;
    if (!c) return { text: "", kind: "other", images: 0 };
    const ct = c.content_type;
    let images = 0;
    const partStr = (parts) =>
      (parts || [])
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object") {
            if (p.content_type === "image_asset_pointer") images++;
            if (typeof p.text === "string") return p.text;
          }
          return "";
        })
        .join("\n");
    switch (ct) {
      case "text":
      case "multimodal_text":
        return { text: partStr(c.parts), kind: "text", images };
      case "thoughts":
        return {
          text: (c.thoughts || []).map((t) => [t.summary, t.content].filter(Boolean).join("\n")).join("\n"),
          kind: "reasoning",
          images,
        };
      case "reasoning_recap":
        return { text: "", kind: "recap", images };
      case "code":
      case "execution_output":
      case "tether_browsing_display":
      case "tether_quote":
      case "system_error":
        return { text: c.text || c.result || partStr(c.parts) || "", kind: "tool", images };
      default:
        return { text: typeof c.text === "string" ? c.text : partStr(c.parts), kind: "other", images };
    }
  }

  function extractTurn(conv, userMessageId) {
    const mapping = conv.mapping || {};
    let node = conv.current_node;
    const path = [];
    while (node && mapping[node]) {
      path.push(mapping[node]);
      node = mapping[node].parent;
    }
    path.reverse(); // root -> current

    let userIdx = -1;
    if (userMessageId) userIdx = path.findIndex((n) => n.id === userMessageId || (n.message && n.message.id === userMessageId));
    if (userIdx < 0) {
      for (let i = path.length - 1; i >= 0; i--) {
        const m = path[i].message;
        if (m && m.author && m.author.role === "user") {
          userIdx = i;
          break;
        }
      }
    }
    if (userIdx < 0) return null;

    const ctx = [];
    for (let i = 0; i < userIdx; i++) {
      const m = path[i].message;
      if (!m || (m.metadata && m.metadata.is_visually_hidden_from_conversation)) continue;
      const t = msgText(m).text;
      if (t) ctx.push(t);
    }

    const user = msgText(path[userIdx].message);
    const out = { output: [], reasoning: [], tool: [], images: user.images };
    let model = null;
    let reasoningSec = null;
    for (let i = userIdx + 1; i < path.length; i++) {
      const m = path[i].message;
      if (!m) continue;
      const md = m.metadata || {};
      model = md.resolved_model_slug || md.model_slug || model;
      if (typeof md.finished_duration_sec === "number") reasoningSec = md.finished_duration_sec;
      const role = m.author && m.author.role;
      const t = msgText(m);
      if (t.kind === "reasoning") out.reasoning.push(t.text);
      else if (role === "tool" || t.kind === "tool") out.tool.push(t.text);
      else if (role === "assistant" && t.kind === "text" && m.recipient === "all") out.output.push(t.text);
      else if (role === "assistant") out.tool.push(t.text); // assistant -> tool calls
    }
    return {
      title: conv.title || null,
      model,
      reasoningSec,
      userText: user.text,
      contextText: ctx.join("\n\n"),
      outputText: out.output.join("\n\n"),
      reasoningText: out.reasoning.join("\n\n"),
      toolText: out.tool.join("\n\n"),
      images: out.images,
    };
  }

  async function fetchTurn(conversationId, userMessageId) {
    if (!conversationId) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await api(`/backend-api/conversation/${conversationId}`);
        if (r.ok) {
          const turn = extractTurn(await r.json(), userMessageId);
          if (turn && (turn.outputText || attempt === 2)) return turn;
        }
      } catch (_) {}
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
    return null;
  }

  // ---------- query lifecycle ----------
  async function onQueryStart(p) {
    const entry = { ...p, before: null };
    pending.set(p.queryId, entry);
    entry.beforePromise = usageNow().then((s) => (entry.before = pctMap(s)));
  }

  async function onQueryComplete(p) {
    const start = pending.get(p.queryId) || { queryId: p.queryId };
    pending.delete(p.queryId);
    try {
      await start.beforePromise;
    } catch (_) {}

    // Give the server a moment to settle usage + persist the conversation.
    await new Promise((r) => setTimeout(r, 2500));
    const conversationId = p.conversationId || start.conversationId;
    const [after, turn] = await Promise.all([
      fetchUsage().then(pctMap),
      start.kind === "chat" && p.ok ? fetchTurn(conversationId, start.userMessageId) : null,
    ]);

    send({
      type: "query",
      record: {
        id: p.queryId,
        kind: start.kind || "chat",
        ts: start.startedAt || p.endedAt,
        endedAt: p.endedAt,
        durationMs: p.durationMs,
        firstByteMs: p.firstByteMs,
        ok: p.ok,
        status: p.status,
        error: p.errorSnippet || p.error || null,
        conversationId,
        requestedModel: start.model || null,
        model: (turn && turn.model) || p.modelSlug || start.model || null,
        title: turn ? turn.title : null,
        reasoningSec: turn ? turn.reasoningSec : null,
        attachments: start.attachments || 0,
        images: turn ? turn.images : 0,
        usageBefore: start.before || null,
        usageAfter: after || null,
      },
      // Raw texts are tokenized in the background and then discarded (only counts + a short preview are stored).
      texts: {
        user: (turn && turn.userText) || start.userText || "",
        context: turn ? turn.contextText : "",
        output: turn ? turn.outputText : "",
        reasoning: turn ? turn.reasoningText : "",
        tool: turn ? turn.toolText : "",
      },
    });
  }

  // ---------- wiring ----------
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== SRC || ev.data.dir !== "to-content") return;
    const { type, payload } = ev.data;
    if (type === "auth") {
      authHeader = payload.authorization || authHeader;
      accountId = payload.accountId || accountId;
    } else if (type === "seen") {
      send({ type: "diag-endpoint", endpoint: payload.endpoint, ts: Date.now() });
    } else if (type === "query-start") {
      send({ type: "diag", patch: { lastQueryStart: Date.now(), lastQueryKind: payload.kind } });
      onQueryStart(payload);
    } else if (type === "query-complete") {
      send({ type: "diag", patch: { lastQueryComplete: Date.now(), lastQueryStatus: payload.status } });
      onQueryComplete(payload);
    } else if (type === "usage-raw") {
      latest = normalizeUsage(payload.json, payload.ts);
      send({ type: "usage", snapshot: latest });
    }
  });

  send({ type: "diag", patch: { contentAttached: Date.now(), pageUrl: location.pathname } });
  // inject.js sets this flag in the page; the DOM attribute is visible to both worlds.
  setTimeout(() => {
    send({ type: "diag", patch: { interceptor: document.documentElement.dataset.usageMeter === "on" } });
  }, 1500);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "ping") {
      sendResponse({ ok: true, interceptor: document.documentElement.dataset.usageMeter === "on", authed: !!authHeader });
      return;
    }
    if (msg && msg.type === "refresh-usage") {
      // Report the outcome of THIS fetch, not just whether we have cached data.
      fetchUsage().then(() => sendResponse({ ...(lastResult || { ok: false, status: 0 }), windows: latest ? latest.windows.length : 0 }));
      return true;
    }
  });

  // Poll on the interval from Settings (default 5 min) while the tab is visible.
  let pollTimer = null;
  function schedulePoll(minutes) {
    clearInterval(pollTimer);
    const ms = Math.max(1, Number(minutes) || POLL_MS / 60000) * 60000;
    pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") fetchUsage();
    }, ms);
  }
  UsageShared.loadPrefs().then((p) => schedulePoll(p.pollMinutes));
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && c.prefs && c.prefs.newValue) schedulePoll(c.prefs.newValue.pollMinutes);
  });
  document.addEventListener("visibilitychange", () => {
    // Catch up when you come back to the tab after a while.
    if (document.visibilityState === "visible" && (!latest || Date.now() - latest.ts > 60000)) fetchUsage();
  });
  setTimeout(fetchUsage, 3000);
})();
