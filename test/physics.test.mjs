import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { FIX, LAUNCHES } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const P = require('../physics.js');
const golden = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url), 'utf8'));

/* 先把每条轨道都构建好（buildControl 需要地面高度）。 */
const built = {};
for (const [k, c] of Object.entries(FIX)) built[k] = P.buildControl(c.raw, c.ground);

// 每个测试都显式声明自己用的物理参数，不依赖跨测试的残留状态。
const original = () => { P.setTuning({ dragCap: Infinity, brakeA: Infinity, subStep: P.SUB, spaceStep: P.DS }); };
const arcade = () => { original(); P.setArcade(true); };

test('与原作逐位等价：低于 60 m/s 的轨道飞行轨迹完全一致', () => {
  original();
  for (const key of ['gentle', 'long']) {
    const r = P.simulate(built[key], { dt: 1 / 60, record: true });
    const g = golden.cases[key];
    assert.equal(r.log.length, g.frames, key + ' 帧数');
    assert.ok(Math.abs(r.t - g.t) < 1e-8, key + ' 用时 ' + r.t + ' vs ' + g.t);
    assert.ok(Math.abs(r.v - g.endV) < 1e-8, key + ' 入站速度');
    // 基线记的是逐帧峰值；r.vmax 是逐子步峰值，两者是不同量，必须同类比较。
    const frameVmax = Math.max(...r.log.map(p => p[1]));
    assert.ok(Math.abs(frameVmax - g.vmax) < 1e-9, key + ' 逐帧最高速度 ' + frameVmax + ' vs ' + g.vmax);
    assert.ok(r.vmax >= frameVmax - 1e-12, key + ' 子步峰值不应低于逐帧峰值');
  }
});

test('超过 60 m/s 时自适应子步启用，与原作的偏差小于 0.05%', () => {
  original();
  const r = P.simulate(built.steep, { dt: 1 / 60 });
  const g = golden.cases.steep;
  assert.ok(r.vmax > 60, '这条轨道本来就该超过 60 m/s（实测 ' + r.vmax.toFixed(2) + '）');
  assert.ok(Math.abs(r.t - g.t) / g.t < 5e-4, '用时偏差 ' + (Math.abs(r.t - g.t) / g.t));
  assert.ok(Math.abs(r.vmax - g.vmax) / g.vmax < 1e-3, '最高速偏差');
});

test('空间步长缩到 1/8，结果变化小于 0.1%（积分器收敛）', () => {
  arcade();
  for (const kmh of LAUNCHES) {
    P.setTuning({ spaceStep: P.DS });
    const a = P.simulate(built.long, { dt: 1 / 60, launchKmh: kmh });
    P.setTuning({ spaceStep: P.DS / 8 });
    const b = P.simulate(built.long, { dt: 1 / 60, launchKmh: kmh });
    assert.ok(Math.abs(b.t - a.t) / a.t < 1e-3, kmh + ' km/h 用时变化 ' + ((b.t - a.t) / a.t) + '（应小于 0.1%）');
    assert.ok(Math.abs(b.vmax - a.vmax) / Math.max(1, a.vmax) < 1e-3, kmh + ' km/h 最高速变化');
  }
  P.setTuning({ spaceStep: P.DS });
});

test('电磁弹射确实打到目标速度', () => {
  arcade();
  for (const kmh of [100, 500, 1000, 3000, 10000]) {
    const r = P.simulate(built.long, { dt: 1 / 60, launchKmh: kmh });
    const want = kmh / 3.6;
    assert.ok(r.vmax >= want * 0.999, kmh + ' km/h 只到 ' + (r.vmax * 3.6).toFixed(0));
  }
});

test('街机阻力封顶在 220 km/h 以下与原公式逐位一致', () => {
  // 只改阻力帽、制动方式保持原作，隔离出「阻力封顶」这一个变量。
  P.setTuning({ dragCap: Infinity, brakeA: Infinity, subStep: P.SUB, spaceStep: P.DS });
  const real = P.simulate(built.gentle, { dt: 1 / 60, record: true });
  P.setTuning({ dragCap: P.DRAG_CAP_ARCADE });
  const arc = P.simulate(built.gentle, { dt: 1 / 60, record: true });
  assert.ok(real.vmax * 3.6 < 220, '这条轨道必须低于 220 km/h 才能验证等价性');
  assert.equal(arc.log.length, real.log.length);
  for (let i = 0; i < real.log.length; i++) {
    assert.equal(arc.log[i][1], real.log[i][1], '第 ' + i + ' 帧速度应逐位相同');
  }
});

