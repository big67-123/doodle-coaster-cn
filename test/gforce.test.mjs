import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../physics.js');
const G0 = 9.81;
const TAU = .06;   // physics.js 里 G 读数的低通时间常数

/* G 值的定义（physics.js 第 216-219 行）：
     gz = (运动学加速度 − 重力) 投影到乘客的"上"轴 ÷ g₀
   切向加速度与"上"轴正交，所以它被完全约掉，剩下：
     gz = sigma·tx  +  sigma·(kx·ty − ky·tx)·v²/G
   平直轨道 tx=1、曲率 0 → 恰好 1；山谷曲率朝向与"上"轴一致 → 加项为正；山脊为负。
   为负即失重。读数再经过 τ=0.06 秒一阶低通（原作就有，用来压手绘抖动的毛刺），
   所以「正在快速变化的 G」会被滞后 τ·|dG/dt| —— 下面按机理断言，而不是拍一个容差。 */

// 定半径圆弧：先一段直线（在它上面弹射到目标速度），再接一段恒定曲率的圆。
// sign = +1 山谷（凹向上，向心朝上）；-1 山脊（凸向上，向心朝下）。
// 圆在 h = R 处水平切入，直线段放在同一高度，且按 1 m 布点 —— 步长不一致会在接缝处引入
// 折线伪影，那是测试装置的毛病，不是物理的。
function arcCtrl(R, deg, sign, flatLen, ground) {
  const n = 160, pts = [];
  for (let i = 0; i <= flatLen; i++) pts.push({ x: i, y: ground - R });
  for (let i = 1; i <= n; i++) {
    const a = -sign * Math.PI / 2 + sign * (deg * Math.PI / 180) * (i / n);
    pts.push({ x: flatLen + R * Math.cos(a), y: ground - (R * (1 + sign) + R * Math.sin(a)) });
  }
  return { ctrl: pts, arcFrom: flatLen, arcLen: R * deg * Math.PI / 180 };
}
const arc = (R, deg, sign) => arcCtrl(R, deg, sign, 300, 2 * R + 30);

// 解析解。重力沿乘客"上"轴的分量是 sigma·tx（tx = cosθ，坡上不再是 1），
// 向心项按曲率朝向取正负。
function runArc(R, deg, sign, launchKmh) {
  const a = arc(R, deg, sign);
  const t = P.buildTrack(a.ctrl);
  P.setArcade(true);
  const r = P.simulate(a.ctrl, { launchKmh, dt: 1 / 480, record: true });
  const analyticAt = e => t.sigma * P.sample(t, e[0]).tx + sign * (e[1] * e[1] / (R * G0));
  return { a, t, log: r.log, analyticAt };
}
const devOf = (run, e) => Math.abs(e[2] - run.analyticAt(e));
const devOk = (run, e) => devOf(run, e) < Math.max(.2, .015 * Math.abs(run.analyticAt(e)));
function arcFrames(run, lo, hi) {
  const s0 = run.a.arcFrom + run.a.arcLen * lo, s1 = run.a.arcFrom + run.a.arcLen * hi;
  return run.log.filter(e => e[0] >= s0 && e[0] <= s1);
}

test('平直轨道上 G 恒等于 1：除了体重没有别的载荷', () => {
  P.setArcade(true);
  const flat = [];
  for (let i = 0; i <= 400; i++) flat.push({ x: i, y: 30 });
  const r = P.simulate(flat, { dt: 1 / 240, record: true });
  assert.ok(r.log.length > 10);
  for (const [, , g] of r.log) assert.ok(Math.abs(g - 1) < 1e-9, '平直段出现 G=' + g);
});

