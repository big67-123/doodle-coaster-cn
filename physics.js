// physics.js - the DOM-free half of the coaster: geometry, the ride integrator, and a
// headless simulate() for the Node tests.
//
// Split out of the single-file game on purpose: the integrator is the part we tune, and a
// 10 000 km/h launch is impossible to validate by eye. Everything in here is pure maths.
// Loaded as a classic script (so file:// still works) and imported by Node via the tail.
(() => {
'use strict';

/* ---------- constants ---------- */
const G = 9.81, VMIN = 10, V0 = 1.5, DRAG = .0008, ROLL = .15, DS = .25;
const SUB = 1 / 240;                                  // fixed integration step
const SMOOTH_TURN = 2, SMOOTH_PULL = 6;               // metres

// ---------- tuning ----------
// The defaults reproduce the original physics bit-for-bit. Arcade mode turns the two caps on;
// those two caps are what turn a 10 000 km/h launch into a ride instead of a physics joke.
const DRAG_CAP_ARCADE = 3.0;    // m/s^2. Identity below sqrt(3/.0008) = 61.2 m/s = 220 km/h
const BRAKE_A_ARCADE = 25;      // m/s^2, about 2.5 g braking into the station
let dragCap = Infinity;         // m/s^2 ceiling on air drag
let brakeA = Infinity;          // m/s^2 ceiling on the run-in brake
let subStep = SUB;              // base integration step; shrunk further as speed rises
let spaceStep = DS;             // metres advanced per sub-step at high speed (tests shrink it)
let releaseHook = null;         // injected by the page -- the brake-clunk sound lives there

function setArcade(on) {
  dragCap = on ? DRAG_CAP_ARCADE : Infinity;
  brakeA = on ? BRAKE_A_ARCADE : Infinity;
}
function onRelease(fn) { releaseHook = fn; }

/* ---------- air drag ---------- */
// Original: DRAG * v^2, uncapped. Arcade mode caps it, which is bit-identical below
// v = sqrt(cap / DRAG) = 61.2 m/s (220 km/h) and keeps a Mach-8 launch rideable.
function dragAcc(v) { return Math.min(DRAG * v * v, dragCap); }

/* ---------- geometry ---------- */
function resample(pts, step) {
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < 1e-9) continue;
    let t = step - carry;
    while (t <= d) { const k = t / d; out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }); t += step; }
    carry = d - (t - step);
  }
  const l = pts[pts.length - 1], e = out[out.length - 1];
  if (Math.hypot(l.x - e.x, l.y - e.y) > step * .3) out.push({ x: l.x, y: l.y });
  return out;
}

function blur(a, sig) {
  const R = Math.ceil(sig * 3), w = []; let ws = 0;
  for (let j = -R; j <= R; j++) { const v = Math.exp(-j * j / (2 * sig * sig)); w.push(v); ws += v; }
  const n = a.length, out = new Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = -R; j <= R; j++) s += a[Math.max(0, Math.min(n - 1, i + j))] * w[j + R]; out[i] = s / ws; }
  return out;
}

function buildControl(pts, groundY) {
  const st = .25;
  let p = resample(pts, st);
  p = p.map((a, i) => {                            // take the pixel jitter off first
    if (i === 0 || i === p.length - 1) return { x: a.x, y: a.y };
    const k = Math.min(2, i, p.length - 1 - i); let x = 0, y = 0;
    for (let j = i - k; j <= i + k; j++) { x += p[j].x; y += p[j].y; }
    return { x: x / (2 * k + 1), y: y / (2 * k + 1) };
  });
  const n = p.length, th = [], d = [];
  for (let i = 0; i < n - 1; i++) {
    let a = Math.atan2(p[i + 1].y - p[i].y, p[i + 1].x - p[i].x);
    if (i) { while (a - th[i - 1] > Math.PI) a -= 2 * Math.PI; while (a - th[i - 1] < -Math.PI) a += 2 * Math.PI; }
    th.push(a); d.push(Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y));
  }
  const ts = blur(th, SMOOTH_TURN / st), q = [{ x: p[0].x, y: p[0].y }];
  for (let i = 0; i < n - 1; i++) q.push({ x: q[i].x + d[i] * Math.cos(ts[i]), y: q[i].y + d[i] * Math.sin(ts[i]) });
  const ex = blur(p.map((a, i) => a.x - q[i].x), SMOOTH_PULL / st), ey = blur(p.map((a, i) => a.y - q[i].y), SMOOTH_PULL / st);
  const sm = q.map((a, i) => ({ x: a.x + ex[i], y: Math.min(groundY - 1, a.y + ey[i]) }));
  const out = [{ x: sm[0].x, y: sm[0].y }];
  let carry = 0;
  for (let i = 1; i < sm.length; i++) {
    const a = sm[i - 1], b = sm[i], d = Math.hypot(b.x - a.x, b.y - a.y);
    let t = 1 - carry;
    while (t <= d) { const k = t / d; out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }); t += 1; }
    carry = d - (t - 1);
  }
  return out;
}

