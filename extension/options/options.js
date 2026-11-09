const $ = (id) => document.getElementById(id);
let prefs;

async function save(patch) {
  prefs = UsageShared.mergePrefs({ ...prefs, ...patch });
  await chrome.storage.local.set({ prefs });
  const s = $("saved");
  s.textContent = "Saved ✓";
  s.style.opacity = 1;
  clearTimeout(save.t);
  save.t = setTimeout(() => (s.style.opacity = 0), 1200);
}

function renderScale(t) {
  // Bar from 0% left (left edge) to 100% left (right edge).
  const seg = (cls, from, to) => {
    const s = document.createElement("span");
    s.style.flexBasis = `${Math.max(0, to - from)}%`;
    s.style.background = `var(--${cls})`;
    return s;
  };
  $("scale").replaceChildren(seg("critical", 0, t.critical), seg("warn", t.critical, t.warn), seg("caution", t.warn, t.caution), seg("ok", t.caution, 100));
}

function render(latestUsage) {
  for (const b of $("view").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === prefs.view));
  $("t-caution").value = prefs.thresholds.caution;
  $("t-warn").value = prefs.thresholds.warn;
  $("t-critical").value = prefs.thresholds.critical;
  renderScale(prefs.thresholds);
  $("poll").value = String(prefs.pollMinutes);
  $("pill-enabled").checked = prefs.pill.enabled;
  $("pill-position").value = prefs.pill.position;
  const opts = [["tightest", "Closest to running out"], ["first", "Shortest window (e.g. 5-hour)"]];
  for (const w of (latestUsage && latestUsage.windows) || []) opts.push([w.key, `${w.label} limit`]);
  $("pill-window").replaceChildren(
    ...opts.map(([v, t]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t;
      return o;
    })
  );
  $("pill-window").value = prefs.pill.window;
  $("pill-position").disabled = $("pill-window").disabled = !prefs.pill.enabled;
}

function readThresholds() {
  const t = { caution: Number($("t-caution").value), warn: Number($("t-warn").value), critical: Number($("t-critical").value) };
  const ok = Object.values(t).every((v) => v >= 1 && v <= 99) && t.critical < t.warn && t.warn < t.caution;
  $("t-error").hidden = ok;
  renderScale(ok ? t : prefs.thresholds);
  return ok ? t : null;
}

(async () => {
  prefs = await UsageShared.loadPrefs();
  const { latestUsage } = await chrome.storage.local.get("latestUsage");
  render(latestUsage);

  $("view").addEventListener("click", (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (v) save({ view: v }).then(() => render(latestUsage));
  });
  for (const id of ["t-caution", "t-warn", "t-critical"]) {
    $(id).addEventListener("input", () => {
      const t = readThresholds();
      if (t) save({ thresholds: t });
    });
  }
  $("poll").addEventListener("change", (e) => save({ pollMinutes: Number(e.target.value) }));
  $("pill-enabled").addEventListener("change", (e) => save({ pill: { ...prefs.pill, enabled: e.target.checked } }).then(() => render(latestUsage)));
  $("pill-position").addEventListener("change", (e) => save({ pill: { ...prefs.pill, position: e.target.value, offset: null } }));
  $("pill-window").addEventListener("change", (e) => save({ pill: { ...prefs.pill, window: e.target.value } }));
  $("reset").addEventListener("click", async () => {
    prefs = UsageShared.mergePrefs();
    await chrome.storage.local.set({ prefs });
    render(latestUsage);
    $("t-error").hidden = true;
    save({});
  });
})();
