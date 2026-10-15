// tracks.js -- 轨道定义槽 + 校验器。
//
// 【坐标系】points 用 [x, h]：x = 距起点的米数，h = 离地高度（向上为正，单位米，最低 0）。
// 这样写轨道时不用关心画布高度；加载时会转成世界坐标 y = ground - h。
// points 就是 Catmull-Rom 的控制点本身，不做额外平滑 —— 作者放哪，轨道就过哪。
//
// 【加一条轨道】在下面的数组里追加一项，保存，刷新页面即可在「轨道工坊 → 我的轨道」看到。
// 只想快速试一条：把它粘进页内工坊的「粘贴 JSON」文本框，校验通过就能试跑。
//
// 同时以经典 <script> 加载（file:// 也能用）和 require() 被 Node 测试导入。
(() => {
'use strict';

const LIMITS = {
  minPoints: 3, maxPoints: 400,
  minLength: 25, maxLength: 20000,     // 米
  minLaunch: 100, maxLaunch: 10000,    // km/h
  maxGround: 5000,
  minHeight: 0,                        // 离地高度下限：0 = 正好贴地，负数会夹回 0
};

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/* 把任意输入变成可用的轨道；失败时给出一串中文错误。三处入口（文件槽/粘贴/编辑器）都走这里。 */
function validate(def, opts = {}) {
  const errors = [], warnings = [];
  const E = (code, msg) => { errors.push({ code, msg }); };
  const W = (code, msg) => { warnings.push({ code, msg }); };

  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    E('not-object', '轨道定义必须是一个对象。');
    return { ok: false, errors, warnings, norm: null };
  }

  const id = typeof def.id === 'string' && def.id.trim() ? def.id.trim() : null;
  if (!id) E('bad-id', '缺少 id（一串英文/数字标识，用来区分轨道）。');
  else if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) E('bad-id', 'id 只能用字母、数字、下划线和连字符，且不超过 64 个字符。');

  const name = typeof def.name === 'string' && def.name.trim() ? def.name.trim() : (id || '未命名');
  let ground = isNum(def.ground) ? def.ground : 70;
  if (!isNum(def.ground)) W('default-ground', '没写 ground，已按地面高度 70 米处理。');
  else if (ground <= 5 || ground > LIMITS.maxGround) E('bad-ground', 'ground 必须在 5 到 ' + LIMITS.maxGround + ' 米之间。');

  let launch = 0;
  if (def.launch === undefined || def.launch === null || def.launch === 0) launch = 0;
  else if (!isNum(def.launch)) E('bad-launch', 'launch 必须是数字（弹射速度，km/h）。');
  else if (def.launch < LIMITS.minLaunch || def.launch > LIMITS.maxLaunch) E('bad-launch', 'launch 必须在 ' + LIMITS.minLaunch + ' 到 ' + LIMITS.maxLaunch + ' km/h 之间。');
  else launch = Math.round(def.launch);

  if (!Array.isArray(def.points)) { E('bad-points', 'points 必须是一个数组，每项形如 [x, h]。'); return { ok: false, errors, warnings, norm: null }; }
  if (def.points.length < LIMITS.minPoints) E('too-few-points', '至少需要 ' + LIMITS.minPoints + ' 个控制点，现在只有 ' + def.points.length + ' 个。');
  if (def.points.length > LIMITS.maxPoints) E('too-many-points', '控制点最多 ' + LIMITS.maxPoints + ' 个，现在有 ' + def.points.length + ' 个。');

  const pts = [];
  let clamped = 0;
  for (let i = 0; i < def.points.length; i++) {
    const p = def.points[i];
    if (!Array.isArray(p) || p.length < 2) { E('bad-point', '第 ' + (i + 1) + ' 个控制点不是 [x, h] 形式。'); continue; }
    const x = p[0], h = p[1];
    if (!isNum(x) || !isNum(h)) { E('bad-number', '第 ' + (i + 1) + ' 个控制点含有不是数字的内容。'); continue; }
    let hh = h;
    if (hh < LIMITS.minHeight) { hh = LIMITS.minHeight; clamped++; }
    pts.push([x, hh]);
  }
  if (clamped) W('clamped', '有 ' + clamped + ' 个点伸到地面以下，已贴回地面。');

  // 去掉连续重复点
  const dedup = [];
  for (const p of pts) {
    const q = dedup[dedup.length - 1];
    if (q && Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - p[1]) < 1e-6) continue;
    dedup.push(p);
  }
  if (dedup.length < LIMITS.minPoints) E('too-few-points', '去掉重复点后不足 ' + LIMITS.minPoints + ' 个控制点。');
  if (dedup.length !== pts.length && !clamped) W('dedup', '已忽略 ' + (pts.length - dedup.length) + ' 个连续重复点。');

  let len = 0;
  for (let i = 1; i < dedup.length; i++) len += Math.hypot(dedup[i][0] - dedup[i - 1][0], dedup[i][1] - dedup[i - 1][1]);
  if (len < LIMITS.minLength) E('too-short', '轨道总长只有 ' + len.toFixed(1) + ' 米，至少需要 ' + LIMITS.minLength + ' 米。');
  if (len > LIMITS.maxLength) E('too-long', '轨道总长 ' + len.toFixed(0) + ' 米，超过上限 ' + LIMITS.maxLength + ' 米。');

  if (errors.length) return { ok: false, errors, warnings, norm: null };

  // 转成世界坐标：屏幕上 y 向下，所以 y = ground - h
  const ctrl = dedup.map(p => ({ x: p[0], y: ground - p[1] }));
  const hs = dedup.map(p => p[1]);
  const norm = {
    id, name, ground, launch,
    note: typeof def.note === 'string' ? def.note : '',
    points: dedup, ctrl,
    stats: { length: +len.toFixed(2), peak: +Math.max(...hs).toFixed(2), low: +Math.min(...hs).toFixed(2), points: dedup.length },
  };
  if (launch > 0 && len < 60) W('short-launch', '轨道偏短，弹射段会被压得很短，弹射效果不明显。');
  return { ok: true, errors, warnings, norm };
}

