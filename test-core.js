// 計次核心的合成資料測試：node test-core.js
const C = require('./core.js');
const mk = (t, s) => ({ t, L: { v: s * 100, vis: 0.9, torso: 100, ang: 150, abd: 55 }, R: { v: s * 100, vis: 0.9, torso: 100, ang: 150, abd: 55 } });
const noise = i => 0.02 * Math.sin(i * 1.7) + 0.015 * Math.sin(i * 0.37);
// 產生一段訊號：segs = [[秒數, 起始高度, 結束高度], ...]，30 fps，餘弦平滑
function build(segs, fps = 30) {
  const buf = []; let t = 0, i = 0;
  for (const [d, a, b] of segs) { const m = Math.round(d * fps); for (let j = 0; j < m; j++, i++) { const u = j / m; buf.push(mk(t + j / fps, a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * u)) + noise(i))); } t += d; }
  return buf;
}
const rep = (amp, up = 1, down = 2, rest = 0.8, top = 0.3) => [[up, 0, amp], [top, amp, amp], [down, amp, 0], [rest, 0, 0]];
const reps = (...amps) => [[1, 0, 0], ...amps.flatMap(a => rep(a))];
let fail = 0;
function check(name, buf, want, extra, slack = 0) {
  const a = C.analyze(buf), ok = a.count === want;
  // 即時模擬：一格一格餵，過程中的次數不該超過最後結果（slack：允許暫時多算幾下）
  let maxLive = 0; for (let k = 5; k <= buf.length; k += 3) maxLive = Math.max(maxLive, C.analyze(buf.slice(0, k)).count);
  if (!ok || maxLive > want + slack) fail++;
  console.log((ok && maxLive <= want + slack ? 'ok  ' : 'FAIL') + ' ' + name + ' -> ' + a.count + ' (want ' + want + ', live max ' + maxLive + ')' + (extra ? ' ' + extra(a) : ''));
}
const downs = a => 'down=' + a.reps.map(r => r.down == null ? '-' : r.down.toFixed(2)).join(',');
check('12 下，幅度一致', build(reps(...Array(12).fill(1))), 12, downs);
check('4 下，幅度不一 (1, 0.7, 1.2, 0.6)', build(reps(1, 0.7, 1.2, 0.6)), 4, downs);
check('4 下，小幅度 0.25', build(reps(0.25, 0.25, 0.25, 0.25)), 4, downs);
check('4 下後起身（訊號暴衝）', [...build(reps(1, 1, 1, 1)), ...build([[3, 0, 6]]).map(f => ({ ...f, t: f.t + 100 }))], 4, null, 1); // 起身剛開始時看起來就像一下，過程中會暫時多 1；App 另外用「離開位置」擋掉
check('靜止只有雜訊', build([[10, 0, 0]]), 0);
check('4 下，底部高度慢慢漂移', build([[1, 0, 0], ...[0, 0.15, 0.3, 0.45].flatMap(b => [[1, b, b + 1], [0.3, b + 1, b + 1], [2, b + 1, b + 0.15], [0.8, b + 0.15, b + 0.15]])]), 4, downs);
check('快速 6 下（下放 0.3 秒）', build([[1, 0, 0], ...Array(6).fill(0).flatMap(() => rep(1, 0.5, 0.3, 0.9, 0.1))]), 6, downs);
check('4 下，第 2 下之後 3 秒沒看到人', (() => { const b = build(reps(1, 1, 1, 1)); return b.map(f => f.t > 9.3 ? { ...f, t: f.t + 3 } : f); })(), 4, downs);
process.exit(fail ? 1 : 0);
