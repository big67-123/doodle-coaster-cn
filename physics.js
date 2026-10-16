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

/* ---------- launch character ---------- */
// The launch used to be a flat constant-acceleration run over clamp(track*0.25, 25, 300) m: a
// rectangular pulse, which reads as "being pushed steadily" rather than as a launch. Real machines
// do not do that -- thrust is highest while the train is still slow, then falls away once the drive
// runs out of voltage headroom (back-EMF) and becomes power-limited:
//     a(v) = a0               for v <= vBase     (constant force)
//     a(v) = a0 * vBase / v   for v >  vBase     (constant power)
// with vBase = BURST_R * V. BURST_R = 1 degenerates exactly to the old constant-acceleration launch.
// Naming, to stay honest: this is the hydraulic / LIM personality ("a sudden, abrupt kick"), not the
// LSM one -- the industry describes LSM as the smooth, computer-metered push.
const LAUNCH_FRAC = .15, LAUNCH_MIN = 20, LAUNCH_MAX = 60;
const BURST_R = .45;
// Maximum bank on a 3D turn, and the only tuning knob the tilt needs. phi = atan(v^2*kh/g) would
// cancel the sideways force exactly; capping it keeps a badly authored turn from over-banking into
// negative G at the top.
const BANK_MAX = .87;           // radians, about 50 degrees

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
  // A control point carrying a z makes this a real 3D layout. Two-dimensional input -- every
  // hand-drawn track and every existing JSON -- takes the untouched branch below, which is why
  // T.is3D stays false and the numbers come out bit-for-bit as before.
  const is3D = c.some(p => typeof p.z === 'number');
  const dense = [];
  const P = i => c[Math.max(0, Math.min(c.length - 1, i))];
  for (let i = 0; i < c.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const z0 = is3D ? (p0.z || 0) : 0, z1 = is3D ? (p1.z || 0) : 0, z2 = is3D ? (p2.z || 0) : 0, z3 = is3D ? (p3.z || 0) : 0;
    for (let k = 0; k < 8; k++) {
      const t = k / 8, t2 = t * t, t3 = t2 * t;
      const q = {
        x: .5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: .5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
      };
      if (is3D) q.z = .5 * (2 * z1 + (-z0 + z2) * t + (2 * z0 - 5 * z1 + 4 * z2 - z3) * t2 + (-z0 + 3 * z1 - 3 * z2 + z3) * t3);
      dense.push(q);
    }
  }
  dense.push({ ...c[c.length - 1] });
  // arc-length resample; a 3D layout is resampled along its true 3D length
  const xs = [dense[0].x], ys = [dense[0].y], zl = is3D ? [dense[0].z || 0] : null;
  let carry = 0;
  for (let i = 1; i < dense.length; i++) {
    const a = dense[i - 1], b = dense[i];
    const d = is3D ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) : Math.hypot(b.x - a.x, b.y - a.y);
    if (d < 1e-6) continue;
    let t = DS - carry;
    while (t <= d) { const k = t / d; xs.push(a.x + (b.x - a.x) * k); ys.push(a.y + (b.y - a.y) * k); if (is3D) zl.push(a.z + (b.z - a.z) * k); t += DS; }
    carry = d - (t - DS);
  }
  const n = xs.length;
  const zs = is3D ? new Float32Array(zl) : null;
  const tx = new Float32Array(n), ty = new Float32Array(n), tz = new Float32Array(n);
  const kx = new Float32Array(n), ky = new Float32Array(n), kz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let dx = xs[b] - xs[a], dy = ys[b] - ys[a], dz = is3D ? zs[b] - zs[a] : 0;
    const m = (is3D ? Math.hypot(dx, dy, dz) : Math.hypot(dx, dy)) || 1;
    tx[i] = dx / m; ty[i] = dy / m; tz[i] = is3D ? dz / m : 0;
    const k = 6, i0 = Math.max(0, i - k), i1 = Math.min(n - 1, i + k);
    if (i - i0 === k && i1 - i === k) {
      const dd = (k * DS) ** 2;
      kx[i] = (xs[i1] - 2 * xs[i] + xs[i0]) / dd; ky[i] = (ys[i1] - 2 * ys[i] + ys[i0]) / dd;
      if (is3D) kz[i] = (zs[i1] - 2 * zs[i] + zs[i0]) / dd;
    }
  }
  // smooth curvature a little (hand-drawn wobble would otherwise read as G spikes)
  const skx = new Float32Array(n), sky = new Float32Array(n), skz = new Float32Array(n);
  for (let i = 0; i < n; i++) { let x = 0, y = 0, z = 0, c2 = 0; for (let j = Math.max(0, i - 5); j <= Math.min(n - 1, i + 5); j++) { x += kx[j]; y += ky[j]; z += kz[j]; c2++; } skx[i] = x / c2; sky[i] = y / c2; skz[i] = z / c2; }
  // which side of the rail the train sits on: chosen so it starts upright, then fixed (loops turn it upside down)
  const sigma = -tx[0] > 0 ? -1 : 1;
  // The rider's "up" axis. Flat tracks keep the original two-dimensional normal, exactly as
  // written. A 3D layout transports that normal along the rail (rotation-minimising frame), which
  // is well defined through a vertical drop and leaves a level turn unrolled -- the right base to
  // bank on top of, later.
  const ux = new Float32Array(n), uy = new Float32Array(n), uz = new Float32Array(n);
  if (!is3D) {
    for (let i = 0; i < n; i++) { ux[i] = sigma * ty[i]; uy[i] = -sigma * tx[i]; uz[i] = 0; }
  } else {
    // World up, projected off the tangent: the rider's head points as close to the sky as the rail
    // allows, so a level turn stays unrolled. A perfectly vertical tangent makes that projection
    // vanish, and there the previous frame is carried forward rather than snapping.
    for (let i = 0; i < n; i++) {
      const dp = -ty[i];
      let wx = -dp * tx[i], wy = -1 - dp * ty[i], wz = -dp * tz[i];
      let m = Math.hypot(wx, wy, wz);
      if (m < 1e-6) {
        const px = i ? ux[i - 1] : 1, py = i ? uy[i - 1] : 0, pz = i ? uz[i - 1] : 0;
        const dq = px * tx[i] + py * ty[i] + pz * tz[i];
        wx = px - dq * tx[i]; wy = py - dq * ty[i]; wz = pz - dq * tz[i];
        m = Math.hypot(wx, wy, wz) || 1;
      }
      ux[i] = sigma * wx / m; uy[i] = sigma * wy / m; uz[i] = sigma * wz / m;
    }
    // Bank the turns so the sideways force is carried by the seat instead of the rider's ribs.
    // phi = atan(v^2 * kh / g) is the angle that cancels it. The speed has to be the one the train
    // will actually carry, so it comes from a coarse forward integration of the same drag model the
    // ride uses: a free-fall estimate is wildly optimistic once the drag has taken its cut, and the
    // turn ends up over-banked (thrown outward). Banking does not change length or slope, so this
    // pass is not circular.
    const vv = new Float32Array(n);
    let v2 = V0 * V0;
    for (let i = 0; i < n; i++) {
      vv[i] = v2;
      const at = G * ty[i] - (Math.min(DRAG * v2, dragCap) + ROLL);
      v2 = Math.max(VMIN * VMIN, v2 + 2 * at * DS);
    }
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lx = ty[i] * uz[i] - tz[i] * uy[i], ly = tz[i] * ux[i] - tx[i] * uz[i], lz = tx[i] * uy[i] - ty[i] * ux[i];
      const kh = skx[i] * lx + sky[i] * ly + skz[i] * lz;
      const a = Math.atan(vv[i] * kh / G);
      raw[i] = Math.max(-BANK_MAX, Math.min(BANK_MAX, a));
    }
    for (let i = 0; i < n; i++) {
      let a = 0, c2 = 0;
      for (let j = Math.max(0, i - 5); j <= Math.min(n - 1, i + 5); j++) { a += raw[j]; c2++; }
      a /= c2;
      const cs = Math.cos(a), sn = Math.sin(a);
      const lx = ty[i] * uz[i] - tz[i] * uy[i], ly = tz[i] * ux[i] - tx[i] * uz[i], lz = tx[i] * uy[i] - ty[i] * ux[i];
      const ox = ux[i], oy = uy[i], oz = uz[i];
      ux[i] = ox * cs + lx * sn; uy[i] = oy * cs + ly * sn; uz[i] = oz * cs + lz * sn;
    }
  }
  return { xs, ys, zs, tx, ty, tz, kx: skx, ky: sky, kz: skz, ux, uy, uz, n, len: (n - 1) * DS, sigma, is3D };
}