function buildTrack(c) {
  const dense = [];
  const P = i => c[Math.max(0, Math.min(c.length - 1, i))];
  for (let i = 0; i < c.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let k = 0; k < 8; k++) {
      const t = k / 8, t2 = t * t, t3 = t2 * t;
      dense.push({
        x: .5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: .5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
      });
    }
  }
  dense.push({ ...c[c.length - 1] });
  // arc-length resample
  const xs = [dense[0].x], ys = [dense[0].y];
  let carry = 0;
  for (let i = 1; i < dense.length; i++) {
    const a = dense[i - 1], b = dense[i], d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < 1e-6) continue;
    let t = DS - carry;
    while (t <= d) { const k = t / d; xs.push(a.x + (b.x - a.x) * k); ys.push(a.y + (b.y - a.y) * k); t += DS; }
    carry = d - (t - DS);
  }
  const n = xs.length, tx = new Float32Array(n), ty = new Float32Array(n), kx = new Float32Array(n), ky = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let dx = xs[b] - xs[a], dy = ys[b] - ys[a]; const m = Math.hypot(dx, dy) || 1;
    tx[i] = dx / m; ty[i] = dy / m;
    const k = 6, i0 = Math.max(0, i - k), i1 = Math.min(n - 1, i + k);
    if (i - i0 === k && i1 - i === k) { kx[i] = (xs[i1] - 2 * xs[i] + xs[i0]) / ((k * DS) ** 2); ky[i] = (ys[i1] - 2 * ys[i] + ys[i0]) / ((k * DS) ** 2); }
  }
  // smooth curvature a little (hand-drawn wobble would otherwise read as G spikes)
  const skx = new Float32Array(n), sky = new Float32Array(n);
  for (let i = 0; i < n; i++) { let x = 0, y = 0, c2 = 0; for (let j = Math.max(0, i - 5); j <= Math.min(n - 1, i + 5); j++) { x += kx[j]; y += ky[j]; c2++; } skx[i] = x / c2; sky[i] = y / c2; }
  // which side of the rail the train sits on: chosen so it starts upright, then fixed (loops turn it upside down)
  const sigma = -tx[0] > 0 ? -1 : 1;
  return { xs, ys, tx, ty, kx: skx, ky: sky, n, len: (n - 1) * DS, sigma };
}

function sample(track, s) {
  const t = track, f = Math.max(0, Math.min(t.n - 1.001, s / DS)), i = Math.floor(f), u = f - i, j = Math.min(t.n - 1, i + 1);
  const lerp = (A) => A[i] + (A[j] - A[i]) * u;
  let tx = lerp(t.tx), ty = lerp(t.ty); const m = Math.hypot(tx, ty) || 1; tx /= m; ty /= m;
  return { x: lerp(t.xs), y: lerp(t.ys), tx, ty, kx: lerp(t.kx), ky: lerp(t.ky) };
}

function zAt(track, s) {
  const t = track, f = Math.max(0, Math.min(t.n - 1.001, s / DS)), i = Math.floor(f);
  return t.zs[i] + (t.zs[i + 1] - t.zs[i]) * (f - i);
}

/* ---------- ride ---------- */
function newRide() {
  return { s: 0, v: V0, t: 0, acc: 0, g: 1, lift: false, ended: false, clickT: 0, riders: null,
           hold: 0, held: 0,
           // electromagnetic launch; all zero when the ride simply rolls out of the station
           launchV: 0, launchLen: 0, launchA: 0, launching: false,
           // what the gauge and the score card read
           vmax: 0, gAbsMax: 0, faulted: false };
}

// The electromagnetic launch. A constant-acceleration run this short would need about 1300 g at
// 10 000 km/h, which no integrator survives -- so the launch is *kinematic*: speed is a function
// of position, v = sqrt(2*a*s + V0^2), and the normal dynamics only resume once the train
// reaches launchV. Deterministic, and exact at any speed.
function applyLaunch(r, track, kmh) {
  const v = Math.max(0, Math.min(10000, Number(kmh) || 0)) / 3.6;
  if (!(v > V0)) return 0;
  r.launchLen = Math.min(Math.max(25, Math.min(300, track.len * 0.25)), track.len);
  r.launchV = v;
  r.launchA = (v * v - V0 * V0) / (2 * r.launchLen);
  r.launching = true;
  return r.launchA;
}

