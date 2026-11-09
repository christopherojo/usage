const $ = (id) => document.getElementById(id);
const HOUR = 3600 * 1000;

// Colour level from % remaining. Same thresholds as the badge in background.js.
function levelFor(left) {
  return UsageShared.levelFor(left, prefs.thresholds);
}
const LEVEL_TEXT = { ok: "Plenty left", caution: "Over half used", warn: "Running low", critical: "Almost out" };

let prefs = UsageShared.mergePrefs();

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

const fmtNum = UsageShared.fmtNum;

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

function sparkline(points, { t0, t1, now = Date.now(), project = null }) {
  // points: [{ts, v}] where v in 0..100. Domain t0..t1 (the current window).
  // project: { ts, v } -> dashed line from the live value to that point.
  const W = 380, H = 30;
  const span = Math.max(1, t1 - t0);
  const pts = points.filter((p) => p.ts >= t0 && p.ts <= now);
  if (!pts.length) return null;
  const x = (ts) => Math.min(W, Math.max(0, ((ts - t0) / span) * W)).toFixed(1);
  const y = (v) => (H - 1 - (Math.min(100, Math.max(0, v)) / 100) * (H - 2)).toFixed(1);
  // Step line: usage holds its value until the next sample.
  let d = `M${x(pts[0].ts)},${y(pts[0].v)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].ts)} V${y(pts[i].v)}`;
  d += ` H${x(now)}`;
  const area = `${d} V${H} H${x(pts[0].ts)} Z`;
  const last = pts[pts.length - 1];
  let extra = `<line class="now" x1="${x(now)}" x2="${x(now)}" y1="0" y2="${H}"/>`;
  if (project) extra += `<path class="proj" d="M${x(now)},${y(last.v)} L${x(project.ts)},${y(project.v)}"/>`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.innerHTML = `<path class="area" d="${area}"/><path class="line" d="${d}"/>${extra}`;
  return svg;
}