function sample(track, s) {
  const t = track, f = Math.max(0, Math.min(t.n - 1.001, s / DS)), i = Math.floor(f), u = f - i, j = Math.min(t.n - 1, i + 1);
  const lerp = (A) => A[i] + (A[j] - A[i]) * u;
  let tx = lerp(t.tx), ty = lerp(t.ty);
  const tz = t.is3D ? lerp(t.tz) : 0;
  const m = (t.is3D ? Math.hypot(tx, ty, tz) : Math.hypot(tx, ty)) || 1;
  tx /= m; ty /= m;
  // U is delivered already in the shape the rider's felt-G projection wants. Flat tracks hand back
  // the raw sigma*(ty,-tx) pair, un-normalised, so the 2D force arithmetic is unchanged.
  let ux = lerp(t.ux), uy = lerp(t.uy), uz = t.is3D ? lerp(t.uz) : 0;
  if (t.is3D) { const um = Math.hypot(ux, uy, uz) || 1; ux /= um; uy /= um; uz /= um; }
  return { x: lerp(t.xs), y: lerp(t.ys), z: t.is3D ? lerp(t.zs) : 0, tx, ty, tz: t.is3D ? tz / m : 0,
           kx: lerp(t.kx), ky: lerp(t.ky), kz: t.is3D ? lerp(t.kz) : 0, ux, uy, uz };
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
           launchV: 0, launchLen: 0, launchA: 0, launchVb: 0, launching: false,
           // what the gauge and the score card read
           vmax: 0, gAbsMax: 0, gx: 0, gxMax: 0, gy: 0, gyMax: 0, faulted: false };
}

