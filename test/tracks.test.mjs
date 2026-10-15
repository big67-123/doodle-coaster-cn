import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('../tracks.js');
const P = require('../physics.js');

const good = () => ({ id: 'x', name: '测试', ground: 70, launch: 300, points: [[0, 0], [30, 30], [60, 5], [90, 0]] });

test('内置轨道全部通过校验', () => {
  assert.ok(T.TRACKS.length >= 1);
  for (const d of T.TRACKS) {
    const v = T.validate(d);
    assert.equal(v.ok, true, d.id + ': ' + JSON.stringify(v.errors));
  }
});

test('内置轨道全部能跑完（街机与真实两种阻力都不 NaN）', () => {
  for (const d of T.TRACKS) {
    const v = T.validate(d);
    for (const mode of ['arcade', 'real']) {
      if (mode === 'arcade') P.setArcade(true); else { P.setArcade(false); }
      const r = P.simulate(v.norm.ctrl, { dt: 1 / 60, launchKmh: v.norm.launch });
      assert.equal(r.ended, true, d.id + '/' + mode + ' 未跑完');
      assert.equal(r.faulted, false, d.id + '/' + mode + ' 触发 NaN 保护');
      assert.ok(r.vmax > 0 && Number.isFinite(r.gAbsMax), d.id + '/' + mode + ' 数值异常');
    }
  }
});

test('立环轨道的环路首尾闭合', () => {
  const loop = T.TRACKS.find(d => d.id === 'vertical-loop');
  const pts = loop.points;
  const c = pts.findIndex(p => Math.abs(p[1] - (40 - 22)) < 1e-6 && Math.abs(p[0] - 112) < 1e-6);
  assert.ok(c > 0, '找得到环路起点');
  assert.ok(Math.abs(pts[c + 14][0] - pts[c][0]) < 1e-6, '环路过 14 步后回到同一个 x');
  assert.ok(Math.abs(pts[c + 14][1] - pts[c][1]) < 1e-6, '环路过 14 步后回到同一个 h');
});

test('校验器：各种坏输入都给出对应的错误码', () => {
  const cases = [
    [null, 'not-object'], ['字符串', 'not-object'], [[], 'not-object'],
    [{ ...good(), id: '' }, 'bad-id'],
    [{ ...good(), id: 'a b/c' }, 'bad-id'],
    [{ ...good(), points: 'nope' }, 'bad-points'],
    [{ ...good(), points: [[0, 0], [1, 1]] }, 'too-few-points'],
    [{ ...good(), points: [[0, 0], [1, 1], [2, 'x']] }, 'bad-number'],
    [{ ...good(), points: [[0, 0], [1, 1], 'x'] }, 'bad-point'],
    [{ ...good(), points: [[0, 0], [1, 1], [2, 2]] }, 'too-short'],
    [{ ...good(), launch: 50 }, 'bad-launch'],
    [{ ...good(), launch: 20000 }, 'bad-launch'],
    [{ ...good(), launch: 'fast' }, 'bad-launch'],
    [{ ...good(), ground: 2 }, 'bad-ground'],
  ];
  for (const [def, code] of cases) {
    const v = T.validate(def);
    assert.equal(v.ok, false, JSON.stringify(def) + ' 本应被拒绝');
    assert.ok(v.errors.some(e => e.code === code), JSON.stringify(def) + ' 期望错误码 ' + code + '，实际 ' + JSON.stringify(v.errors.map(e => e.code)));
  }
});

test('校验器：伸到地面以下的点被贴回地面并给出警告', () => {
  const v = T.validate({ ...good(), points: [[0, 0], [30, 30], [60, -40], [90, 0]] });
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some(w => w.code === 'clamped'), JSON.stringify(v.warnings));
  assert.equal(v.norm.stats.low, T.LIMITS.minHeight);
  // 贴地是允许的，不该报错
  const ok = T.validate({ ...good(), points: [[0, 0], [30, 30], [60, 0], [90, 0]] });
  assert.equal(ok.ok, true);
  assert.equal(ok.warnings.length, 0, JSON.stringify(ok.warnings));
});

test('校验器：连续重复点被去掉', () => {
  const v = T.validate({ ...good(), points: [[0, 0], [0, 0], [30, 30], [60, 5], [90, 0]] });
  assert.equal(v.ok, true);
  assert.equal(v.norm.stats.points, 4);
  assert.ok(v.warnings.some(w => w.code === 'dedup'));
});

test('校验器：好输入被转成世界坐标（y 向下）', () => {
  const def = good();
  const v = T.validate(def);
  assert.equal(v.ok, true);
  assert.equal(v.norm.ctrl.length, 4);
  // 离地高度 30 -> 世界坐标 y = ground - h
  assert.equal(v.norm.ctrl[1].y, 70 - 30);
  assert.equal(v.norm.ctrl[0].y, 70);
  assert.deepEqual(v.norm.stats.length, Math.round(v.norm.stats.length * 100) / 100);
});

test('校验器：launch 为 0 / 缺省都表示不弹射', () => {
  for (const launch of [undefined, null, 0]) {
    const d = good(); if (launch === undefined) delete d.launch; else d.launch = launch;
    const v = T.validate(d);
    assert.equal(v.ok, true);
    assert.equal(v.norm.launch, 0);
  }
});

test('超出上限的控制点数被拒绝', () => {
  const pts = [];
  for (let i = 0; i < T.LIMITS.maxPoints + 5; i++) pts.push([i * 2, 0]);
  const v = T.validate({ ...good(), points: pts });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => e.code === 'too-many-points'));
});