test('限减速制动：终点仍然是轨道尽头，且两种制动力度都终止', () => {
  for (const a of [Infinity, P.BRAKE_A_ARCADE]) {
    P.setTuning({ dragCap: Infinity, brakeA: a, subStep: P.SUB, spaceStep: P.DS });
    const r = P.simulate(built.gentle, { dt: 1 / 60 });
    assert.equal(r.ended, true, '制动 ' + a);
    assert.equal(r.s, r.track.len);
    assert.ok(r.v >= 1.5 - 1e-9 && r.v <= 20, '入站速度 ' + r.v);
  }
});

test('长轨道 + 10000 km/h：街机模式全速冲过终点，真实模式被制动带吃掉', () => {
  arcade();
  const a = P.simulate(built.long, { dt: 1 / 60, launchKmh: 10000 });
  original();
  const b = P.simulate(built.long, { dt: 1 / 60, launchKmh: 10000 });
  assert.equal(a.ended, true); assert.equal(b.ended, true);
  assert.ok(a.v > 2000, '街机模式应当以近全速冲过终点，实测 ' + a.v.toFixed(0) + ' m/s');
  assert.ok(b.v < 20, '真实模式在最后 14 m 会被制动钳位，实测 ' + b.v.toFixed(2) + ' m/s');
});

test('所有场景都终止、无 NaN、s 单调不减、G 值有限', () => {
  for (const mode of ['arcade', 'original']) {
    for (const kmh of LAUNCHES) {
      (mode === 'arcade' ? arcade : original)();
      for (const key of Object.keys(built)) {
        const r = P.simulate(built[key], { dt: 1 / 60, launchKmh: kmh, record: true });
        const tag = mode + '/' + key + '/' + kmh;
        assert.equal(r.ended, true, tag + ' 未结束');
        assert.equal(r.faulted, false, tag + ' 触发 NaN 保护');
        assert.ok(Number.isFinite(r.t) && Number.isFinite(r.v), tag + ' 非有限值');
        assert.ok(Number.isFinite(r.gAbsMax) && r.gAbsMax >= 0, tag + ' G 值异常');
        for (let i = 1; i < r.log.length; i++) {
          assert.ok(r.log[i][0] >= r.log[i - 1][0] - 1e-9, tag + ' s 回退于第 ' + i + ' 帧');
          assert.ok(Number.isFinite(r.log[i][1]), tag + ' 第 ' + i + ' 帧速度为 NaN');
        }
      }
    }
  }
});

test('弹射段长度夹在 20–60 m，且不超过轨道本身', () => {
  P.setArcade(true);
  for (const kmh of [100, 10000]) {
    const long = P.simulate(built.long, { dt: 1 / 60, launchKmh: kmh });
    assert.ok(long.result.launchLen >= 20 && long.result.launchLen <= 60, '长轨 ' + long.result.launchLen);
    const gentle = P.simulate(built.gentle, { dt: 1 / 60, launchKmh: kmh });
    assert.ok(gentle.result.launchLen <= gentle.track.len + 1e-9, '短轨弹射段不得超过轨道长度');
  }
});

test('极短轨道配上大弹射：不会倒退、不会 NaN、仍然终止', () => {
  arcade();
  const tiny = P.buildControl([{ x: 0, y: 0 }, { x: 14, y: -5 }, { x: 30, y: 0 }], 60);
  const r = P.simulate(tiny, { dt: 1 / 60, launchKmh: 10000, record: true });
  assert.equal(r.ended, true);
  assert.equal(r.faulted, false);
  for (let i = 1; i < r.log.length; i++) assert.ok(r.log[i][0] >= r.log[i - 1][0] - 1e-9, 's 回退');
});

test('步长无关性：dt 从 1/60 收到 1/240，用时变化小于 0.1%', () => {
  arcade();
  for (const kmh of [0, 1000, 10000]) {
    const a = P.simulate(built.long, { dt: 1 / 60, launchKmh: kmh });
    const b = P.simulate(built.long, { dt: 1 / 240, launchKmh: kmh });
    assert.ok(Math.abs(b.t - a.t) / a.t < 1e-3, kmh + ' km/h: ' + a.t + ' vs ' + b.t);
  }
});
