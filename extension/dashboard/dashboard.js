const { fmtNum, fmtTime, aggregateConversations } = UsageShared;
const $ = (id) => document.getElementById(id);
const DAY = 24 * 3600 * 1000;
const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];
const LONG_CONTEXT = 20000;

const state = { metric: "tokens", group: "day", limitKey: null, sort: { k: "tokens", dir: -1 }, filter: "" };
let data = { queries: [], usageHistory: [], latestUsage: null };

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== "") n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
const svgEl = (tag, attrs) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

// ---------- time buckets ----------
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function startOfWeek(ts) {
  const d = new Date(startOfDay(ts));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d.getTime();
}
function buckets(rangeStart, group) {
  const start = group === "week" ? startOfWeek(rangeStart) : startOfDay(rangeStart);
  const out = [];
  for (let t = start; t <= Date.now(); ) {
    const d = new Date(t);
    group === "week" ? d.setDate(d.getDate() + 7) : d.setDate(d.getDate() + 1);
    out.push({ t0: t, t1: d.getTime() });
    t = d.getTime();
  }
  return out;
}
const bucketLabel = (b, group) =>
  group === "week"
    ? `Wk of ${new Date(b.t0).toLocaleDateString([], { month: "short", day: "numeric" })}`
    : new Date(b.t0).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

function rangeStart() {
  const days = Number($("range").value);
  if (days) return Date.now() - days * DAY;
  const first = Math.min(...data.queries.map((q) => q.ts), ...data.usageHistory.map((h) => h.ts), Date.now());
  return first;
}

