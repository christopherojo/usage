// Run: node test/forecast.test.js
const assert = require("assert");
const { forecastWindow } = require("../extension/lib/forecast.js");
const MIN = 60e3, H = 60 * MIN, now = Date.UTC(2026, 10, 9, 12, 0);
const W5 = (used, resetIn = 2 * H) => ({ key: "5-hour", usedPercent: used, windowSeconds: 18000, resetAt: now + resetIn });
const hist = (pairs) => pairs.map(([agoMin, v]) => ({ ts: now - agoMin * MIN, windows: [{ key: "5-hour", usedPercent: v }] }));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("heavy recent use runs out before reset", () => {
  // 40% -> 70% over the last hour = 30%/h; 30% left => 1h to empty; reset in 2h
  const f = forecastWindow(W5(70), hist([[90, 35], [60, 40], [30, 55], [0, 70]]), now);
  assert.equal(f.status, "runout"); assert.equal(f.basis, "recent");
  assert.ok(Math.abs(f.ratePerHour - 30) < 0.01, f.ratePerHour);
  assert.ok(Math.abs(f.runOutAt - (now + H)) < MIN);
  assert.equal(f.projectedAtReset, 100);
});
t("light use stays on track and projects end value", () => {
  // 20 -> 25 over the hour = 5%/h; 2h to reset => 35%
  const f = forecastWindow(W5(25), hist([[60, 20], [0, 25]]), now);
  assert.equal(f.status, "on-track"); assert.ok(Math.abs(f.projectedAtReset - 35) < 0.01);
});
t("flat usage is idle", () => {
  const f = forecastWindow(W5(50), hist([[120, 50], [60, 50], [0, 50]]), now);
  assert.equal(f.status, "idle");
});
t("a reset inside the history is ignored", () => {
  // was 90 before a reset, then 0 -> 10 over 40 min
  const f = forecastWindow(W5(10, 5 * H - 40 * MIN), hist([[70, 90], [40, 0], [0, 10]]), now);
  assert.equal(f.basis, "recent"); assert.ok(Math.abs(f.ratePerHour - 15) < 0.01, f.ratePerHour);
});
t("no history falls back to window average", () => {
  // window started 3h ago (reset in 2h); 60% used => 20%/h; 40 left => 2h => exactly at reset => on-track (not before)
  const f = forecastWindow(W5(60), [], now);
  assert.equal(f.basis, "window"); assert.ok(Math.abs(f.ratePerHour - 20) < 0.01);
  assert.ok(Math.abs(f.evenPaceUsed - 60) < 0.01, f.evenPaceUsed);
});
t("maxed out", () => assert.equal(forecastWindow(W5(100), [], now).status, "maxed"));
t("weekly window uses a longer lookback", () => {
  const w = { key: "Weekly", usedPercent: 50, windowSeconds: 604800, resetAt: now + 3 * 24 * H };
  const h = [{ ts: now - 30 * H, windows: [{ key: "Weekly", usedPercent: 38 }] }];
  const f = forecastWindow(w, h, now);
  // 30h of history vs a 33.6h lookback => 89% coverage: blend 0.4%/h recent with 50%/96h window avg
  const cov = 30 / 33.6, expect = cov * 0.4 + (1 - cov) * (50 / 96);
  assert.equal(f.basis, "blend"); assert.ok(Math.abs(f.ratePerHour - expect) < 0.01, f.ratePerHour);
  assert.equal(f.status, "on-track");
});
t("one busy session isn't projected across the whole week", () => {
  // The screenshot case: weekly 63% used, resets in 54h, only ~3h of history at 2.5%/h.
  const w = { key: "Weekly", usedPercent: 63, windowSeconds: 604800, resetAt: now + 54 * H };
  const h = [{ ts: now - 3 * H, windows: [{ key: "Weekly", usedPercent: 55.5 }] }];
  const f = forecastWindow(w, h, now);
  assert.equal(f.basis, "blend");
  const windowAvg = 63 / (7 * 24 - 54), cov = 3 / 33.6;
  assert.ok(Math.abs(f.ratePerHour - (cov * 2.5 + (1 - cov) * windowAvg)) < 0.01, f.ratePerHour);
  assert.ok(f.ratePerHour < 1, "should be far below the raw 2.5%/h session rate");
  assert.ok(f.ratePerHour > windowAvg, "but still reflect the busier recent pace");
});
console.log(`${n} passed`);