function forecastLine(w, f, showLeft) {
  const used = w.usedPercent;
  const rate = f.ratePerHour != null ? `${f.ratePerHour < 1 ? f.ratePerHour.toFixed(2) : f.ratePerHour.toFixed(1)}%/h` : "";
  const basis = f.basis === "recent" ? `recent pace (last ${fmtDur(f.lookbackMs)})` : "average pace this window";
  const tip = rate ? `Burn rate ${rate}, based on ${basis}` : "";
  const pace =
    f.evenPaceUsed == null ? "" : used > f.evenPaceUsed + 5 ? " · ahead of even pace" : used < f.evenPaceUsed - 5 ? " · under even pace" : " · on even pace";
  switch (f.status) {
    case "maxed":
      return el("div", { class: "forecast lvl-critical" }, "⛔ Limit reached", w.resetAt ? ` · back in ${fmtDur(w.resetAt - Date.now())}` : "");
    case "runout": {
      const lead = w.resetAt ? ` · ${fmtDur(w.resetAt - f.runOutAt)} before reset` : "";
      const lvl = f.runOutAt - Date.now() < 30 * 60e3 ? "critical" : "warn";
      return el("div", { class: `forecast lvl-${lvl}`, title: tip }, "⚠ At this pace you run out ", el("b", { text: `~${fmtTime(f.runOutAt)}` }), ` (in ${fmtDur(f.runOutAt - Date.now())})${lead}`, rate ? el("span", { class: "rate", text: rate }) : null);
    }
    case "on-track": {
      const p = Math.round(f.projectedAtReset);
      return el("div", { class: "forecast", title: tip }, "✓ On pace for ", el("b", { text: showLeft ? `~${100 - p}% left` : `~${p}% used` }), ` at reset${pace}`, rate ? el("span", { class: "rate", text: rate }) : null);
    }
    case "idle":
      return el("div", { class: "forecast", title: tip }, `No recent usage · holding at ${showLeft ? `${Math.round(100 - used)}% left` : `${Math.round(used)}% used`}${pace}`);
    default:
      return el("div", { class: "forecast muted" }, "Collecting data for a forecast…");
  }
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
  lastLatestTs = latest ? latest.ts : null;
  paintUpdated();

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

  const showLeft = prefs.view === "left";
  let tightest = null;

  for (const w of latest.windows) {
    const used = Math.min(100, Math.max(0, w.usedPercent));
    const left = Math.round((100 - used) * 10) / 10;
    const lvl = levelFor(left);
    if (!tightest || left < tightest.left) tightest = { w, left, lvl };
    const shown = showLeft ? left : used;
    const reset = w.resetAt
      ? `resets in ${fmtDur(w.resetAt - Date.now())} · ${fmtTime(w.resetAt)}`
      : "reset time unknown";
    const span = (w.windowSeconds || 5 * 3600) * 1000;
    const now = Date.now();
    const f = UsageForecast.forecastWindow(w, history, now, latest.ts);
    const inv = (v) => (showLeft ? 100 - v : v);
    const t1 = w.resetAt || now;
    const t0 = w.resetAt ? w.resetAt - span : now - span;
    let project = null;
    if (f.status === "runout") project = { ts: f.runOutAt, v: inv(100) };
    else if (f.status === "on-track" || f.status === "idle") project = w.resetAt ? { ts: w.resetAt, v: inv(f.projectedAtReset) } : null;
    const paceTick =
      f.evenPaceUsed == null ? null : el("i", { class: "pace", style: `left:${inv(f.evenPaceUsed)}%`, title: `Even pace: ${Math.round(f.evenPaceUsed)}% used by now` });
    const pts = history
      .map((h) => {
        const hw = h.windows.find((x) => x.key === w.key);
        return hw ? { ts: h.ts, v: showLeft ? 100 - hw.usedPercent : hw.usedPercent } : null;
      })
      .filter(Boolean);
    box.append(
      el(
        "div",
        { class: `limit lvl-${lvl}`, title: LEVEL_TEXT[lvl] },
        el(
          "div",
          { class: "limit-top" },
          el("span", { class: "limit-name" }, `${w.label} limit`, w.group ? el("span", { class: "limit-group", text: w.group }) : null),
          el("span", { class: "limit-pct" }, `${shown}%`, el("span", { class: "limit-unit", text: showLeft ? " left" : " used" }))
        ),
        el("div", { class: "bar" }, el("span", { style: `width:${shown}%` }), paceTick),
        el(
          "div",
          { class: "limit-foot" },
          el("span", { text: showLeft ? `${used}% used` : `${left}% left` }),
          el("span", { text: reset })
        ),
        forecastLine(w, f, showLeft),
        sparkline(pts.concat({ ts: latest.ts, v: inv(used) }), { t0, t1, now, project })
      )
    );
  }

  // Low-limit banner for the most constrained window.
  if (tightest && (tightest.lvl === "warn" || tightest.lvl === "critical")) {
    const { w, left, lvl } = tightest;
    const when = w.resetAt ? ` · resets in ${fmtDur(w.resetAt - Date.now())}` : "";
    box.prepend(
      el("div", { class: `alert lvl-${lvl}` }, el("b", { text: left <= 0 ? `${w.label} limit reached` : `Only ${left}% of your ${w.label} limit left` }), when)
    );
  }
  if (latest.limitReached) {
    note.hidden = false;
    note.textContent = "Limit reached for at least one window.";
  }
}