function stepRide(track, r, dt) {
  if (r.hold > 0) {
    r.hold -= dt; r.held += dt;
    if (r.hold <= 0) { r.hold = 0; r.acc = 0; if (releaseHook) releaseHook(r); }
    return;
  }
  r.acc += dt;
  let steps = 0;
  while (r.acc > 0 && !r.ended && steps++ < 20000) {
    // Adaptive step: never advance more than one track sample (DS = 25 cm) per sub-step. This is
    // the fix for the one real hazard of a hypersonic launch -- at 2778 m/s the original fixed
    // 1/240 s step moves 11.6 m, straight through the rails. Below 60 m/s this is exactly SUB,
    // so ordinary rides integrate bit-for-bit as before.
    const h = Math.min(subStep, spaceStep / Math.max(1, Math.abs(r.v)));
    if (r.acc < h) break;
    r.acc -= h;
    const p = sample(track, r.s);
    let at, exactDs = -1;
    if (r.launching && r.s < r.launchLen) {
      // Under constant acceleration v is linear in t, so the trapezoid (v0+v1)/2*h is the exact
      // displacement. That makes the launch phase independent of the step size -- otherwise the
      // plain s += v*h biased the launch duration by a few tenths of a percent.
      const v0 = r.v, v1 = Math.min(r.launchV, v0 + r.launchA * h);
      exactDs = (v0 + v1) * .5 * h;
      r.v = v1;
      at = v1 < r.launchV ? r.launchA : 0;
    } else {
      r.launching = false;
      at = G * p.ty - dragAcc(r.v) - ROLL;
      r.v += at * h;
    }
    r.lift = false;
    const vmin = Math.min(VMIN, V0 + r.t * 6);             // rolls out of the station, then never slower than VMIN
    if (!r.launching && r.v < vmin) { r.v = vmin; at = 0; r.lift = p.ty < -.15; }
    const rem = track.len - r.s;
    if (rem < 14) {
      const cap = Math.max(1.5, rem * 1.15);
      if (r.v > cap) {
        r.launching = false;                               // the brake run wins over the launch
        if (brakeA === Infinity) { r.v = cap; at = 0; }     // original behaviour, unchanged
        else { const dv = Math.min(r.v - cap, brakeA * h); r.v -= dv; at = -dv / h; }
      }
    }
    // 弹射段用精确位移；制动一旦插手（launching 被置否）就退回普通欧拉，保持原作行为。
    if (exactDs >= 0 && r.launching) r.s += exactDs; else r.s += r.v * h;
    r.t += h;
    if (r.v > r.vmax) r.vmax = r.v;
    if (r.s >= track.len - .01) { r.s = track.len; r.ended = true; }
    // felt vertical G in the rider's frame (the riders in 2D react to it)
    const ax = at * p.tx + r.v * r.v * p.kx, ay = at * p.ty + r.v * r.v * p.ky;
    const ux = track.sigma * p.ty, uy = -track.sigma * p.tx;
    const gz = (ax * ux + (ay - G) * uy) / G;
    r.g += (gz - r.g) * Math.min(1, h / .06);
    if (Math.abs(r.g) > r.gAbsMax) r.gAbsMax = Math.abs(r.g);
  }
  if (!Number.isFinite(r.s) || !Number.isFinite(r.v)) { r.faulted = true; r.v = V0; r.ended = true; }
}

// Headless driver: used by the Node tests and by the workshop's "test ride". Tuning is whatever
// setArcade()/setTuning() last selected, so a test states its physics explicitly.
function simulate(ctrl, opts = {}) {
  const o = Object.assign({ launchKmh: 0, dt: 1 / 60, maxFrames: 400000, record: false }, opts);
  const track = buildTrack(ctrl);
  const r = newRide();
  applyLaunch(r, track, o.launchKmh);
  const log = [];
  let frames = 0;
  while (!r.ended && frames++ < o.maxFrames) {
    stepRide(track, r, o.dt);
    if (o.record) log.push([r.s, r.v, r.g]);
  }
  return { s: r.s, t: r.t, v: r.v, vmax: r.vmax, gAbsMax: r.gAbsMax,
           ended: r.ended, faulted: r.faulted, launchA: r.launchA, launchV: r.launchV,
           log, result: r, track };
}

const api = {
  PX_PER_M: 10, G, VMIN, V0, DRAG, ROLL, DS, UNIT: 100, SUB, SMOOTH_TURN, SMOOTH_PULL,
  DRAG_CAP_ARCADE, BRAKE_A_ARCADE,
  dragAcc, setArcade, onRelease, applyLaunch,
  setTuning: (o) => {
    if (o.dragCap !== undefined) dragCap = o.dragCap;
    if (o.brakeA !== undefined) brakeA = o.brakeA;
    if (o.subStep !== undefined) subStep = o.subStep;
    if (o.spaceStep !== undefined) spaceStep = o.spaceStep;
  },
  getTuning: () => ({ dragCap, brakeA, subStep, spaceStep }),
  resample, blur, buildControl, buildTrack, sample, zAt, newRide, stepRide, simulate,
};
if (typeof window !== 'undefined') window.OLC_PHYS = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