// The electromagnetic launch. A constant-acceleration run this short would need about 1300 g at
// 10 000 km/h, which no integrator survives -- so the launch is *kinematic*: speed is a function
// of position, v = sqrt(2*a*s + V0^2), and the normal dynamics only resume once the train
// reaches launchV. Deterministic, and exact at any speed.
function applyLaunch(r, track, kmh) {
  const v = Math.max(0, Math.min(10000, Number(kmh) || 0)) / 3.6;
  if (!(v > V0)) return 0;
  r.launchLen = Math.min(Math.max(LAUNCH_MIN, Math.min(LAUNCH_MAX, track.len * LAUNCH_FRAC)), track.len);
  r.launchV = v;
  // Base speed: clamped above V0 so the constant-force phase is never empty (vBase is a divisor).
  r.launchVb = Math.max(V0 * 1.0001, Math.min(v, BURST_R * v));
  // Peak acceleration, solved from "covers exactly launchLen and arrives exactly at launchV" by
  // integrating the two-regime profile:
  //   launchLen = (vBase^2 - V0^2)/(2*a0) + (V^3 - vBase^3)/(3*a0*vBase)
  // With BURST_R = 1 the second term vanishes and this is (V^2 - V0^2)/(2*launchLen) -- the old
  // constant-acceleration launch. test/launch.test.mjs asserts that identity.
  const vb = r.launchVb;
  r.launchA = ((vb * vb - V0 * V0) / 2 + (v * v * v - vb * vb * vb) / (3 * vb)) / r.launchLen;
  r.launching = true;
  return r.launchA;
}

