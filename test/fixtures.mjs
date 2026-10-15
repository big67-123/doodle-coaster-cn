// 测试用轨道：先生成密集折线（模拟"手绘"），再走 buildControl → buildTrack，与真实链路一致。
export function rawTrack(len, hill, n = 400) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = t * len;
    const y = -hill * Math.sin(Math.PI * t) * (0.7 + 0.3 * Math.sin(6 * t));
    pts.push({ x, y });
  }
  return pts;
}

export const FIX = {
  gentle: { label: '缓坡 300m/60m', raw: rawTrack(300, 60), ground: 90 },
  steep: { label: '陡降 900m/400m', raw: rawTrack(900, 400), ground: 460 },
  long: { label: '长轨 2000m/200m', raw: rawTrack(2000, 200), ground: 260 },
};

export const LAUNCHES = [0, 100, 500, 1000, 3000, 10000];
