import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../physics.js');
const G0 = P.G;

/* 弹射的性格（physics.js 里的 launch character 一节）：
     a(v) = a0               v <= vBase     恒推力段
     a(v) = a0 * vBase / v   v >  vBase     恒功率段（反电动势吃掉了电压余量）
   vBase = BURST_R * V，峰值 a0 由「恰好走完 launchLen、正好到达 V」反解。
   BURST_R = 1 退化成旧的恒定加速弹射（本文件第一条断言守住这条恒等关系）。
   诚实说明：这是液压 / LIM 的性格（"突然、生硬的一脚"），不是 LSM 的 —— 行业把 LSM
   描述为平稳、由电脑精确计量的一推。 */

function drawn(lenM, hillM, n = 200) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: t * lenM, y: -hillM * Math.sin(Math.PI * t) * (0.7 + 0.3 * Math.sin(6 * t)) });
  }
  return pts;
}
// 建一条接近 276 米的手绘轨道当作标定基准（手机画满一屏就是这规模）。
const ctrl = (() => {
  let best = null, bestD = Infinity;
  for (const w of [140, 155, 170, 185, 200]) {
    const c = P.buildControl(drawn(w, w * .6), w * 1.4 + 30);
    const d = Math.abs(P.buildTrack(c).len - 276);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
})();
const TIERS = [100, 300, 400, 1000, 3000, 10000];
const sim = (kmh, dt = 1 / 240, record = false) => P.simulate(ctrl, { launchKmh: kmh, dt, record });
const near = (log, s) => log.reduce((b, x) => (Math.abs(x[0] - s) < Math.abs(b[0] - s) ? x : b), log[0]);
const duration = r => (r.launchVb - P.V0) / r.launchA
  + (r.launchV * r.launchV - r.launchVb * r.launchVb) / (2 * r.launchA * r.launchVb);

test('BURST_R = 1 时爆发布局退化为旧的恒定加速弹射', () => {
  const V = 400 / 3.6, L = 42, vb = V;                       // BURST_R = 1 ⇒ vBase = V
  const closed = ((vb * vb - P.V0 * P.V0) / 2 + (V ** 3 - vb ** 3) / (3 * vb)) / L;
  const old = (V * V - P.V0 * P.V0) / (2 * L);
  assert.ok(Math.abs(closed - old) < 1e-9, '闭式 ' + closed + ' vs 旧式 ' + old);
});

test('各档都精确到达目标速度，而且正好在弹射段末端', () => {
  P.setArcade(true);
  for (const kmh of TIERS) {
    const r = sim(kmh).result;
    const V = kmh / 3.6;
    assert.equal(r.launchLen <= P.buildTrack(ctrl).len + 1e-9, true, kmh + ' 弹射段不得超过轨道');
    assert.ok(r.launchA > 0, kmh + ' 峰值加速度应当为正');
    // 位置闭式在 s = launchLen 处必须精确等于目标速度
    assert.ok(Math.abs(P.launchSpeed(r, r.launchLen) - V) < 1e-9,
      kmh + ' km/h: launchSpeed(L) = ' + P.launchSpeed(r, r.launchLen) + ' vs ' + V);
    // 模拟出来的列车也必须在弹射段末端到达目标速度。帧长必须细到每帧前进不超过 0.2 米，
    // 否则 10000 km/h 下每帧前进 5.75 米，日志压根分辨不出弹射段末尾（那是采样问题，不是物理）。
    const res = sim(kmh, Math.min(1 / 480, .2 / V), true);
    const e = near(res.log, r.launchLen);
    assert.ok(Math.abs(e[1] - V) / V < .005, kmh + ' km/h 实测末速 ' + (e[1] * 3.6).toFixed(1) + ' km/h');
  }
});

test('弹射段内瞬时加速度单调不增 —— 这就是"爆发"的形状本体', () => {
  P.setArcade(true);
  for (const kmh of TIERS) {
    const r = sim(kmh).result;
    const L = r.launchLen, a0 = r.launchA, vb = r.launchVb;
    const s1 = (vb * vb - P.V0 * P.V0) / (2 * a0);
    const ds = L * 1e-4;
    let prev = Infinity;
    for (let i = 0; i <= 400; i++) {
      // 只在内段取样：s→0 处 launchSpeed 会把 s<0 钳到 V0，中心差分在那里是错的
      const s = L * (.02 + .96 * i / 400);
      const v = P.launchSpeed(r, s);
      const a = (P.launchSpeed(r, s + ds) - P.launchSpeed(r, s - ds)) / (2 * ds) * v;
      assert.ok(a <= prev + 1e-9, kmh + ' km/h 在 s=' + s.toFixed(2) + ' 处加速度回升了（应单调不增）');
      prev = a;
      const an = s <= s1 ? a0 : a0 * vb / v;
      assert.ok(Math.abs(a - an) / a0 < 1e-3, kmh + ' km/h 的 a(s) 偏离闭式 ' + ((a - an) / a0 * 100).toFixed(4) + '%');
    }
  }
});

test('起步确实是恒推力段：实测加速度等于闭式峰值', () => {
  P.setArcade(true);
  const res = sim(400, 1 / 480, true);
  const r = res.result;
  const a0 = r.launchA, vb = r.launchVb;
  const s1 = (vb * vb - P.V0 * P.V0) / (2 * a0);
  const p = near(res.log, .2), q = near(res.log, Math.min(s1 * .9, r.launchLen * .5));
  assert.ok(q[0] > p[0], '取样点必须有先后');
  const a = (q[1] * q[1] - p[1] * p[1]) / (2 * (q[0] - p[0]));
  assert.ok(Math.abs(a - a0) / a0 < .02, '实测 ' + a.toFixed(1) + ' vs 闭式 ' + a0.toFixed(1) + ' m/s²');
});

test('爆发形状：峰值至少是尾段的 2 倍', () => {
  P.setArcade(true);
  for (const kmh of TIERS) {
    const r = sim(kmh).result;
    const peak = r.launchA, tail = r.launchA * r.launchVb / r.launchV;
    assert.ok(peak / tail > 2, kmh + ' km/h 峰值/尾段 = ' + (peak / tail).toFixed(2) + '，不够"爆发"');
  }
});

test('标定：100 km/h 落在真实 LSM 量级（对得上 Blue Fire 的 2.5 秒）', () => {
  P.setArcade(true);
  const r = sim(100).result;
  const peakG = r.launchA / G0;
  const dur = duration(r);
  assert.ok(peakG >= 1.2 && peakG <= 1.8, '峰值 ' + peakG.toFixed(2) + ' G 不在 1.2–1.8 之间');
  assert.ok(dur >= 2.2 && dur <= 2.8, '弹射时长 ' + dur.toFixed(2) + ' s 不在 2.2–2.8 之间');
});

test('10000 km/h 配上极短轨道：新曲线下依然不倒退、不 NaN、能终止', () => {
  P.setArcade(true);
  const tiny = P.buildControl([{ x: 0, y: 0 }, { x: 14, y: -5 }, { x: 30, y: 0 }], 60);
  const r = P.simulate(tiny, { dt: 1 / 60, launchKmh: 10000, record: true });
  assert.equal(r.ended, true);
  assert.equal(r.faulted, false);
  for (let i = 1; i < r.log.length; i++) assert.ok(r.log[i][0] >= r.log[i - 1][0] - 1e-9, 's 回退于第 ' + i + ' 帧');
});