// Speed as a closed-form function of position inside the launch. Because the profile does not come
// from integrating acceleration, it is step-size independent by construction -- and exact at any
// speed, including 10 000 km/h, where an explicit integrator would need absurd steps.
function launchSpeed(r, s) {
  if (s <= 0) return V0;
  const vb = r.launchVb, a0 = r.launchA;
  const s1 = (vb * vb - V0 * V0) / (2 * a0);          // where the constant-force phase ends
  if (s <= s1) return Math.sqrt(V0 * V0 + 2 * a0 * s);
  return Math.cbrt(vb * vb * vb + 3 * a0 * vb * (s - s1));
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
      // Speed is a closed-form function of position, so the profile itself is step-size
      // independent. Two trapezoid passes make the displacement second-order accurate; at is the
      // true instantaneous tangential acceleration -- the burst as it is actually felt.
      const v0 = r.v;
      let ds = v0 * h;
      for (let it = 0; it < 2; it++) {
        const vg = Math.min(r.launchV, launchSpeed(r, r.s + ds));
        ds = (v0 + vg) * .5 * h;
      }
      const v1 = Math.min(r.launchV, launchSpeed(r, r.s + ds));
      exactDs = ds;
      r.v = v1;
      at = Math.max(0, (v1 - v0) / h);
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
    const ax = at * p.tx + r.v * r.v * p.kx, ay = at * p.ty + r.v * r.v * p.ky, az = at * p.tz + r.v * r.v * p.kz;
    const ux = p.ux, uy = p.uy, uz = p.uz;
    // On a flat track p.tz, p.kz and p.uz are all exactly zero, so `+ az * uz` adds plain 0 and the
    // line stays digit-for-digit the original two-dimensional arithmetic.
    const gz = (ax * ux + (ay - G) * uy + az * uz) / G;
    r.g += (gz - r.g) * Math.min(1, h / .06);
    if (Math.abs(r.g) > r.gAbsMax) r.gAbsMax = Math.abs(r.g);
    // Sideways G. Only a 3D layout can make any: on a flat track the lateral axis lies in the plane
    // of the drawing and gravity has no component along it. L = T x U is the rider's left/right axis.
    if (track.is3D) {
      const lx = p.ty * uz - p.tz * uy, ly = p.tz * ux - p.tx * uz, lz = p.tx * uy - p.ty * ux;
      const lm = Math.hypot(lx, ly, lz);
      if (lm > 1e-9) {
        r.gy = (ax * (lx / lm) + (ay - G) * (ly / lm) + az * (lz / lm)) / G;
        if (Math.abs(r.gy) > r.gyMax) r.gyMax = Math.abs(r.gy);
      }
    }
    // Felt longitudinal G -- the shove into the seat back. Gravity's component along the track is
    // G*ty and the ride's tangential acceleration is at, so the specific force is at - G*ty.
    // The vertical-G gauge physically cannot see this on a level launch track: ty = 0 makes its
    // projection onto the rider's "up" axis exactly zero. That is why the launch carries its own
    // readout and its own camera feedback. Deliberately not low-passed -- the burst must not be
    // smoothed away.
    r.gx = at / G - p.ty;
    if (r.gx > r.gxMax) r.gxMax = r.gx;
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
  return { s: r.s, t: r.t, v: r.v, vmax: r.vmax, gAbsMax: r.gAbsMax, gxMax: r.gxMax, gyMax: r.gyMax,
           ended: r.ended, faulted: r.faulted, launchA: r.launchA, launchV: r.launchV,
           launchVb: r.launchVb, launchLen: r.launchLen, is3D: track.is3D,
           log, result: r, track };
}

const api = {
  PX_PER_M: 10, G, VMIN, V0, DRAG, ROLL, DS, UNIT: 100, SUB, SMOOTH_TURN, SMOOTH_PULL,
  DRAG_CAP_ARCADE, BRAKE_A_ARCADE,
  dragAcc, setArcade, onRelease, applyLaunch, launchSpeed,
  LAUNCH_FRAC, LAUNCH_MIN, LAUNCH_MAX, BURST_R,
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