function setView(view) {
  prefs.view = view;
  for (const b of document.querySelectorAll("#view-toggle button")) b.setAttribute("aria-pressed", String(b.dataset.view === view));
  chrome.storage.local.set({ prefs }).then(render);
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

const LONG_CONTEXT = 20000; // tokens re-sent per message before we flag a chat as "long"

function renderTopChats(queries) {
  const list = $("top-chats");
  const chats = UsageShared.aggregateConversations(queries, Date.now() - 7 * 24 * HOUR).slice(0, 4);
  if (!chats.length) {
    list.replaceChildren(el("li", { class: "empty", text: "No chats tracked in the last 7 days." }));
    return;
  }
  const max = chats[0].tokens || 1;
  list.replaceChildren(
    ...chats.map((c) => {
      const deltas = Object.entries(c.delta).map(([k, v]) => `+${v}% ${k}`).join(" · ");
      return el(
        "li",
        { class: "chat" },
        el("a", { href: `https://chatgpt.com/c/${c.conversationId}`, target: "_blank", title: c.title || "", text: c.title || "Untitled chat" }),
        el("span", { class: "tok", text: `~${fmtNum(c.tokens)}` }),
        el("div", { class: "meter" }, el("span", { style: `width:${(c.tokens / max) * 100}%` })),
        el(
          "div",
          { class: "sub" },
          `${c.messages} msg${c.messages === 1 ? "" : "s"} · ~${fmtNum(Math.round(c.tokens / c.messages))}/msg`,
          deltas ? ` · ${deltas}` : "",
          c.lastContext > LONG_CONTEXT ? el("span", { class: "long", title: "Every new message re-sends this much history. Starting a fresh chat is cheaper." , text: ` · long chat (${fmtNum(c.lastContext)} ctx)` }) : ""
        )
      );
    })
  );
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
        if (!v) continue;
        const a = Math.abs(v);
        const grade = a >= 6 ? "critical" : a >= 3 ? "warn" : a >= 1 ? "caution" : "ok";
        tags.push(el("span", { class: `tag delta lvl-${grade}`, title: "Change in limit usage across this query", text: `${v > 0 ? "+" : ""}${v}% ${labels[k] || k}` }));
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
  const stored = await chrome.storage.local.get([
    "latestUsage",
    "usageHistory",
    "usageError",
    "queries",
    "diag",
    "prefs",
  ]);
  prefs = UsageShared.mergePrefs(stored.prefs);
  for (const b of document.querySelectorAll("#view-toggle button")) b.setAttribute("aria-pressed", String(b.dataset.view === prefs.view));
  const { latestUsage, usageHistory = [], usageError, queries = [], diag = {} } = stored;
  renderLimits(latestUsage, usageHistory, usageError);
  renderStatus(diag, usageError, latestUsage);
  renderStats(queries);
  renderTopChats(queries);
  renderQueries(queries, latestUsage);
}

let tabState = { checked: false };

let refreshMsg = null; // { kind: "loading"|"ok"|"error", text } shown next to the refresh button
let refreshTimer = null;
let lastLatestTs = null;

function showRefreshMsg(kind, text, holdMs) {
  refreshMsg = { kind, text };
  clearTimeout(refreshTimer);
  paintUpdated();
  if (holdMs) refreshTimer = setTimeout(() => ((refreshMsg = null), paintUpdated()), holdMs);
}

function paintUpdated() {
  const u = $("updated");
  if (refreshMsg) {
    u.textContent = refreshMsg.text;
    u.className = `refresh-msg ${refreshMsg.kind}`;
  } else {
    u.textContent = lastLatestTs ? `Updated ${fmtAgo(lastLatestTs)}` : "";
    u.className = "muted";
  }
}

async function refresh() {
  const btn = $("refresh");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("spin");
  btn.setAttribute("aria-busy", "true");
  showRefreshMsg("loading", "Refreshing…");
  const started = Date.now();
  let outcome;
  try {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    if (!tabs.length) {
      tabState = { checked: true, found: false };
      outcome = ["error", "Open chatgpt.com first"];
    } else {
      const tab = tabs.find((t) => t.active) || tabs[0];
      const ping = await chrome.tabs.sendMessage(tab.id, { type: "ping" }).catch(() => null);
      tabState = { checked: true, found: true, attached: !!ping, interceptor: ping && ping.interceptor, authed: ping && ping.authed };
      if (!ping) {
        outcome = ["error", "Reload your chatgpt.com tab"];
      } else {
        const res = await chrome.tabs.sendMessage(tab.id, { type: "refresh-usage" }).catch((e) => ({ ok: false, status: 0, error: String(e) }));
        if (res && res.ok) outcome = ["ok", res.windows ? "Updated ✓" : "Updated, but no limits found"];
        else outcome = ["error", res && res.status ? `Failed (HTTP ${res.status})` : "Failed (network)"];
      }
    }
  } catch (e) {
    outcome = ["error", "Failed"];
  }
  // Keep the spinner up long enough to be noticed.
  await new Promise((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - started))));
  await render();
  btn.classList.remove("spin");
  btn.disabled = false;
  btn.removeAttribute("aria-busy");
  btn.classList.add(outcome[0] === "ok" ? "flash-ok" : "flash-err");
  setTimeout(() => btn.classList.remove("flash-ok", "flash-err"), 900);
  showRefreshMsg(outcome[0], outcome[1], outcome[0] === "ok" ? 2500 : 6000);
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
const openDashboard = (hash = "") => chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard/dashboard.html${hash}`) });
$("open-dashboard").addEventListener("click", () => openDashboard());
$("all-chats").addEventListener("click", (e) => (e.preventDefault(), openDashboard("#chats")));
$("open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
for (const b of document.querySelectorAll("#view-toggle button")) b.addEventListener("click", () => setView(b.dataset.view));
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

setInterval(paintUpdated, 15000);
$("version").textContent = `v${chrome.runtime.getManifest().version}`;
render().then(refresh);
