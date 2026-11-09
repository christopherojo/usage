// Small floating usage pill on chatgpt.com (isolated content script).
// Reads everything from chrome.storage.local; never talks to ChatGPT itself.
(() => {
  if (window.__usagePill) return;
  window.__usagePill = true;
  const { mergePrefs, levelFor, pickWindow, fmtDur, fmtTime } = UsageShared;

  let prefs = mergePrefs();
  let latest = null;
  let history = [];
  let expanded = false;
  let dismissed = false;
  let host, root, pill, panel;

  const CSS = `
    :host { all: initial; }
    .wrap { position: fixed; z-index: 2147483000; font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --bg: #ffffff; --text: #16181d; --muted: #6b7280; --border: rgba(0,0,0,.12); --track: #e8eaed;
      --ok: #188038; --caution: #b58100; --warn: #e37400; --critical: #d93025; color: var(--text); }
    @media (prefers-color-scheme: dark) {
      .wrap { --bg: #2a2b2f; --text: #ececf1; --muted: #a0a4ab; --border: rgba(255,255,255,.12); --track: #3a3c41;
        --ok: #34c77b; --caution: #fdd663; --warn: #f6a24b; --critical: #f28b82; }
    }
    .lvl-ok { --lvl: var(--ok); } .lvl-caution { --lvl: var(--caution); } .lvl-warn { --lvl: var(--warn); } .lvl-critical { --lvl: var(--critical); }
    .pill { display: flex; align-items: center; gap: 6px; padding: 5px 10px 5px 8px; border-radius: 999px; background: var(--bg);
      border: 1px solid var(--border); box-shadow: 0 2px 10px rgba(0,0,0,.12); cursor: grab; user-select: none; white-space: nowrap; }
    .pill:active { cursor: grabbing; }
    .pill.lvl-warn, .pill.lvl-critical { border-color: var(--lvl); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--lvl); flex: none; }
    .pill.lvl-critical .dot { animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--lvl) 30%, transparent); } }
    .pct { font-weight: 650; font-variant-numeric: tabular-nums; }
    .sub { color: var(--muted); }
    .sub.hot { color: var(--lvl); }
    .x { margin-left: 2px; border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px; }
    .x:hover { color: var(--text); }
    .panel { position: absolute; width: 260px; padding: 10px 12px; background: var(--bg); border: 1px solid var(--border);
      border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.18); }
    .panel.up { bottom: calc(100% + 8px); } .panel.down { top: calc(100% + 8px); }
    .panel.right { right: 0; } .panel.left { left: 0; }
    .win { margin-bottom: 10px; } .win:last-of-type { margin-bottom: 6px; }
    .row { display: flex; justify-content: space-between; align-items: baseline; }
    .name { font-weight: 600; } .big { font-weight: 650; color: var(--lvl); font-variant-numeric: tabular-nums; }
    .bar { position: relative; height: 6px; background: var(--track); border-radius: 3px; margin: 4px 0 3px; }
    .bar > span { display: block; height: 100%; border-radius: 3px; background: var(--lvl); }
    .bar > i { position: absolute; top: -2px; width: 2px; height: 10px; margin-left: -1px; background: var(--text); opacity: .4; }
    .meta { color: var(--muted); font-size: 11px; }
    .fc { font-size: 11px; margin-top: 2px; } .fc.hot { color: var(--lvl); }
    .foot { display: flex; justify-content: space-between; border-top: 1px solid var(--border); padding-top: 6px; margin-top: 4px; }
    .foot button { border: 0; background: none; color: var(--muted); cursor: pointer; font: inherit; font-size: 11px; padding: 0; }
    .foot button:hover { color: var(--text); text-decoration: underline; }
  `;

  function h(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== "") n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }

  function mount() {
    if (host && host.isConnected) return;
    host = document.createElement("chatgpt-usage-pill");
    root = host.attachShadow({ mode: "closed" });
    root.append(h("style", { text: CSS }));
    document.documentElement.append(host);
  }

  function place(wrap) {
    const pos = prefs.pill.position;
    const off = prefs.pill.offset || { x: 16, y: pos.startsWith("bottom") ? 88 : 64 };
    wrap.style[pos.endsWith("right") ? "right" : "left"] = `${off.x}px`;
    wrap.style[pos.startsWith("bottom") ? "bottom" : "top"] = `${off.y}px`;
  }

  function enableDrag(wrap, handle) {
    let start = null;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".x")) return;
      const r = wrap.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, r, moved: false };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 4) return;
      start.moved = true;
      const pos = prefs.pill.position;
      const x = pos.endsWith("right") ? innerWidth - start.r.right - dx : start.r.left + dx;
      const y = pos.startsWith("bottom") ? innerHeight - start.r.bottom - dy : start.r.top + dy;
      start.off = { x: Math.max(0, Math.min(innerWidth - 60, x)), y: Math.max(0, Math.min(innerHeight - 30, y)) };
      wrap.style[pos.endsWith("right") ? "right" : "left"] = `${start.off.x}px`;
      wrap.style[pos.startsWith("bottom") ? "bottom" : "top"] = `${start.off.y}px`;
    });
    handle.addEventListener("pointerup", () => {
      if (!start) return;
      if (start.moved && start.off) {
        prefs.pill.offset = start.off;
        chrome.storage.local.set({ prefs }).catch(() => {});
      } else {
        expanded = !expanded;
        render();
      }
      start = null;
    });
  }

  function windowView(w) {
    const showLeft = prefs.view === "left";
    const used = Math.min(100, Math.max(0, w.usedPercent));
    const left = Math.round((100 - used) * 10) / 10;
    const lvl = levelFor(left, prefs.thresholds);
    const f = UsageForecast.forecastWindow(w, history, Date.now(), latest.ts);
    let fc = null, hot = false;
    if (f.status === "maxed") (fc = "Limit reached"), (hot = true);
    else if (f.status === "runout") (fc = `Runs out ~${fmtTime(f.runOutAt)} at this pace`), (hot = true);
    else if (f.status === "on-track") fc = `On pace for ~${Math.round(showLeft ? 100 - f.projectedAtReset : f.projectedAtReset)}% ${showLeft ? "left" : "used"} at reset`;
    else if (f.status === "idle") fc = "No recent usage";
    return { w, used, left, lvl, shown: showLeft ? left : used, unit: showLeft ? "left" : "used", f, fc, hot };
  }

  function render() {
    if (!prefs.pill.enabled || dismissed || !latest || !latest.windows || !latest.windows.length) {
      if (host) host.remove();
      return;
    }
    mount();
    for (const n of [...root.childNodes]) if (n.tagName !== "STYLE") n.remove();

    const views = latest.windows.map(windowView);
    const main = windowView(pickWindow(latest.windows, prefs.pill.window));
    const wrap = h("div", { class: "wrap" });
    place(wrap);

    pill = h(
      "div",
      { class: `pill lvl-${main.lvl}`, title: "ChatGPT usage: click for details, drag to move" },
      h("span", { class: "dot" }),
      h("span", { class: "name", text: main.w.label }),
      h("span", { class: "pct", text: `${main.shown}% ${main.unit}` }),
      main.hot ? h("span", { class: "sub hot", text: main.f.status === "maxed" ? `· back in ${fmtDur(main.w.resetAt - Date.now())}` : `· out ~${fmtTime(main.f.runOutAt)}` }) : null,
      h("button", { class: "x", title: "Hide until reload", text: "×", onclick: (e) => (e.stopPropagation(), (dismissed = true), render()) })
    );
    enableDrag(wrap, pill);
    wrap.append(pill);

    if (expanded) {
      const pos = prefs.pill.position;
      panel = h(
        "div",
        { class: `panel ${pos.startsWith("bottom") ? "up" : "down"} ${pos.endsWith("right") ? "right" : "left"}` },
        views.map((v) =>
          h(
            "div",
            { class: `win lvl-${v.lvl}` },
            h("div", { class: "row" }, h("span", { class: "name", text: `${v.w.label} limit` }), h("span", { class: "big", text: `${v.shown}% ${v.unit}` })),
            h("div", { class: "bar" }, h("span", { style: `width:${v.shown}%` }), v.f.evenPaceUsed != null ? h("i", { style: `left:${prefs.view === "left" ? 100 - v.f.evenPaceUsed : v.f.evenPaceUsed}%`, title: "Even pace" }) : null),
            h("div", { class: "meta", text: v.w.resetAt ? `Resets in ${fmtDur(v.w.resetAt - Date.now())} · ${fmtTime(v.w.resetAt)}` : "" }),
            v.fc ? h("div", { class: `fc ${v.hot ? "hot" : ""}`, text: v.fc }) : null
          )
        ),
        h(
          "div",
          { class: "foot" },
          h("button", { text: "Open dashboard", onclick: () => chrome.runtime.sendMessage({ type: "open-dashboard" }).catch(() => {}) }),
          h("button", { text: "Settings", onclick: () => chrome.runtime.sendMessage({ type: "open-settings" }).catch(() => {}) })
        )
      );
      wrap.append(panel);
    }
    root.append(wrap);
  }

  async function load() {
    try {
      const s = await chrome.storage.local.get(["prefs", "latestUsage", "usageHistory"]);
      prefs = mergePrefs(s.prefs);
      latest = s.latestUsage || null;
      history = s.usageHistory || [];
      render();
    } catch (_) {}
  }

  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && (c.prefs || c.latestUsage || c.usageHistory)) load();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && expanded && ((expanded = false), render()));
  document.addEventListener("pointerdown", (e) => {
    if (expanded && host && !e.composedPath().includes(host)) (expanded = false), render();
  });
  // Keep countdowns fresh and survive the page re-rendering <html>.
  setInterval(() => {
    if (prefs.pill.enabled && !dismissed && latest) render();
  }, 30000);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load, { once: true });
  else load();
})();