test('圆弧上的 G 等于解析解 sigma·tx ± v²/(R·g₀)，残差正好是低通滞后 τ·|dG/dt|', () => {
  for (const R of [200, 120, 60]) {
    for (const [sign, name] of [[1, '山谷'], [-1, '山脊']]) {
      const run = runArc(R, 70, sign, 400);
      // 取弧后段：入弧是个 ~19 G 的阶跃，低通要 ~7τ（0.42 s）才衰减到可忽略，
      // 前段取样会把阶跃残余误算成公式误差。
      const fr = arcFrames(run, .6, .9);
      assert.ok(fr.length > 5, R + ' m ' + name + ' 取样帧太少');
      let worstRatio = 0, worstExcess = 0, worstDev = 0;
      for (let i = 1; i < fr.length; i++) {
        // 帧长（1/480 s）小于子步长时会有帧完全不推进位置，跳过它们，否则差分是 0/0
        if (fr[i][0] <= fr[i - 1][0]) continue;
        const dt = (fr[i][0] - fr[i - 1][0]) / ((fr[i][1] + fr[i - 1][1]) / 2);
        const rate = Math.abs(run.analyticAt(fr[i]) - run.analyticAt(fr[i - 1])) / dt;
        const pred = TAU * rate;
        const dev = devOf(run, fr[i]);
        worstDev = Math.max(worstDev, dev);
        worstRatio = Math.max(worstRatio, dev / Math.max(.02, pred));
        worstExcess = Math.max(worstExcess, dev - pred);
      }
      const tag = R + ' m ' + name + '（最大偏差 ' + worstDev.toFixed(3) + ' G）';
      assert.ok(worstRatio < 1.35, tag + ' 偏差达到预测滞后的 ' + worstRatio.toFixed(2) + ' 倍，说明不止有滤波滞后');
      assert.ok(worstExcess < .06, tag + ' 扣掉滤波滞后后仍差 ' + worstExcess.toFixed(3) + ' G');
    }
  }
});

test('低通滤波的追赶是有限且会收敛的（如实记录，不是掩盖）', () => {
  const run = runArc(120, 70, +1, 400);
  const a = run.a;
  const inArc = run.log.filter(e => e[0] >= a.arcFrom && e[0] <= a.arcFrom + a.arcLen);
  const i0 = inArc.findIndex(e => devOk(run, e));
  assert.ok(i0 > 0, '入弧瞬间不该已经追平，否则说明读数没有低通');
  const frac = (inArc[i0][0] - a.arcFrom) / a.arcLen;
  assert.ok(frac < .35, '应当在弧的前 35% 内收敛到 1%，实际 ' + (frac * 100).toFixed(0) + '%');
  for (let i = 0; i < i0; i++) assert.ok(inArc[i][2] < run.analyticAt(inArc[i]) + .05, '追赶期间出现过冲');
});

test('曲率平滑没有把曲率抹掉：|k| 与 1/R 一致', () => {
  for (const R of [30, 60, 120, 200]) {
    const a = arc(R, 70, +1);
    const t = P.buildTrack(a.ctrl);
    const s0 = a.arcFrom + a.arcLen * .3, s1 = a.arcFrom + a.arcLen * .7;
    let sum = 0, n = 0;
    for (let i = 0; i < t.n; i++) {
      const s = i * P.DS;
      if (s < s0 || s > s1) continue;
      sum += Math.hypot(t.kx[i], t.ky[i]); n++;
    }
    assert.ok(n > 5, R + ' m 取样太少');
    const ratio = (sum / n) * R;
    assert.ok(Math.abs(ratio - 1) < .01, R + ' m 的 |k|·R = ' + ratio.toFixed(4) + '，应当接近 1');
  }
});

test('负 G 只在凸曲率（山脊 / 立环顶端）出现 —— 那是失重，不是故障', () => {
  const valley = arcFrames(runArc(120, 70, +1, 400), .3, .7);
  const crest = arcFrames(runArc(120, 70, -1, 400), .3, .7);
  assert.ok(Math.min(...valley.map(e => e[2])) > 0, '山谷不该出现负 G');
  assert.ok(Math.min(...crest.map(e => e[2])) < 0, '山脊应当出现负 G（失重）');
});

test('山脊上速度越快负得越多：负 G 随 v² 增长', () => {
  const minOf = (kmh) => Math.min(...arcFrames(runArc(120, 70, -1, kmh), .3, .7).map(e => e[2]));
  const slow = minOf(200), fast = minOf(700);
  assert.ok(slow < 0 && fast < 0);
  assert.ok(fast < slow, '700 km/h 的负 G（' + fast.toFixed(2) + '）应当比 200 km/h（' + slow.toFixed(2) + '）更强');
});