/* ---------- 内置轨道 ---------- */
// 一圈立环的控制点：中心 (cx, ch)，半径 r，进入方向 +x
function loopPoints(cx, ch, r, n = 14) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([+(cx + r * Math.sin(a)).toFixed(3), +(ch - r * Math.cos(a)).toFixed(3)]);
  }
  return out;
}

const OLC_TRACKS = [
  {
    id: 'thunder', name: '雷鸣号', ground: 70, launch: 0,
    note: '先缓缓爬升，再从 58 米高处一头扎下来 —— 新手先坐这条。',
    points: [[0, 0], [14, 3], [34, 20], [58, 44], [82, 58], [106, 42], [126, 16], [142, 4], [158, 2], [178, 18], [200, 34], [220, 20], [238, 3], [252, 0]],
  },
  {
    id: 'horizon', name: '地平线', ground: 90, launch: 0,
    note: '一条 400 米的连绵长坡，专治「重力起步太慢」。',
    points: [[0, 0], [22, 6], [50, 30], [80, 52], [110, 46], [138, 22], [166, 6], [196, 26], [226, 52], [256, 58], [286, 34], [316, 10], [346, 6], [376, 28], [400, 20], [418, 4], [432, 0]],
  },
  {
    id: 'vertical-loop', name: '死亡螺旋', ground: 80, launch: 150,
    note: '带一个 22 米半径的完整立环。想体验弹射就把工坊里的滑杆往右拉。',
    points: [
      [0, 0], [20, 2], [45, 8], [68, 14],
      [88, 17],
      ...loopPoints(112, 40, 22),
      [136, 17], [156, 10], [176, 4], [192, 0],
    ],
  },
];

const api = { LIMITS, validate, loopPoints, TRACKS: OLC_TRACKS };
if (typeof window !== 'undefined') { window.OLC_TRACKS = OLC_TRACKS; window.OLC_TRACKS_API = api; }
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