// ---------- series ----------
function buildSeries(bs) {
  const idx = (ts) => {
    for (let i = bs.length - 1; i >= 0; i--) if (ts >= bs[i].t0) return ts < bs[i].t1 ? i : -1;
    return -1;
  };
  if (state.metric === "tokens") {
    const names = ["Prompt + context", "Reply + reasoning"];
    const vals = bs.map(() => [0, 0]);
    for (const q of data.queries) {
      const i = idx(q.ts);
      if (i < 0) continue;
      const t = q.tokens || {};
      vals[i][0] += t.inputEst || 0;
      vals[i][1] += t.outputEst || 0;
    }
    return { names, vals, unit: "tokens", fmt: fmtNum };
  }
  if (state.metric === "messages") {
    const counts = {};
    for (const q of data.queries) if (idx(q.ts) >= 0) counts[q.model || "unknown"] = (counts[q.model || "unknown"] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([m]) => m);
    const names = top.slice(0, 4).concat(top.length > 4 ? ["other"] : []);
    const vals = bs.map(() => names.map(() => 0));
    for (const q of data.queries) {
      const i = idx(q.ts);
      if (i < 0) continue;
      let j = names.indexOf(q.model || "unknown");
      if (j < 0) j = names.length - 1;
      vals[i][j]++;
    }
    return { names, vals, unit: "messages", fmt: (n) => String(n) };
  }
  // limit: sum of increases in used% from the usage history (includes Codex work this extension didn't see as a query)
  const key = state.limitKey;
  const vals = bs.map(() => [0]);
  let prev = null;
  for (const h of data.usageHistory) {
    const w = h.windows.find((x) => x.key === key);
    if (!w) continue;
    if (prev !== null && w.usedPercent > prev) {
      const i = idx(h.ts);
      if (i >= 0) vals[i][0] += w.usedPercent - prev;
    }
    prev = w.usedPercent;
  }
  for (const v of vals) v[0] = Math.round(v[0] * 10) / 10;
  return { names: [`${key} limit used`], vals, unit: "%", fmt: (n) => `${n}%` };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function renderChart() {
  const svg = $("chart");
  const W = Math.max(320, svg.clientWidth || 900);
  const H = 260;
  const pad = { l: 46, r: 8, t: 10, b: 26 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
  svg.replaceChildren();

  const bs = buckets(rangeStart(), state.group);
  const { names, vals, unit, fmt } = buildSeries(bs);
  const totals = vals.map((v) => v.reduce((a, b) => a + b, 0));
  const max = niceMax(Math.max(0, ...totals));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const bw = iw / Math.max(1, bs.length);
  const y = (v) => pad.t + ih - (v / max) * ih;

  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    svg.append(svgEl("line", { class: "grid", x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    const t = svgEl("text", { class: "axis", x: pad.l - 6, y: y(v) + 4, "text-anchor": "end" });
    t.textContent = unit === "%" ? `${Math.round(v)}%` : fmtNum(Math.round(v));
    svg.append(t);
  }
  const labelEvery = Math.ceil(bs.length / Math.max(1, Math.floor(iw / 70)));
  bs.forEach((b, i) => {
    let acc = 0;
    const x = pad.l + i * bw + Math.min(2, bw * 0.15);
    const w = Math.max(1, bw - Math.min(4, bw * 0.3));
    vals[i].forEach((v, j) => {
      if (!v) return;
      const h = (v / max) * ih;
      svg.append(svgEl("rect", { class: "bar", x, y: y(acc + v), width: w, height: Math.max(0.5, h), fill: SERIES[j % SERIES.length], rx: Math.min(2, w / 4) }));
      acc += v;
    });
    if (i % labelEvery === 0) {
      const t = svgEl("text", { class: "axis", x: pad.l + i * bw + bw / 2, y: H - 8, "text-anchor": "middle" });
      t.textContent = state.group === "week"
        ? new Date(b.t0).toLocaleDateString([], { month: "short", day: "numeric" })
        : new Date(b.t0).toLocaleDateString([], bs.length > 14 ? { month: "numeric", day: "numeric" } : { weekday: "short", day: "numeric" });
      svg.append(t);
    }
    const hit = svgEl("rect", { class: "hit", x: pad.l + i * bw, y: pad.t, width: bw, height: ih });
    hit.addEventListener("mouseenter", () => showReadout(i, b, names, vals[i], totals[i], fmt, (pad.l + i * bw + bw / 2) / W));
    hit.addEventListener("mouseleave", () => ($("readout").hidden = true));
    svg.append(hit);
  });

  $("legend").replaceChildren(...names.map((n, j) => el("span", {}, el("i", { style: `background:${SERIES[j % SERIES.length]}` }), n)));

  const sum = totals.reduce((a, b) => a + b, 0);
  const active = totals.filter((t) => t > 0).length;
  const peak = Math.max(0, ...totals);
  $("summary").replaceChildren(
    el("div", {}, el("b", { text: fmt(Math.round(sum * 10) / 10) }), el("span", { text: `total ${unit}` })),
    el("div", {}, el("b", { text: fmt(active ? Math.round((sum / active) * 10) / 10 : 0) }), el("span", { text: `avg per active ${state.group}` })),
    el("div", {}, el("b", { text: fmt(Math.round(peak * 10) / 10) }), el("span", { text: `busiest ${state.group}` }))
  );
  $("chart-hint").textContent =
    state.metric === "limit"
      ? "Sum of every increase in this limit's used %, from snapshots taken while chatgpt.com was open. Includes Codex work."
      : state.metric === "tokens"
        ? "Estimated with the o200k tokenizer on visible text. Hidden system prompts and hidden reasoning aren't included."
        : "";
}

function showReadout(i, b, names, v, total, fmt, xFrac) {
  const r = $("readout");
  r.replaceChildren(
    el("b", { text: bucketLabel(b, state.group) }),
    ...names.map((n, j) => el("div", {}, el("i", { style: `background:${SERIES[j % SERIES.length]}` }), `${n}: ${fmt(Math.round(v[j] * 10) / 10)}`)),
    ...(names.length > 1 ? [el("div", { class: "muted", text: `Total: ${fmt(Math.round(total * 10) / 10)}` })] : [])
  );
  r.hidden = false;
  const wrap = r.parentElement.clientWidth;
  const left = Math.min(Math.max(0, xFrac * wrap - r.offsetWidth / 2), wrap - r.offsetWidth);
  r.style.left = `${left}px`;
}

// ---------- conversations ----------
function renderChats() {
  const tbody = $("chat-table").querySelector("tbody");
  const f = state.filter.toLowerCase();
  let chats = aggregateConversations(data.queries, rangeStart()).map((c) => ({
    ...c,
    perMsg: c.tokens / c.messages,
    limit: Object.values(c.delta).reduce((a, b) => a + b, 0),
    modelStr: Object.entries(c.models).sort((a, b) => b[1] - a[1]).map(([m]) => m).join(", "),
  }));
  if (f) chats = chats.filter((c) => (c.title || "").toLowerCase().includes(f) || c.modelStr.toLowerCase().includes(f));
  const { k, dir } = state.sort;
  const keyOf = (c) => (k === "title" ? (c.title || "").toLowerCase() : k === "models" ? c.modelStr : c[k]);
  chats.sort((a, b) => (keyOf(a) > keyOf(b) ? dir : keyOf(a) < keyOf(b) ? -dir : 0));
  for (const th of $("chat-table").querySelectorAll("th")) th.setAttribute("aria-sort", th.dataset.k === k ? (dir < 0 ? "descending" : "ascending") : "none");

  if (!chats.length) {
    tbody.replaceChildren(el("tr", { class: "empty" }, el("td", { colspan: 8, text: "No conversations in this range." })));
    return;
  }
  const maxTok = Math.max(...chats.map((c) => c.tokens), 1);
  tbody.replaceChildren(
    ...chats.map((c) =>
      el(
        "tr",
        {},
        el("td", { class: "title" }, el("a", { href: `https://chatgpt.com/c/${c.conversationId}`, target: "_blank", title: c.title || "", text: c.title || "Untitled chat" })),
        el("td", { class: "num", text: c.messages }),
        el("td", { class: "num" }, el("span", { class: "bar-cell", style: `width:${Math.max(2, (c.tokens / maxTok) * 60)}px` }), fmtNum(c.tokens)),
        el("td", { class: "num", text: fmtNum(Math.round(c.perMsg)) }),
        el("td", { class: `num ${c.lastContext > LONG_CONTEXT ? "long" : ""}`, title: c.lastContext > LONG_CONTEXT ? "Long chat: a fresh chat would be cheaper per message" : "", text: fmtNum(c.lastContext) }),
        el("td", { class: "num", text: Object.entries(c.delta).map(([kk, v]) => `+${v}% ${kk}`).join(" · ") || "—" }),
        el("td", { class: "muted", text: c.modelStr }),
        el("td", { class: "num muted", text: fmtTime(c.lastTs) })
      )
    )
  );
}

// ---------- models ----------
function renderModels() {
  const since = rangeStart();
  const by = {};
  let all = 0;
  for (const q of data.queries) {
    if (q.ts < since) continue;
    const m = q.model || "unknown";
    const t = q.tokens || {};
    const s = (by[m] ||= { n: 0, tok: 0, inp: 0, out: 0, think: 0, thinkN: 0, delta: {}, deltaN: 0 });
    s.n++;
    s.tok += t.totalEst || 0;
    s.inp += t.inputEst || 0;
    s.out += t.output || 0;
    if (q.reasoningSec) (s.think += q.reasoningSec), s.thinkN++;
    if (q.usageDelta) {
      s.deltaN++;
      for (const [k, v] of Object.entries(q.usageDelta)) s.delta[k] = (s.delta[k] || 0) + v;
    }
    all += t.totalEst || 0;
  }
  const rows = Object.entries(by).sort((a, b) => b[1].tok - a[1].tok);
  const tbody = $("model-table").querySelector("tbody");
  if (!rows.length) {
    tbody.replaceChildren(el("tr", { class: "empty" }, el("td", { colspan: 7, text: "No queries in this range." })));
    return;
  }
  tbody.replaceChildren(
    ...rows.map(([m, s]) =>
      el(
        "tr",
        {},
        el("td", { text: m }),
        el("td", { class: "num", text: s.n }),
        el("td", { class: "num", text: all ? `${Math.round((s.tok / all) * 100)}%` : "—" }),
        el("td", { class: "num", text: fmtNum(Math.round(s.inp / s.n)) }),
        el("td", { class: "num", text: fmtNum(Math.round(s.out / s.n)) }),
        el("td", { class: "num", text: s.thinkN ? `${Math.round(s.think / s.thinkN)}s` : "—" }),
        el("td", { class: "num", text: (s.deltaN && Object.entries(s.delta).filter(([, v]) => v / s.deltaN >= 0.005).map(([k, v]) => `${(v / s.deltaN).toFixed(2)}% ${k}`).join(" · ")) || "—" })
      )
    )
  );
}

// ---------- wiring ----------
function setSeg(id, v) {
  for (const b of $(id).querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === v));
}

function renderAll() {
  const keys = (data.latestUsage && data.latestUsage.windows.map((w) => w.key)) || [];
  const histKeys = new Set(data.usageHistory.flatMap((h) => h.windows.map((w) => w.key)));
  const allKeys = [...new Set([...keys, ...histKeys])];
  if (!state.limitKey || !allKeys.includes(state.limitKey)) state.limitKey = allKeys[0] || null;
  const sel = $("limit-key");
  sel.replaceChildren(...allKeys.map((k) => el("option", { value: k, text: k, selected: k === state.limitKey ? "" : null })));
  sel.hidden = state.metric !== "limit" || allKeys.length < 2;
  if (state.metric === "limit" && !state.limitKey) state.metric = "tokens";
  setSeg("metric", state.metric);
  setSeg("group", state.group);
  renderChart();
  renderChats();
  renderModels();
}

async function load() {
  const s = await chrome.storage.local.get(["queries", "usageHistory", "latestUsage"]);
  data = { queries: s.queries || [], usageHistory: s.usageHistory || [], latestUsage: s.latestUsage || null };
  renderAll();
}

$("metric").addEventListener("click", (e) => {
  const v = e.target.dataset && e.target.dataset.v;
  if (v) (state.metric = v), renderAll();
});
$("group").addEventListener("click", (e) => {
  const v = e.target.dataset && e.target.dataset.v;
  if (v) (state.group = v), renderAll();
});
$("limit-key").addEventListener("change", (e) => ((state.limitKey = e.target.value), renderChart()));
$("range").addEventListener("change", renderAll);
$("chat-search").addEventListener("input", (e) => ((state.filter = e.target.value), renderChats()));
for (const th of $("chat-table").querySelectorAll("th")) {
  th.addEventListener("click", () => {
    const k = th.dataset.k;
    state.sort = state.sort.k === k ? { k, dir: -state.sort.dir } : { k, dir: k === "title" || k === "models" ? 1 : -1 };
    renderChats();
  });
}
$("settings").addEventListener("click", (e) => (e.preventDefault(), UsageShared.openSettings()));
let rt;
window.addEventListener("resize", () => (clearTimeout(rt), (rt = setTimeout(renderChart, 100))));
chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && (c.queries || c.usageHistory || c.latestUsage)) load();
});

load().then(() => {
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
});
