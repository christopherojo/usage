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

function windowChoices(latestUsage) {
  const wins = (latestUsage && latestUsage.windows) || [];
  const keys = wins.length ? wins.map((w) => [w.key, w.label]) : [["5-hour", "5-hour"], ["Weekly", "Weekly"]];
  return [["tightest", "Closest to running out"], ...keys];
}

function render(latestUsage) {
  $("badge-window").replaceChildren(
    ...windowChoices(latestUsage).map(([v, t]) => {
      const b = document.createElement("button");
      b.dataset.v = v;
      b.textContent = t;
      b.setAttribute("aria-pressed", String(prefs.badgeWindow === v));
      return b;
    })
  );
  for (const b of $("view").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === prefs.view));
  $("t-caution").value = prefs.thresholds.caution;
  $("t-warn").value = prefs.thresholds.warn;
  $("t-critical").value = prefs.thresholds.critical;
  renderScale(prefs.thresholds);
  $("poll").value = String(prefs.pollMinutes);
  $("pill-enabled").checked = prefs.pill.enabled;
  $("pill-position").value = prefs.pill.position;
  // Pill: one limit, the other, the closest-to-empty one, or all of them.
  const wins = (latestUsage && latestUsage.windows) || [];
  const pillSel = prefs.pill.window === "first" ? (wins[0] && wins[0].key) || "5-hour" : prefs.pill.window;
  $("pill-window").replaceChildren(
    ...windowChoices(latestUsage).concat([["all", "Both"]]).map(([v, t]) => {
      const b = document.createElement("button");
      b.dataset.v = v;
      b.textContent = t;
      b.disabled = !prefs.pill.enabled;
      b.setAttribute("aria-pressed", String(pillSel === v));
      return b;
    })
  );
  $("pill-position").disabled = !prefs.pill.enabled;
}

function readThresholds(showError) {
  const t = { caution: Number($("t-caution").value), warn: Number($("t-warn").value), critical: Number($("t-critical").value) };
  const ok = Object.values(t).every((v) => Number.isFinite(v) && v >= 1 && v <= 99) && t.critical < t.warn && t.warn < t.caution;
  if (ok || showError) $("t-error").hidden = ok;
  renderScale(ok ? t : prefs.thresholds);
  return ok ? t : null;
}

(async () => {
  $("version").textContent = `v${chrome.runtime.getManifest().version}`;
  prefs = await UsageShared.loadPrefs();
  const { latestUsage } = await chrome.storage.local.get("latestUsage");
  render(latestUsage);

  $("view").addEventListener("click", (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (v) save({ view: v }).then(() => render(latestUsage));
  });
  for (const id of ["t-caution", "t-warn", "t-critical"]) {
    // Save as soon as the numbers are valid; only complain once you leave the field.
    $(id).addEventListener("input", () => {
      const t = readThresholds(false);
      if (t) save({ thresholds: t });
    });
    $(id).addEventListener("change", () => readThresholds(true));
  }
  $("badge-window").addEventListener("click", (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (v) save({ badgeWindow: v }).then(() => render(latestUsage));
  });
  $("poll").addEventListener("change", (e) => save({ pollMinutes: Number(e.target.value) }));
  $("pill-enabled").addEventListener("change", (e) => save({ pill: { ...prefs.pill, enabled: e.target.checked } }).then(() => render(latestUsage)));
  $("pill-position").addEventListener("change", (e) => save({ pill: { ...prefs.pill, position: e.target.value, offset: null } }));
  $("pill-window").addEventListener("click", (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (v && !e.target.disabled) save({ pill: { ...prefs.pill, window: v } }).then(() => render(latestUsage));
  });
  $("reset").addEventListener("click", async () => {
    prefs = UsageShared.mergePrefs();
    await chrome.storage.local.set({ prefs });
    render(latestUsage);
    $("t-error").hidden = true;
    save({});
  });
})();
