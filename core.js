// ===== 動作分析核心（純運算，無 DOM）=====
const Core = (() => {
  // 以「這一下自己的最低點～最高點」為 0～1：TOP 以上算頂端、BOT 以下算回到底部、離開底部要超過 BOT_OUT
  // MIN_RANGE：一下至少要有多大的幅度（單位：軀幹長度），太小的當成晃動
  const TOP = 0.85, BOT = 0.25, BOT_OUT = 0.4, MIN_RANGE = 0.18;
  const SIDES = { L: [11, 13, 23], R: [12, 14, 24] }, WRIST = { L: 15, R: 16 };
  const med = a => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };

  // 從一格的關節點取出左右兩側的「手肘相對肩膀的高度」(像素) 與軀幹長度
  function sample(lm, W, H) {
    const o = { sw: Math.hypot((lm[11].x - lm[12].x) * W, (lm[11].y - lm[12].y) * H) }; // 肩寬（看不到髖部時當作尺度）
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

  // 手肘張開角度：上臂（肩→肘）與軀幹（肩→髖）的夾角（度）。
  // 用模型估計的 3D 座標（world landmarks）算，所以不受拍攝角度影響；lm 只用來看可見度
  function flare(wl, lm) {
    // 回傳每一側 { abd: 張開角度, elev: 手肘比肩膀高幾度（躺著時往天花板為正；負的表示手肘沉到肩膀以下）}
    const o = { L: null, R: null };
    if (!wl) return o;
    // 軀幹方向用「兩肩中點 → 兩髖中點」（單側的肩→髖會往內斜，角度會偏大）
    const mid = (i, j, c) => (wl[i][c] + wl[j][c]) / 2, C3 = ['x', 'y', 'z'];
    const ms = C3.map(c => mid(11, 12, c)), b = C3.map((c, i) => mid(23, 24, c) - ms[i]);
    // 胸口朝向（身體正面的法線）= 肩線 × 軀幹方向；用鼻子在哪一側決定正負
    const ac = C3.map(c => wl[11][c] - wl[12][c]);
    let nrm = [ac[1] * b[2] - ac[2] * b[1], ac[2] * b[0] - ac[0] * b[2], ac[0] * b[1] - ac[1] * b[0]];
    const nl = Math.hypot(...nrm) || 1; nrm = nrm.map(x => x / nl);
    if (C3.reduce((s, c, i) => s + (wl[0][c] - ms[i]) * nrm[i], 0) < 0) nrm = nrm.map(x => -x);
    for (const k in SIDES) {
      const [s, e] = SIDES[k], v = i => lm[i].visibility ?? 0;
      if (Math.min(v(s), v(e)) < 0.5 || Math.min(v(23), v(24)) < 0.3) continue;
      const a = [wl[e].x - wl[s].x, wl[e].y - wl[s].y, wl[e].z - wl[s].z], al = Math.hypot(...a) || 1;
      const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (al * Math.hypot(...b) || 1);
      o[k] = {
        abd: Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI,
        elev: Math.asin(Math.max(-1, Math.min(1, (a[0] * nrm[0] + a[1] * nrm[1] + a[2] * nrm[2]) / al))) * 180 / Math.PI
      };
    }
    return o;
  }

  // 人在畫面裡的大小（像素）：肩寬與兩側軀幹長度取最大
  function size(lm, W, H) {
    const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * W, (lm[a].y - lm[b].y) * H);
    return Math.max(d(11, 12), d(11, 23), d(12, 24));
  }
  // 這一格是否真的看到人：至少一側的肩、肘看得清楚（可見度 ≥ minVis），而且人不能小到不合理（背景雜物誤判）
  function valid(lm, W, H, minVis = 0.6) {
    const v = i => lm[i].visibility ?? 0;
    if (Math.max(Math.min(v(11), v(13)), Math.min(v(12), v(14))) < minVis) return false;
    return size(lm, W, H) >= 0.08 * Math.min(W, H);
  }
  // 兩肩中點（像素）與人的大小，用來判斷是否已就位不動
  function center(lm, W, H) { return { x: (lm[11].x + lm[12].x) / 2 * W, y: (lm[11].y + lm[12].y) / 2 * H, size: size(lm, W, H) }; }

  // buf: [{t(秒), L:{v,vis,torso,ang,abd}, R:{...}}]
  // 做法：先找出訊號的轉折點（低點、高點交替），每個「低→高→低」是一下。
  // 每一下用自己的低點、高點當基準，所以某一下特別大（或起身、調整姿勢）不會讓其他下被漏掉。
  function analyze(buf) {
    const out = { ok: false, count: 0, reps: [], phase: 'bot', s: 0, side: 'L', vis: 0 };
    const n = buf.length;
    if (n < 5) return out;
    const sum = k => buf.reduce((a, f) => a + f[k].vis, 0);
    const side = sum('L') >= sum('R') ? 'L' : 'R';
    out.side = side; out.vis = buf[n - 1][side].vis;
    const torsos = buf.map(f => f[side].torso).filter(x => x);
    // 看不到髖部（例如被臥推椅或啞鈴擋住）時，用肩寬 × 1.5 當作軀幹長度
    const sws = buf.map(f => f.sw).filter(x => x);
    if (!torsos.length && !sws.length) return out;
    const torso = torsos.length ? med(torsos) : 1.5 * med(sws), raw = buf.map(f => f[side].v / torso), sig = new Array(n), T = i => buf[i].t;
    for (let i = 0; i < n; i++) sig[i] = med(raw.slice(Math.max(0, i - 2), Math.min(n, i + 3)));
    const sorted = [...sig].sort((a, b) => a - b), q = p => sorted[Math.min(n - 1, Math.floor(p * n))], span = sorted[n - 1] - sorted[0];
    out.s = span > 1e-6 ? (sig[n - 1] - sorted[0]) / span : 0;
    out.ok = span >= MIN_RANGE;

    // 1) 轉折點：反向移動超過 DELTA 才算換方向（DELTA 跟著動作幅度調整，但不被單一特大動作綁架）
    const DELTA = Math.max(0.08, 0.3 * (q(0.9) - q(0.1)), 0.12 * span);
    const ext = []; let dir = 0, loI = 0, hiI = 0; // dir：1 = 正在上升（找高點）、-1 = 正在下降（找低點）
    for (let i = 1; i < n; i++) {
      if (dir >= 0 && sig[i] > sig[hiI]) hiI = i;
      if (dir <= 0 && sig[i] < sig[loI]) loI = i;
      if (dir <= 0 && sig[i] - sig[loI] >= DELTA) { ext.push({ i: loI, hi: false }); dir = 1; hiI = i; }
      else if (dir >= 0 && sig[hiI] - sig[i] >= DELTA) { ext.push({ i: hiI, hi: true }); dir = -1; loI = i; }
    }

    // 2) 每個高點是一下的候選：prev = 前一個低點、next = 後一個低點（還在下降中的話先用目前最低點）
    const cands = [];
    ext.forEach((e, k) => {
      if (!e.hi) return;
      const prev = k > 0 ? ext[k - 1].i : null, nx = k + 1 < ext.length ? ext[k + 1].i : (dir === -1 ? loI : null);
      cands.push({ p: e.i, prev, next: nx, tail: k + 1 >= ext.length, amp: prev != null ? sig[e.i] - sig[prev] : nx != null ? sig[e.i] - sig[nx] : 0 });
    });
    const amps = cands.map(c => c.amp), A = amps.length ? med(amps) : null; // 一般的一下有多大
    const need = Math.max(MIN_RANGE, A ? 0.5 * A : 0);
    const tooBig = amp => amps.length >= 3 && amp > 2.5 * A; // 比一般的一下大很多：是起身或調整姿勢，不是一下
    let list = cands.filter(c => c.amp >= need && !tooBig(c.amp));
    // 還在上升中的這一下：升得夠高就先算（即時顯示與語音需要在「到頂」時就知道）
    if (dir === 1 && ext.length) {
      const prev = ext[ext.length - 1].i, rise = sig[hiI] - sig[prev];
      if (rise >= Math.max(MIN_RANGE, A ? 0.85 * A : 0) && !tooBig(rise)) list.push({ p: hiI, prev, next: null, tail: true, amp: rise, prov: true });
    }

    // 3) 每一下的時間：上舉、頂端、下放，以及下放後半段的手肘角度／張開角度
    const gap = (a, b) => { for (let j = a + 1; j <= b; j++) if (T(j) - T(j - 1) > 1) return true; return false; }; // 中間超過 1 秒沒看到人
    const reps = [];
    for (const c of list) {
      const hiV = sig[c.p], r = { up: null, tTop: T(0), top: null, down: null, bottom: null, elbow: null, flare: null, depth: null };
      let reach = 0;
      if (c.prev != null) {
        const lo0 = sig[c.prev], R0 = hiV - lo0;
        let us = c.p; while (us > c.prev && (sig[us] - lo0) / R0 > BOT_OUT) us--;      // 離開底部
        reach = us; while (reach < c.p && (sig[reach] - lo0) / R0 < TOP) reach++;       // 到頂
        if (gap(us, c.p)) continue;
        // 量到的是「離開底部(40%)→到頂(85%)」這一段，只佔整個行程的 45%，換算成整段上舉的時間
        r._us = us; r.up = (T(reach) - T(us)) / (TOP - BOT_OUT); r.tTop = T(reach);
      }
      if (c.next != null) {
        // 下放的基準低點：已確定的用實際低點；還在下放中就先假設會回到上一次的低點
        const lo1 = !c.tail ? sig[c.next] : c.prev != null ? Math.min(sig[c.prev], sig[c.next]) : sig[c.next], R1 = hiV - lo1;
        const end = c.tail ? n - 1 : c.next;
        let lv = c.p; while (lv < end && (sig[lv] - lo1) / R1 >= TOP) lv++;               // 離開頂端
        if (R1 > 0 && (sig[lv] - lo1) / R1 < TOP && !gap(c.p, lv)) {
          r.top = T(lv) - r.tTop;
          let rb = lv; while (rb < end && (sig[rb] - lo1) / R1 > BOT) rb++;               // 回到底部
          if ((sig[rb] - lo1) / R1 <= BOT && !gap(lv, rb)) {
            // 量到的是「85%→25%」這一段，只佔整個行程的 60%；換算成整段下放的時間，才能和「目標 2–3 秒」比
            r.down = (T(rb) - T(lv)) / (TOP - BOT); r._rb = rb;
            const a = [], fa = [];
            for (let j = Math.floor((lv + rb) / 2); j <= rb; j++) for (const k of ['L', 'R']) {
              if (buf[j][k].ang != null) a.push(buf[j][k].ang);
              if (buf[j][k].abd != null) fa.push(buf[j][k].abd);
            }
            r.elbow = a.length ? med(a) : null; r.flare = fa.length ? med(fa) : null;
            // 下放深度：從回到底部到真正最低點這段，手肘相對肩膀最低到幾度（取最低的 10% 位置，避免單格雜訊）
            const dv = [];
            for (let j = rb; j <= end; j++) for (const k of ['L', 'R']) if (buf[j][k].elev != null) dv.push(buf[j][k].elev);
            if (dv.length) { dv.sort((x, y) => x - y); r.depth = dv[Math.floor(dv.length * 0.1)]; }
          }
        }
      }
      reps.push(r);
    }
    // 底部停留：這一下放到底 → 下一下開始往上
    for (let k = 0; k + 1 < reps.length; k++) if (reps[k]._rb != null && reps[k + 1]._us != null && !gap(reps[k]._rb, reps[k + 1]._us)) reps[k].bottom = Math.max(0, T(reps[k + 1]._us) - T(reps[k]._rb));
    for (const r of reps) { delete r._us; delete r._rb; }

    // 4) 目前的階段（給畫面左上角）
    if (dir === 1 && ext.length) {
      const lo = sig[ext[ext.length - 1].i], s = (sig[n - 1] - lo) / Math.max(A || 0, sig[hiI] - lo, MIN_RANGE);
      out.phase = s >= TOP ? 'top' : s > BOT_OUT ? 'up' : 'bot';
    } else if (dir === -1 && ext.length) {
      const p = ext[ext.length - 1].i, lo = ext.length > 1 ? Math.min(sig[ext[ext.length - 2].i], sig[loI]) : sig[loI], R = sig[p] - lo, s = R > 0 ? (sig[n - 1] - lo) / R : 0;
      out.phase = R < need ? 'bot' : s >= TOP ? 'top' : s > BOT ? 'down' : 'bot';
    }
    if (reps.length) out.ok = true;
    out.reps = reps; out.count = reps.length;
    return out;
  }

  const avg = (reps, k) => { const a = reps.map(r => r[k]).filter(x => x != null); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };
  // 下放速度評級
  const grade = d => d == null ? null : d < 1.0 ? 'fast' : d < 1.8 ? 'mid' : 'good';
  // 飛鳥的手肘角度評級：>165° 鎖死、140–165° 微彎（理想）、<140° 彎太多
  const gradeElbow = a => a == null ? null : a > 165 ? 'lock' : a >= 140 ? 'good' : 'bent';
  // 臥推的手肘張開角度：>75° 太開（肩膀壓力大）、<25° 太貼身體、其餘可以（理想 45–60°）
  const gradeFlare = a => a == null ? null : a > 75 ? 'wide' : a < 25 ? 'tuck' : 'good';
  // 臥推椅胸推的下放深度（手肘比肩膀高幾度）：< -25° 放太低（肩膀前側壓力大）、-25～10° 剛好、>20° 放不夠低
  const gradeDepth = d => d == null ? null : d < -25 ? 'deep' : d <= 10 ? 'good' : d <= 20 ? 'mid' : 'shallow';
  return { sample, flare, gradeFlare, gradeDepth, valid, center, analyze, avg, grade, gradeElbow, TOP, BOT };
})();
if (typeof module !== 'undefined') module.exports = Core;
