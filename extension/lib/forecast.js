// Burn-rate forecast for a single rate-limit window.
// Pure functions; loaded by popup.html and unit-testable in Node.
(function (root) {
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  /**
   * @param {object} w        current window { key, usedPercent, windowSeconds, resetAt }
   * @param {Array}  history  [{ ts, windows: [{ key, usedPercent }] }] oldest first
   * @param {number} now      ms timestamp
   * @param {number} latestTs timestamp of the snapshot `w` came from
   * @returns {{
   *   ratePerHour: number|null,   // % of the limit used per hour at the chosen pace
   *   basis: "recent"|"blend"|"window"|null,
   *   lookbackMs: number|null,
   *   runOutAt: number|null,      // ms timestamp when you'd hit 100%, if before reset
   *   projectedAtReset: number|null,
   *   evenPaceUsed: number|null,  // % you'd have used by now spending evenly across the window
   *   windowStart: number|null,
   *   status: "runout"|"on-track"|"idle"|"unknown"|"maxed"
   * }}
   */
  function forecastWindow(w, history, now = Date.now(), latestTs = now) {
    const used = clamp(w.usedPercent);
    const spanMs = w.windowSeconds ? w.windowSeconds * 1000 : null;
    const resetAt = w.resetAt || null;
    const windowStart = resetAt && spanMs ? resetAt - spanMs : null;
    const evenPaceUsed =
      windowStart && now > windowStart ? clamp(((now - windowStart) / spanMs) * 100) : null;

    const base = { ratePerHour: null, basis: null, lookbackMs: null, runOutAt: null, projectedAtReset: null, evenPaceUsed, windowStart };
    if (used >= 100) return { ...base, status: "maxed" };

    // Series for this window, plus the live value, trimmed to after the most recent reset.
    let pts = history
      .map((h) => {
        const hw = h.windows.find((x) => x.key === w.key);
        return hw ? { ts: h.ts, v: clamp(hw.usedPercent) } : null;
      })
      .filter(Boolean);
    if (!pts.length || pts[pts.length - 1].ts < latestTs) pts.push({ ts: latestTs, v: used });
    let cut = 0;
    for (let i = 1; i < pts.length; i++) if (pts[i].v < pts[i - 1].v - 0.5) cut = i; // value dropped => a reset
    pts = pts.slice(cut);
    if (windowStart) pts = pts.filter((p) => p.ts >= windowStart - 5 * MIN);
    if (!pts.length) pts = [{ ts: latestTs, v: used }];

    // Recent pace: look back ~20% of the window (1h for 5-hour, ~1.4 days for weekly).
    const lookback = spanMs ? Math.max(30 * MIN, spanMs * 0.2) : HOUR;
    const from = now - lookback;
    let startPt = null;
    for (const p of pts) {
      if (p.ts <= from) startPt = p; // last point at/before the lookback start (step function)
      else break;
    }
    if (!startPt) startPt = pts[0];
    const end = pts[pts.length - 1];
    const effFrom = Math.max(startPt.ts, from);
    const dt = now - effFrom;

    let rate = null;
    let basis = null;
    const windowRate =
      windowStart && now - windowStart >= 10 * MIN ? (used / (now - windowStart)) * HOUR : null;
    if (dt >= 15 * MIN) {
      rate = ((end.v - startPt.v) / dt) * HOUR;
      basis = "recent";
      // Only part of the lookback has data (e.g. just installed, or weekly window): blend toward the
      // window-so-far average so one busy session doesn't get projected across nights and weekends.
      const needed = windowStart ? Math.min(lookback, Math.max(1, now - windowStart)) : lookback;
      const coverage = Math.min(1, dt / needed);
      if (coverage < 0.98 && windowRate !== null) {
        rate = coverage * rate + (1 - coverage) * windowRate;
        basis = "blend";
      }
    }
    // Fallback: average over the window so far (works on first install, before history builds up).
    if (rate === null && windowRate !== null) {
      rate = windowRate;
      basis = "window";
    }

    if (rate === null) return { ...base, status: "unknown" };
    rate = Math.max(0, rate);
    const out = { ...base, ratePerHour: round(rate, 2), basis, lookbackMs: basis === "window" ? null : lookback };
    if (rate < 0.05) {
      return { ...out, status: "idle", projectedAtReset: used };
    }

    const hoursToEmpty = (100 - used) / rate;
    const runOutAt = now + hoursToEmpty * HOUR;
    const projectedAtReset = resetAt ? clamp(used + rate * ((resetAt - now) / HOUR)) : null;
    if (!resetAt || runOutAt < resetAt) return { ...out, status: "runout", runOutAt, projectedAtReset };
    return { ...out, status: "on-track", projectedAtReset };
  }

  function clamp(v) {
    return Math.min(100, Math.max(0, Number(v) || 0));
  }
  function round(v, d) {
    const f = 10 ** d;
    return Math.round(v * f) / f;
  }

  root.UsageForecast = { forecastWindow };
  if (typeof module !== "undefined") module.exports = { forecastWindow };
})(typeof self !== "undefined" ? self : globalThis);
