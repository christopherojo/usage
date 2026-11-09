const $ = (id) => document.getElementById(id);
const HOUR = 3600 * 1000;

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

const fmtNum = (n) => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString());

function fmtDur(ms) {
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function fmtTime(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function sparkline(points, spanMs) {
  // points: [{ts, v}] where v in 0..100
  const W = 380, H = 28;
  const now = Date.now();
  const t0 = now - spanMs;
  const pts = points.filter((p) => p.ts >= t0);
  if (pts.length < 2) return null;
  const x = (ts) => ((ts - t0) / spanMs) * W;
  const y = (v) => H - 1 - (Math.min(100, Math.max(0, v)) / 100) * (H - 2);
  // Step line: usage holds its value until the next sample.
  let d = `M${x(pts[0].ts).toFixed(1)},${y(pts[0].v).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].ts).toFixed(1)} V${y(pts[i].v).toFixed(1)}`;
  d += ` H${W}`;
  const area = `${d} V${H} H${x(pts[0].ts).toFixed(1)} Z`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.innerHTML = `<path class="area" d="${area}"/><path class="line" d="${d}"/>`;
  return svg;
}

function renderLimits(latest, history, error) {
  const box = $("limits");
  const note = $("limits-note");
  box.replaceChildren();
  note.hidden = true;

  if (latest && latest.plan) {
    $("plan").textContent = latest.plan;
    $("plan").hidden = false;
  }
  $("updated").textContent = latest ? fmtAgo(latest.ts) : "";

  if (!latest || !latest.windows.length) {
    note.hidden = false;
    if (error && error.status) {
      note.textContent =
        error.status === 404
          ? "No rate-limit data returned for this account (the usage endpoint returned 404). Per-query token estimates still work."
          : `Couldn't read limits (HTTP ${error.status}). Make sure you're signed in at chatgpt.com, then refresh.`;
    } else {
      note.textContent = "No data yet. Open chatgpt.com (signed in) and hit ↻.";
    }
    return;
  }

  for (const w of latest.windows) {
    const pct = w.usedPercent;
    const cls = pct >= 90 ? "bad" : pct >= 70 ? "warn" : "";
    const reset = w.resetAt
      ? `resets in ${fmtDur(w.resetAt - Date.now())} · ${fmtTime(w.resetAt)}`
      : "reset time unknown";
    const span = (w.windowSeconds || 5 * 3600) * 1000;
    const pts = history
      .map((h) => {
        const hw = h.windows.find((x) => x.key === w.key);
        return hw ? { ts: h.ts, v: hw.usedPercent } : null;
      })
      .filter(Boolean);
    box.append(
      el(
        "div",
        { class: "limit" },
        el(
          "div",
          { class: "limit-top" },
          el("span", { class: "limit-name" }, `${w.label} limit`, w.group ? el("span", { class: "limit-group", text: w.group }) : null),
          el("span", { class: "limit-pct", text: `${pct}%` })
        ),
        el("div", { class: `bar ${cls}` }, el("span", { style: `width:${Math.min(100, pct)}%` })),
        el("div", { class: "limit-foot" }, el("span", { text: `${Math.max(0, Math.round((100 - pct) * 10) / 10)}% left` }), el("span", { text: reset })),
        sparkline(pts, span)
      )
    );
  }
  if (latest.limitReached) {
    note.hidden = false;
    note.textContent = "Limit reached for at least one window.";
  }
}

function renderStats(queries) {
  const now = Date.now();
  const within = (ms) => queries.filter((q) => q.ts >= now - ms);
  const sum = (qs) => qs.reduce((a, q) => a + ((q.tokens && q.tokens.totalEst) || 0), 0);
  const h5 = within(5 * HOUR);
  const d7 = within(7 * 24 * HOUR);
  $("stats").replaceChildren(
    el("div", { class: "stat" }, el("b", { text: h5.length }), el("span", { text: "msgs · 5h" })),
    el("div", { class: "stat" }, el("b", { text: d7.length }), el("span", { text: "msgs · 7d" })),
    el("div", { class: "stat" }, el("b", { text: fmtNum(sum(h5)) }), el("span", { text: "~tokens · 5h" })),
    el("div", { class: "stat" }, el("b", { text: fmtNum(sum(d7)) }), el("span", { text: "~tokens · 7d" }))
  );

  // Per-model counts over the last 5h (useful for per-model message caps).
  const byModel = {};
  for (const q of h5) {
    const m = q.model || "unknown";
    byModel[m] = (byModel[m] || 0) + 1;
  }
  const chips = Object.entries(byModel)
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => el("span", { class: "chip", text: `${m}: ${n}` }));
  $("models").replaceChildren(...(chips.length ? [el("span", { class: "muted small", text: "Last 5h by model:" }), ...chips] : []));
}

function renderQueries(queries, latest) {
  const list = $("queries");
  list.replaceChildren();
  const recent = queries.slice(-60).reverse();
  if (!recent.length) {
    list.append(el("li", { class: "empty", text: "Send a message on chatgpt.com and it will show up here." }));
    return;
  }
  const tk = recent.find((q) => q.tokenizer);
  $("tok-note").textContent = tk ? `tokens ≈ ${tk.tokenizer}` : "";
  const labels = {};
  if (latest) for (const w of latest.windows) labels[w.key] = w.label;

  for (const q of recent) {
    const t = q.tokens || {};
    const tags = [];
    if (!q.ok) tags.push(el("span", { class: "tag err", text: `error ${q.status || ""}`.trim() }));
    tags.push(el("span", { class: "tag", title: "Your prompt", text: `in ${fmtNum(t.user || 0)}` }));
    if (t.context) tags.push(el("span", { class: "tag", title: "Earlier conversation re-sent as context", text: `ctx ${fmtNum(t.context)}` }));
    tags.push(el("span", { class: "tag", title: "Visible reply", text: `out ${fmtNum(t.output || 0)}` }));
    if (t.reasoning) tags.push(el("span", { class: "tag", title: "Reasoning summary text (actual hidden reasoning is larger)", text: `think ${fmtNum(t.reasoning)}` }));
    if (t.tool) tags.push(el("span", { class: "tag", title: "Tool calls / outputs (search, code, etc.)", text: `tool ${fmtNum(t.tool)}` }));
    if (q.reasoningSec) tags.push(el("span", { class: "tag", text: `${Math.round(q.reasoningSec)}s thinking` }));
    if (q.usageDelta) {
      for (const [k, v] of Object.entries(q.usageDelta)) {
        if (v) tags.push(el("span", { class: "tag delta", title: "Change in limit usage across this query", text: `${v > 0 ? "+" : ""}${v}% ${labels[k] || k}` }));
      }
    }
    const href = q.conversationId ? `https://chatgpt.com/c/${q.conversationId}` : null;
    const previewText = q.preview || (q.kind === "codex-task" ? "Codex task" : "(no text)");
    list.append(
      el(
        "li",
        { class: "q" },
        el(
          "div",
          { class: "q-top" },
          el("span", {}, el("span", { class: "q-model", text: q.model || q.kind }), q.title ? ` · ${q.title}` : ""),
          el("span", { text: fmtTime(q.ts) })
        ),
        el("div", { class: "q-preview", title: previewText }, href ? el("a", { href, target: "_blank", text: previewText }) : previewText),
        el("div", { class: "q-meta" }, tags)
      )
    );
  }
}

async function render() {
  const { latestUsage, usageHistory = [], usageError, queries = [], diag = {} } = await chrome.storage.local.get([
    "latestUsage",
    "usageHistory",
    "usageError",
    "queries",
    "diag",
  ]);
  renderLimits(latestUsage, usageHistory, usageError);
  renderStatus(diag, usageError, latestUsage);
  renderStats(queries);
  renderQueries(queries, latestUsage);
}

let tabState = { checked: false };

async function refresh() {
  const btn = $("refresh");
  btn.classList.add("spin");
  try {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    if (!tabs.length) {
      tabState = { checked: true, found: false };
      return;
    }
    const tab = tabs.find((t) => t.active) || tabs[0];
    const ping = await chrome.tabs.sendMessage(tab.id, { type: "ping" }).catch(() => null);
    tabState = { checked: true, found: true, attached: !!ping, interceptor: ping && ping.interceptor, authed: ping && ping.authed };
    if (ping) await chrome.tabs.sendMessage(tab.id, { type: "refresh-usage" }).catch(() => null);
  } finally {
    btn.classList.remove("spin");
    await render();
  }
}

function renderStatus(diag, usageError, latest) {
  const rows = [];
  let problem = null;
  const add = (k, v, level, detail) => rows.push({ k, v, level, detail });

  if (!tabState.checked) add("chatgpt.com tab", "checking…", "warnv");
  else if (!tabState.found) {
    add("chatgpt.com tab", "none open", "badv");
    problem = problem || "open chatgpt.com";
  } else if (!tabState.attached) {
    add("chatgpt.com tab", "extension not attached; reload the tab", "badv");
    problem = problem || "reload your chatgpt.com tab";
  } else {
    add("chatgpt.com tab", "attached", "good");
    add("Request watcher", tabState.interceptor ? "running" : "not running (queries won't be logged)", tabState.interceptor ? "good" : "badv");
    if (!tabState.interceptor) problem = problem || "request watcher not running";
  }

  if (latest && latest.windows.length && (!usageError || usageError.ts < latest.ts)) {
    add("Limits endpoint", `OK · ${fmtAgo(latest.ts)}`, "good");
  } else if (usageError) {
    const why = usageError.status ? `HTTP ${usageError.status}` : "request failed";
    add("Limits endpoint", `${why} · ${fmtAgo(usageError.ts)}${usageError.authed === false ? " · no auth token" : ""}`, "badv", usageError.error);
    problem = problem || `limits ${why}`;
  } else if (latest) {
    add("Limits endpoint", "responded, but no limit windows found in the data", "warnv");
    problem = problem || "no limit windows in response";
  } else {
    add("Limits endpoint", "not called yet", "warnv");
  }

  if (diag.lastQueryStart) {
    const done = diag.lastQueryComplete && diag.lastQueryComplete >= diag.lastQueryStart;
    add("Last query seen", `${fmtAgo(diag.lastQueryStart)}${done ? ` · finished (HTTP ${diag.lastQueryStatus})` : " · still streaming"}`, done ? "good" : "warnv");
  } else {
    add("Last query seen", "none yet; send a message on chatgpt.com", "warnv");
  }
  add("Tokenizer", diag.tokenizer || "unknown", diag.tokenizer && !/fallback/.test(diag.tokenizer) ? "good" : "warnv");

  const eps = (diag.endpoints || []).filter((e) => /^POST /.test(e.endpoint) || /usage|conversation|wham/.test(e.endpoint));
  if (eps.length) add("Endpoints seen", eps.slice(-12).map((e) => e.endpoint).join("\n"), null);

  $("status").replaceChildren(
    ...rows.map((r) =>
      el(
        "li",
        {},
        el("span", { class: "k", text: r.k }),
        el("span", { class: `v ${r.level || ""}` }, ...String(r.v).split("\n").flatMap((line, i) => (i ? [el("br"), el("code", { text: line })] : r.k === "Endpoints seen" ? [el("code", { text: line })] : [line])), r.detail ? [el("br"), el("code", { text: String(r.detail).slice(0, 200) })] : [])
      )
    )
  );
  $("status-summary").textContent = problem ? `⚠ ${problem}` : tabState.checked ? "all good" : "";
  if (problem && tabState.checked) $("status-box").open = true;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportCSV() {
  const { queries = [] } = await chrome.storage.local.get("queries");
  const keys = new Set();
  for (const q of queries) for (const k of Object.keys(q.usageDelta || {})) keys.add(k);
  const dk = [...keys];
  const head = ["time", "kind", "model", "title", "prompt_tokens", "context_tokens", "output_tokens", "reasoning_tokens", "tool_tokens", "total_est", "duration_s", "thinking_s", "status", ...dk.map((k) => `delta_${k}`), "conversation_id", "preview"];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = queries.map((q) => {
    const t = q.tokens || {};
    return [
      new Date(q.ts).toISOString(), q.kind, q.model, q.title, t.user, t.context, t.output, t.reasoning, t.tool, t.totalEst,
      q.durationMs ? (q.durationMs / 1000).toFixed(1) : "", q.reasoningSec ?? "", q.status,
      ...dk.map((k) => (q.usageDelta || {})[k] ?? ""), q.conversationId, q.preview,
    ].map(esc).join(",");
  });
  download(`chatgpt-usage-${new Date().toISOString().slice(0, 10)}.csv`, [head.join(","), ...rows].join("\n"), "text/csv");
}

async function exportJSON() {
  const data = await chrome.storage.local.get(["queries", "usageHistory", "latestUsage"]);
  download(`chatgpt-usage-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), "application/json");
}

$("refresh").addEventListener("click", refresh);
$("copy-diag").addEventListener("click", async () => {
  const { diag = {}, usageError, latestUsage, queries = [] } = await chrome.storage.local.get(["diag", "usageError", "latestUsage", "queries"]);
  const report = {
    tabState,
    diag,
    usageError,
    latestUsage: latestUsage ? { ts: latestUsage.ts, plan: latestUsage.plan, windows: latestUsage.windows, rawKeys: latestUsage.raw ? Object.keys(latestUsage.raw) : null } : null,
    queryCount: queries.length,
    lastQuery: queries.length ? { ...queries[queries.length - 1], preview: undefined, title: undefined } : null,
    userAgent: navigator.userAgent,
  };
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  $("copy-diag").textContent = "Copied ✓";
  setTimeout(() => ($("copy-diag").textContent = "Copy diagnostics"), 1500);
});
$("export-csv").addEventListener("click", exportCSV);
$("export-json").addEventListener("click", exportJSON);
$("clear").addEventListener("click", async () => {
  if (!confirm("Delete all locally stored usage history and query logs?")) return;
  await chrome.runtime.sendMessage({ type: "clear-data" });
  render();
});
chrome.storage.onChanged.addListener((_c, area) => area === "local" && render());

render().then(refresh);
