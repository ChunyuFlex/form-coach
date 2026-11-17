// ===== 動作分析核心（純運算，無 DOM）=====
const Core = (() => {
  const TOP = 0.85, BOT = 0.25, BOT_OUT = 0.4, MIN_RANGE = 0.3; // BOT_OUT：離開底部要超過這個值，避免底部抖動誤判 // 以軀幹長度為單位
  const SIDES = { L: [11, 13, 23], R: [12, 14, 24] }, WRIST = { L: 15, R: 16 };
  const med = a => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };

  // 從一格的關節點取出左右兩側的「手肘相對肩膀的高度」(像素) 與軀幹長度
  function sample(lm, W, H) {
    const o = {};
    for (const k in SIDES) {
      const [s, e, h] = SIDES[k].map(i => lm[i]);
      const w = lm[WRIST[k]], v1 = [(s.x - e.x) * W, (s.y - e.y) * H], v2 = [(w.x - e.x) * W, (w.y - e.y) * H];
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
      o[k] = {
        ang: Math.min(s.visibility ?? 0, e.visibility ?? 0, w.visibility ?? 0) > 0.5 ? Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI : null,
        v: (s.y - e.y) * H,
        vis: Math.min(s.visibility ?? 0, e.visibility ?? 0),
        torso: (h.visibility ?? 0) > 0.3 ? Math.hypot((s.x - h.x) * W, (s.y - h.y) * H) : null
      };
    }
    return o;
  }

  // 人在畫面裡的大小（像素）：肩寬與兩側軀幹長度取最大
  function size(lm, W, H) {
    const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * W, (lm[a].y - lm[b].y) * H);
    return Math.max(d(11, 12), d(11, 23), d(12, 24));
  }
  // 這一格是否真的看到人：至少一側的肩、肘看得清楚，而且人不能小到不合理（背景雜物誤判）
  function valid(lm, W, H) {
    const v = i => lm[i].visibility ?? 0;
    if (Math.max(Math.min(v(11), v(13)), Math.min(v(12), v(14))) < 0.6) return false;
    return size(lm, W, H) >= 0.08 * Math.min(W, H);
  }
  // 兩肩中點（像素）與人的大小，用來判斷是否已就位不動
  function center(lm, W, H) { return { x: (lm[11].x + lm[12].x) / 2 * W, y: (lm[11].y + lm[12].y) / 2 * H, size: size(lm, W, H) }; }

  // buf: [{t(秒), L:{v,vis,torso}, R:{...}}]
  function analyze(buf) {
    const out = { ok: false, count: 0, reps: [], phase: 'bot', s: 0, side: 'L', vis: 0 };
    if (buf.length < 5) return out;
    const sum = k => buf.reduce((a, f) => a + f[k].vis, 0);
    const side = sum('L') >= sum('R') ? 'L' : 'R';
    out.side = side; out.vis = buf[buf.length - 1][side].vis;
    const torsos = buf.map(f => f[side].torso).filter(x => x);
    if (!torsos.length) return out;
    const torso = med(torsos);
    const raw = buf.map(f => f[side].v / torso);
    const n = raw.length, sig = new Array(n);
    for (let i = 0; i < n; i++) sig[i] = med(raw.slice(Math.max(0, i - 2), Math.min(n, i + 3)));
    let lo = Infinity, hi = -Infinity;
    for (const x of sig) { if (x < lo) lo = x; if (x > hi) hi = x; }
    const R = hi - lo;
    out.s = R > 1e-6 ? (sig[n - 1] - lo) / R : 0;
    if (R < MIN_RANGE) return out;
    out.ok = true;
    let st = (sig[0] - lo) / R >= TOP ? 'top' : 'bot', cur = null, upStart = null, botStart = null, topEnd = null, downIdx = 0;
    const reps = [];
    if (st === 'top') { cur = { up: null, tTop: buf[0].t, top: null, down: null, bottom: null, elbow: null }; reps.push(cur); }
    for (let i = 1; i < n; i++) {
      const s = (sig[i] - lo) / R, t = buf[i].t;
      // 中間超過 1 秒沒看到人：不把前後接起來當成一下，從底部重新開始
      if (t - buf[i - 1].t > 1 && st !== 'bot') { st = 'bot'; botStart = null; if (cur) delete cur._pause; }
      if (st === 'bot') {
        if (s > BOT_OUT) { st = 'up'; upStart = t; if (cur && botStart != null && cur.bottom == null) cur._pause = t - botStart; }
      } else if (st === 'up') {
        if (s >= TOP) {
          st = 'top';
          if (cur && cur._pause != null) cur.bottom = cur._pause;
          cur = { up: t - upStart, tTop: t, top: null, down: null, bottom: null, elbow: null }; reps.push(cur);
        } else if (s <= BOT) { st = 'bot'; if (cur) delete cur._pause; }
      } else if (st === 'top') {
        if (s < TOP) { st = 'down'; topEnd = t; downIdx = i; cur.top = t - cur.tTop; }
      } else if (st === 'down') {
        if (s <= BOT) {
          st = 'bot'; botStart = t; cur.down = t - topEnd;
          // 手肘角度：取下放後半段（手臂接近地面時）兩手的中位數
          const a = [];
          for (let j = Math.floor((downIdx + i) / 2); j <= i; j++) for (const k of ['L', 'R']) if (buf[j][k].ang != null) a.push(buf[j][k].ang);
          cur.elbow = a.length ? med(a) : null;
        }
        else if (s >= TOP) { st = 'top'; cur.top = null; }
      }
    }
    out.phase = st; out.reps = reps; out.count = reps.length;
    return out;
  }

  const avg = (reps, k) => { const a = reps.map(r => r[k]).filter(x => x != null); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };
  // 下放速度評級
  const grade = d => d == null ? null : d < 1.0 ? 'fast' : d < 1.8 ? 'mid' : 'good';
  // 飛鳥的手肘角度評級：>165° 鎖死、140–165° 微彎（理想）、<140° 彎太多
  const gradeElbow = a => a == null ? null : a > 165 ? 'lock' : a >= 140 ? 'good' : 'bent';
  return { sample, valid, center, analyze, avg, grade, gradeElbow, TOP, BOT };
})();
if (typeof module !== 'undefined') module.exports = Core;
