const CDNS = ["https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14", "https://unpkg.com/@mediapipe/tasks-vision@0.10.14"];
const MODEL = (k, v) => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${k}/float16/${v}/pose_landmarker_${k}.task`;
const $ = id => document.getElementById(id);
const CONN = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
const PH = { bot: ['底部', 'var(--b)'], up: ['上舉 ↑', 'var(--g)'], top: ['頂端', 'var(--g)'], down: ['下放 ↓ 慢慢放', 'var(--y)'] };
const AUTO_END = 10, MAX_SET = 300;

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
// 設定
for (const id of ['cam', 'voice', 'model', 'kg']) {
  const el = $(id), v = store.get('fa_' + id, null);
  if (v != null) el.value = v;
  el.addEventListener('change', () => store.set('fa_' + id, el.value));
}

function show(id) { document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === id)); window.scrollTo(0, 0); }
function fail(msg) { stopAll(); show('home'); const e = $('err'); e.style.cssText = 'display:block'; e.textContent = msg; }

// 語音
let zhVoice = null;
const talk = { u: null, t: 0 };
function pickVoice() { const vs = window.speechSynthesis?.getVoices() || []; zhVoice = vs.find(v => /zh[-_]TW/i.test(v.lang)) || vs.find(v => /^zh/i.test(v.lang)) || null; }
if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
// urgent：打斷正在講的話（過時的話不要拖到下一個動作才講）
function say(t, urgent) {
  if (S.mode !== 'live' || $('voice').value !== '1' || !window.speechSynthesis) return;
  try {
    // 瀏覽器自己的 speaking／pending 狀態在 cancel 之後常常不準，所以自己記「現在這句講完了沒」
    const busy = talk.u && Date.now() - talk.t < 4000;
    if (urgent) speechSynthesis.cancel();
    else if (busy) return;
    const u = new SpeechSynthesisUtterance(t); u.lang = zhVoice?.lang || 'zh-TW'; if (zhVoice) u.voice = zhVoice; u.rate = 1.3;
    talk.u = u; talk.t = Date.now(); u.onend = u.onerror = () => { if (talk.u === u) talk.u = null; };
    speechSynthesis.speak(u);
  } catch {}
}

// 狀態
const S = { mode: null, running: false, lm: null, landmarker: null, modelKey: null, buf: [], res: null, said: 0, fbDone: 0, lastTs: 0, t0: 0, lastRepT: 0, stream: null, url: null, wake: null, raf: 0, recording: false };
const vid = $('vid'), cv = $('cv'), ctx = cv.getContext('2d');

// 模型快取（IndexedDB）：下載或選過一次之後就不用再抓
const idb = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open('fa', 1); r.onupgradeneeded = () => r.result.createObjectStore('m'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { try { const db = await this.open(); return await new Promise(res => { const q = db.transaction('m').objectStore('m').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch { return null; } },
  async set(k, v) { try { const db = await this.open(); await new Promise(res => { const tx = db.transaction('m', 'readwrite'); tx.objectStore('m').put(v, k); tx.oncomplete = tx.onerror = tx.onabort = res; }); } catch {} }
};
class StepError extends Error { constructor(step, detail) { super(detail); this.step = step; } }
const mem = {}; // 記憶體內的模型（IndexedDB 不能用時的後備）

async function importLib() {
  const errs = [];
  for (const base of CDNS) {
    try { return { lib: await import(base + "/vision_bundle.mjs"), base }; }
    catch (e) { errs.push(new URL(base).host + '：' + (e.message || e)); }
  }
  throw new StepError('lib', errs.join('\n'));
}
async function modelBytes(key) {
  if (mem[key]) return mem[key];
  const c = await idb.get('model_' + key);
  if (c) return (mem[key] = new Uint8Array(c));
  if (key === 'local') throw new StepError('model', '找不到先前選的模型檔，請重新選一次');
  const urls = [];
  if (location.protocol.startsWith('http')) urls.push(`pose_landmarker_${key}.task`); // 與網頁放在一起的模型檔
  urls.push(MODEL(key, 'latest'), MODEL(key, '1'));
  const errs = [];
  for (const u of urls) {
    try {
      const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status);
      const b = await r.arrayBuffer(); if (b.byteLength < 1e6) throw new Error('檔案不完整');
      await idb.set('model_' + key, b);
      return (mem[key] = new Uint8Array(b));
    } catch (e) { errs.push((u.startsWith('http') ? new URL(u).host + ' (' + u.split('/').slice(-2, -1) + ')' : '同資料夾') + '：' + (e.message || e)); }
  }
  throw new StepError('model', errs.join('\n'));
}
async function loadModel() {
  const key = $('model').value;
  if (S.landmarker && S.modelKey === key) return;
  $('load').style.display = 'flex';
  const { lib, base } = await importLib();
  const bytes = await modelBytes(key);
  let fileset; try { fileset = await lib.FilesetResolver.forVisionTasks(base + "/wasm"); } catch (e) { throw new StepError('wasm', e.message || String(e)); }
  const mk = delegate => lib.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: bytes, delegate }, runningMode: 'VIDEO', numPoses: 1,
    // 首次偵測用較嚴的 0.5（避免把背景當成人）；找到人之後用 0.3 持續追蹤（躺姿較難辨認）
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.3, minTrackingConfidence: 0.3
  });
  try { S.landmarker = await mk('GPU'); }
  catch { try { S.landmarker = await mk('CPU'); } catch (e) { throw new StepError('wasm', e.message || String(e)); } }
  S.modelKey = key; $('load').style.display = 'none';
}
function loadFail(e) {
  const d = e.message || String(e);
  if (e.step === 'model') { fail('模型檔下載失敗：\n' + d + '\n\n可以改用裝置裡已下載的模型檔（.task），按下面的按鈕選擇。'); $('modelFix').style.display = 'block'; }
  else if (e.step === 'lib') fail('偵測程式庫載入失敗（需要網路）：\n' + d + '\n\n請確認網路，或關閉會擋 CDN 的擴充功能後再試。');
  else fail('偵測引擎啟動失敗：\n' + d);
}
function addLocalOption(name) {
  let o = $('model').querySelector('option[value=local]');
  if (!o) { o = document.createElement('option'); o.value = 'local'; $('model').append(o); }
  o.textContent = '本機模型檔' + (name ? '（' + name.replace(/^pose_landmarker_|\.task$/g, '') + '）' : '');
}
{ const n = store.get('fa_local', null); if (n) { addLocalOption(n); if (store.get('fa_model', null) === 'local') $('model').value = 'local'; } }

// 首頁的鏡頭預覽：選鏡頭或按「預覽」就能看到畫面、調整手機位置
const camOpts = () => ({ audio: false, video: { facingMode: $('cam').value, width: { ideal: 1280 }, height: { ideal: 720 } } });
let pvStream = null, pvSeq = 0;
function stopPreview() {
  pvSeq++; pvStream?.getTracks().forEach(t => t.stop()); pvStream = null;
  $('pvVid').srcObject = null; $('pv').classList.remove('on'); $('btnPv').textContent = '預覽鏡頭畫面';
}
async function startPreview() {
  stopPreview(); $('err').style.display = 'none';
  if (!navigator.mediaDevices?.getUserMedia) return fail('這個瀏覽器無法使用鏡頭。請用 https 網址開啟，並使用 Chrome 或 Safari。');
  const seq = pvSeq; let st;
  try { st = await navigator.mediaDevices.getUserMedia(camOpts()); }
  catch (e) { return fail('無法開啟鏡頭：' + (e.message || e.name) + '\n請確認已允許相機權限。'); }
  if (seq !== pvSeq) { st.getTracks().forEach(t => t.stop()); return; } // 期間又切換了鏡頭或離開首頁
  pvStream = st; const v = $('pvVid');
  v.classList.toggle('mirror', $('cam').value === 'user'); v.srcObject = st;
  $('pv').classList.add('on'); $('btnPv').textContent = '關閉預覽';
  try { await v.play(); } catch {}
}
$('btnPv').onclick = () => pvStream ? stopPreview() : startPreview();
$('cam').addEventListener('change', startPreview);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPreview(); });

function resetSet() {
  S.buf = []; S.res = null; S.said = 0; S.fbDone = 0; S.recording = false; S.lastRepT = 0;
  S.armed = false; S.steady = null; S.miss = 0; S.armT = 0; S.missSaid = false;
  S.track = []; S.lastKey = null; S.setId = (S.setId || 0) + 1; clearReplay();
  $('count').textContent = '0'; $('fb').style.display = 'none'; $('warn').style.display = 'none';
  setPhase('準備', 'var(--b)');
}
function setPhase(t, c) { const p = $('phase'); p.textContent = t; p.style.background = c; }

async function startLive() {
  $('err').style.display = 'none';
  if (!navigator.mediaDevices?.getUserMedia) return fail('這個瀏覽器無法使用鏡頭。請用 https 網址開啟，並使用 Chrome 或 Safari。');
  stopPreview();
  S.mode = 'live'; resetSet(); show('session'); say('準備', true); // 先在點擊事件內發聲一次，解鎖手機語音
  try {
    S.stream = await navigator.mediaDevices.getUserMedia(camOpts());
  } catch (e) { return fail('無法開啟鏡頭：' + (e.message || e.name) + '\n請確認已允許相機權限。'); }
  $('stage').classList.toggle('mirror', $('cam').value === 'user');
  vid.srcObject = S.stream; await vid.play();
  try { S.wake = await navigator.wakeLock?.request('screen'); } catch {}
  try { await loadModel(); } catch (e) { return loadFail(e); }
  S.running = true; loop(); countdown();
}

function countdown() {
  let n = 5; const cd = $('cd'), b = cd.querySelector('b'); cd.style.display = 'flex';
  const tick = () => {
    if (!S.running) return;
    if (n > 0) { b.textContent = n; say(String(n), true); n--; setTimeout(tick, 1000); }
    else { cd.style.display = 'none'; S.armed = true; S.steady = null; S.armT = performance.now() / 1000; setPhase('就位後不要動', 'var(--b)'); } // 等看到人、而且不動約 1 秒才開始記錄
  };
  tick();
}
function begin() {
  S.armed = false; S.recording = true; S.t0 = performance.now() / 1000; S.lastRepT = S.t0;
  warn(''); setPhase(...PH.bot); say('開始', true); startRec();
}

async function startUpload(file) {
  $('err').style.display = 'none';
  S.mode = 'upload'; resetSet(); show('session'); $('stage').classList.remove('mirror');
  stopPreview(); S.file = file;
  S.url = URL.createObjectURL(file); vid.srcObject = null; vid.src = S.url;
  try { await loadModel(); } catch (e) { return loadFail(e); }
  try { await vid.play(); } catch (e) { return fail('這支影片無法播放：' + (e.message || e.name)); }
  S.running = true; S.recording = true; setPhase(...PH.bot);
  vid.onended = () => finish();
  loop();
}

function loop() {
  if (!S.running) return;
  S.raf = requestAnimationFrame(loop);
  if (vid.readyState < 2 || !vid.videoWidth) return;
  const now = performance.now();
  let ts = S.mode === 'upload' ? vid.currentTime * 1000 : now;
  if (S.mode === 'upload' && ts === S.lastVt) return;
  S.lastVt = ts;
  if (ts <= S.lastTs) ts = S.lastTs + 1;
  S.lastTs = ts;
  let r; try { r = S.landmarker.detectForVideo(vid, ts); } catch { return; }
  const W = vid.videoWidth, H = vid.videoHeight;
  if (cv.width !== W) { cv.width = W; cv.height = H; }
  ctx.clearRect(0, 0, W, H);
  let lm = r.landmarks?.[0];
  // 有些版本的程式庫不回傳「可見度」：這時一律當作看得到，否則骨架畫不出來、也無法分析
  if (lm && !lm.some(p => p.visibility > 0)) lm = lm.map(p => ({ x: p.x, y: p.y, z: p.z, visibility: 1 }));
  // 沒看到人（或只是背景被誤判成人）：這一格不畫、不記錄、不計次
  if (!lm || !Core.valid(lm, W, H)) {
    S.steady = null;
    if (++S.miss > 8) warn('沒看到你，請讓上半身和雙手入鏡');
    if (S.armed && !S.missSaid && now / 1000 - S.armT > 6) { S.missSaid = true; say('沒看到你，請調整手機位置'); }
    return;
  }
  S.miss = 0;
  draw(ctx, lm, W, H);
  if (!S.recording) {
    warn('');
    if (S.armed) {
      const c = Core.center(lm, W, H), tn = now / 1000;
      if (!S.steady || Math.hypot(c.x - S.steady.x, c.y - S.steady.y) > 0.25 * c.size) S.steady = { x: c.x, y: c.y, t: tn };
      else if (tn - S.steady.t >= 1) begin();
    }
    return;
  }
  const t = S.mode === 'upload' ? vid.currentTime : now / 1000;
  S.buf.push({ t, ...Core.sample(lm, W, H) });
  const a = S.res = Core.analyze(S.buf);
  warn('');
  if (a.ok) setPhase(...PH[a.phase]);
  S.track.push({ t, a: pack(lm) });
  // 舉到頂端（接下來要下放）：這時才提醒「下放」要注意什麼，內容依上一下的結果
  if (a.count > S.said) {
    S.said = a.count; S.lastRepT = t; $('count').textContent = a.count;
    // 這句最有時效（馬上要下放），所以打斷還沒講完的上一句
    const cue = a.count === 1 ? '慢慢放下' : { fast: '這次慢慢放', lock: '這次手肘彎一點', mid: '這次再慢一點', bent: '這次手臂打開一點' }[S.lastKey]; // 「這次…」＝提醒要怎麼做
    if (cue) say(cue, true);
  }
  // 剛放到底：報「第幾下」和這一下的結果（講的是剛剛那次下放）
  const done = a.reps.filter(x => x.down != null).length;
  if (done > S.fbDone) {
    S.fbDone = done; const rp = a.reps[done - 1], key = S.lastKey = repKey(rp), fb = $('fb');
    fb.textContent = `第 ${done} 下｜` + repText(rp);
    const bad = key === 'fast' || key === 'lock';
    fb.style.background = bad ? 'var(--r)' : key === 'good' ? 'var(--g)' : 'var(--y)'; fb.style.color = bad ? '#fff' : '#111'; fb.style.display = 'block';
    say(`第${done}下，` + { fast: '放太快', lock: '手肘太直', mid: '放得稍快', bent: '手肘太彎', good: '很好' }[key], true); // 「第N下，…」＝剛剛那一下的評語
  }
  if (S.mode === 'live' && ((a.count > 0 && a.phase === 'bot' && t - S.lastRepT > AUTO_END) || t - S.t0 > MAX_SET)) finish();
}

// 一下的評語。優先順序：太快 > 手肘鎖死 > 稍快 > 手肘彎太多 > 很好
function repKey(rp) {
  const g = Core.grade(rp.down), eg = Core.gradeElbow(rp.elbow);
  return g === 'fast' ? 'fast' : eg === 'lock' ? 'lock' : g === 'mid' ? 'mid' : eg === 'bent' ? 'bent' : 'good';
}
function repText(rp) {
  return `下放 ${rp.down.toFixed(1)} 秒` + (rp.elbow != null ? `｜手肘 ${rp.elbow.toFixed(0)}°` : '') + ' ' + { fast: '× 放太快', lock: '× 手肘太直，要微彎', mid: '△ 再慢一點', bent: '△ 手肘彎太多', good: '✓ 很好' }[repKey(rp)];
}

// ===== 示範動畫：從腳邊看過去的簡圖（人躺著，兩手畫弧線）=====
// panels: [{ label, down(下放秒數), up(上舉秒數), elbow(手肘角度), color }]；多個 panel 會同時開始每一下，方便對照
const STD = { label: '標準', down: 3, up: 1.2, elbow: 150, color: '#8cff28' };
function demo(cv, panels) {
  cancelAnimationFrame(cv._raf); cv._panels = panels; if (!panels) return;
  const HOLD = 0.4, REST = 0.9, t0 = performance.now();
  const cyc = Math.max(...panels.map(p => p.up + HOLD + p.down)) + REST;
  const ease = u => u * u * (3 - 2 * u);
  const frame = () => {
    if (cv._panels !== panels) return;
    cv._raf = requestAnimationFrame(frame);
    if (!cv.offsetParent) return; // 不在畫面上就不畫
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const t = ((performance.now() - t0) / 1000) % cyc, pw = w / panels.length;
    panels.forEach((p, i) => {
      // k：手臂抬起的程度，0 = 貼地、1 = 最高
      let k, txt; const td = t - p.up - HOLD;
      if (t < p.up) { k = ease(t / p.up); txt = '上舉'; }
      else if (td < 0) { k = 1; txt = '頂端'; }
      else if (td < p.down) { const u = td / p.down; k = 1 - (p.down < 1 ? u * u : ease(u)); txt = `下放 ${td.toFixed(1)} 秒`; } // 太快的看起來像掉下去
      else { k = 0; txt = `下放共 ${p.down.toFixed(1)} 秒`; }
      const cx = i * pw + pw / 2, fl = h - 30, L = Math.min((pw / 2 - 12) / 1.25, (fl - 30) / 1.2);
      const sx = 0.2 * L, sy = fl - 0.13 * L, U = 0.5 * L, F = 0.5 * L, bend = (180 - p.elbow) * Math.PI / 180;
      const pts = (kk, s) => { // s = ±1 左右手；回傳 [肩, 肘, 手]
        const th = kk * 76 * Math.PI / 180, S = [cx + s * sx, sy];
        const E = [S[0] + s * U * Math.cos(th), S[1] - U * Math.sin(th)];
        return [S, E, [E[0] + s * F * Math.cos(th + bend), E[1] - F * Math.sin(th + bend)]];
      };
      g.font = '700 14px system-ui,sans-serif'; g.textAlign = 'center'; g.fillStyle = p.color; g.fillText(p.label, cx, 16);
      g.strokeStyle = '#2c342d'; g.lineWidth = 2; g.setLineDash([]); g.beginPath(); g.moveTo(i * pw + 8, fl); g.lineTo((i + 1) * pw - 8, fl); g.stroke();
      g.fillStyle = '#39443a'; g.beginPath(); g.arc(cx, sy - 0.1 * L, 0.11 * L, 0, 7); g.fill();               // 頭
      g.fillStyle = '#2c342d'; g.beginPath(); g.ellipse(cx, sy, sx + 0.05 * L, 0.13 * L, 0, 0, 7); g.fill();    // 胸
      for (const s of [-1, 1]) {
        g.strokeStyle = p.color; g.globalAlpha = 0.45; g.lineWidth = 2; g.setLineDash([3, 5]); g.beginPath();   // 手的軌道
        for (let j = 0; j <= 24; j++) { const H = pts(j / 24, s)[2]; j ? g.lineTo(H[0], H[1]) : g.moveTo(H[0], H[1]); }
        g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
        const [S, E, H] = pts(k, s);
        g.lineWidth = Math.max(4, L / 22); g.lineCap = g.lineJoin = 'round'; g.beginPath(); g.moveTo(S[0], S[1]); g.lineTo(E[0], E[1]); g.lineTo(H[0], H[1]); g.stroke();
        g.fillStyle = p.color; g.beginPath(); g.arc(E[0], E[1], Math.max(4, L / 20), 0, 7); g.fill();
        g.fillStyle = '#eef2ec'; g.beginPath(); g.arc(H[0], H[1], Math.max(6, L / 13), 0, 7); g.fill();           // 啞鈴
      }
      g.font = '600 12px system-ui,sans-serif'; g.fillStyle = '#9aa69b';
      g.fillText(`${txt}｜手肘 ${Math.round(p.elbow)}°`, cx, h - 10);
    });
  };
  frame();
}
// 首頁的示範：可切換「只看標準」或和常見錯誤對照
const BAD = {
  fast: [{ label: '太快', down: 0.4, up: 1.2, elbow: 150, color: '#ff4646' }, '右邊是「放太快」：啞鈴幾乎是掉下去的。標準是用 2–3 秒慢慢放，軌道一樣、速度不同。'],
  lock: [{ label: '手肘太直', down: 3, up: 1.2, elbow: 178, color: '#ff4646' }, '右邊是「手肘太直」：手臂整支打直，啞鈴離身體最遠，手肘和肩膀壓力最大。標準是全程微彎（像抱一顆大球），角度固定不變。'],
  bent: [{ label: '手肘太彎', down: 3, up: 1.2, elbow: 95, color: '#ffd700' }, '右邊是「手肘太彎」：啞鈴變成直上直下，像臥推，胸肌沒有被拉開。標準的軌道是一個大弧線。']
};
function setDemo(k) {
  document.querySelectorAll('#demoChips button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  demo($('demoCv'), BAD[k] ? [STD, BAD[k][0]] : [STD]);
  $('demoTxt').textContent = BAD[k] ? BAD[k][1] : '從腳邊看過去的樣子。虛線是啞鈴的軌道：手肘保持微彎（約 150°），沿著大弧線舉起；放下時用 2–3 秒，上臂輕碰地就再舉起。';
}
$('demoChips').onclick = e => { const b = e.target.closest('button'); if (b) setDemo(b.dataset.k); };
setDemo('std');
// 骨架點壓成小陣列存起來，回放時疊在影片上
const pack = lm => { const a = new Float32Array(99); lm.forEach((p, i) => { a[i * 3] = p.x; a[i * 3 + 1] = p.y; a[i * 3 + 2] = p.visibility ?? 0; }); return a; };
const unpack = a => Array.from({ length: 33 }, (_, i) => ({ x: a[i * 3], y: a[i * 3 + 1], visibility: a[i * 3 + 2] }));

// 錄下這一組（只留在這個頁面的記憶體，不會上傳）
function startRec() {
  S.rec = null; S.chunks = [];
  if (!window.MediaRecorder || !S.stream) return;
  const mime = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  try {
    const r = new MediaRecorder(S.stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 1500000 }), chunks = S.chunks;
    r.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    r.onstart = () => { S.recT0 = performance.now() / 1000; };
    S.recT0 = performance.now() / 1000; r.start(1000); S.rec = r;
  } catch { S.rec = null; }
}

// 回放：影片 + 骨架 + 目前是第幾下
const RP = { url: null, t0: 0, track: [], reps: [], raf: 0 };
function clearReplay() {
  cancelAnimationFrame(RP.raf); const v = $('rpVid');
  try { v.pause(); } catch {} v.onloadedmetadata = v.ontimeupdate = null;
  if (RP.url) { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(RP.url); RP.url = null; }
  $('rp').style.display = 'none';
}
function setReplay(blob, t0, track, reps) {
  clearReplay(); Object.assign(RP, { url: URL.createObjectURL(blob), t0, track, reps });
  const v = $('rpVid'), s = $('rpSave');
  // 瀏覽器錄的影片有時沒有長度資訊，先跳到最後再跳回來，進度條才能拖
  v.onloadedmetadata = () => { if (v.duration === Infinity) { v.ontimeupdate = () => { v.ontimeupdate = null; v.currentTime = 0; }; v.currentTime = 1e101; } };
  v.src = RP.url; $('rp').style.display = 'block';
  s.href = RP.url; s.download = '動作教練-' + new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace(/[-:T]/g, '') + (/mp4/.test(blob.type) ? '.mp4' : /webm/.test(blob.type) ? '.webm' : '');
  replayLoop();
}
function replayLoop() {
  RP.raf = requestAnimationFrame(replayLoop);
  const v = $('rpVid'), c = $('rpCv'); if (!v.videoWidth) return;
  if (c.width !== v.videoWidth || c.height !== v.videoHeight) { c.width = v.videoWidth; c.height = v.videoHeight; }
  const g = c.getContext('2d'), t = RP.t0 + v.currentTime, tr = RP.track;
  g.clearRect(0, 0, c.width, c.height);
  let lo = 0, hi = tr.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (tr[m].t < t) lo = m + 1; else hi = m; }
  const f = lo > 0 && t - tr[lo - 1].t < tr[lo].t - t ? tr[lo - 1] : tr[lo];
  if (f && Math.abs(f.t - t) < 0.15) draw(g, unpack(f.a), c.width, c.height);
  let lab = '';
  RP.reps.forEach((r, i) => {
    if (t < r.tTop - (r.up || 0)) return;
    lab = `第 ${i + 1} 下` + (r.down != null && t >= r.tTop + (r.top || 0) + r.down ? '｜' + repText(r) : '');
  });
  const L = $('rpLab'); L.textContent = lab; L.style.display = lab ? 'block' : 'none';
}

function warn(t) { const w = $('warn'); w.textContent = t; w.style.display = t ? 'block' : 'none'; }

function draw(ctx, lm, W, H) {
  const lw = Math.max(4, W / 180);
  ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.strokeStyle = '#8cff28'; ctx.fillStyle = '#8cff28';
  const ok = i => (lm[i].visibility ?? 0) > 0.5, used = new Set();
  for (const [a, b] of CONN) if (ok(a) && ok(b)) {
    ctx.beginPath(); ctx.moveTo(lm[a].x * W, lm[a].y * H); ctx.lineTo(lm[b].x * W, lm[b].y * H); ctx.stroke(); used.add(a); used.add(b);
  }
  for (const i of used) { ctx.beginPath(); ctx.arc(lm[i].x * W, lm[i].y * H, lw * 1.3, 0, 7); ctx.fill(); }
}

function stopAll() {
  S.running = false; cancelAnimationFrame(S.raf);
  S.stream?.getTracks().forEach(t => t.stop()); S.stream = null;
  try { vid.pause(); } catch {} vid.onended = null; vid.srcObject = null;
  if (S.url) { URL.revokeObjectURL(S.url); S.url = null; vid.removeAttribute('src'); vid.load(); }
  try { if (S.rec && S.rec.state !== 'inactive') S.rec.stop(); } catch {} S.rec = null;
  try { S.wake?.release(); } catch {} S.wake = null;
  $('cd').style.display = 'none'; $('load').style.display = 'none';
}

function finish() {
  if (!S.running) return;
  const a = S.res || { reps: [], count: 0 }, mode = S.mode;
  if (mode === 'live') { const d = Core.avg(a.reps, 'down'); say(a.count ? `結束，共 ${a.count} 下` + (d != null ? `，平均下放 ${d.toFixed(1)} 秒` : '') : '結束', true); }
  // 回放：即時模式用剛錄的影片，上傳模式直接用原檔；骨架用剛才存下來的點
  const track = S.track, reps = a.reps, id = S.setId, r = S.rec;
  let hasVideo = false;
  if (mode === 'live' && r && r.state !== 'inactive') {
    const chunks = S.chunks, t0 = S.recT0; hasVideo = true;
    r.onstop = () => { if (id === S.setId && chunks.length) setReplay(new Blob(chunks, { type: r.mimeType || chunks[0].type }), t0, track, reps); };
    try { r.stop(); } catch {}
  }
  stopAll(); renderSummary(a, mode); show('summary');
  if (mode === 'upload' && S.file) { hasVideo = true; setReplay(S.file, 0, track, reps); }
  $('rpNone').style.display = hasVideo ? 'none' : 'block';
}

const f1 = x => x == null ? '–' : x.toFixed(1);
function renderSummary(a, mode) {
  const kg = parseFloat($('kg').value) || null;
  const m = { down: Core.avg(a.reps, 'down'), bottom: Core.avg(a.reps, 'bottom'), up: Core.avg(a.reps, 'up'), elbow: Core.avg(a.reps, 'elbow') };
  const g = Core.grade(m.down), eg = Core.gradeElbow(m.elbow);
  $('sumMeta').textContent = new Date().toLocaleString('zh-TW', { hour12: false }) + '｜地板啞鈴飛鳥' + (kg ? `｜${kg} 公斤` : '') + (mode === 'upload' ? '｜上傳影片' : '');
  const ec = { lock: 'fast', good: 'good', bent: 'mid' }[eg] || '';
  $('stats').innerHTML =
    `<div><small>次數</small><b>${a.count}</b><em>&nbsp;</em></div>` +
    `<div><small>平均下放</small><b class="${g || ''}">${f1(m.down)} 秒</b><em class="${g || ''}">${{ fast: '太快，目標 2–3 秒', mid: '再慢一點，目標 2–3 秒', good: '很好' }[g] || ''}</em></div>` +
    `<div><small>底部手肘角度</small><b class="${ec}">${m.elbow == null ? '–' : m.elbow.toFixed(0) + '°'}</b><em class="${ec}">${{ lock: '打直了，要微彎', good: '微彎，很好', bent: '彎太多，像臥推' }[eg] || '看不到手腕，無法判斷'}</em></div>` +
    `<div><small>平均上舉</small><b>${f1(m.up)} 秒</b><em>底部停留 ${f1(m.bottom)} 秒</em></div>`;
  const tips = [];
  if (eg === 'lock') tips.push('手肘幾乎打直。全程保持微彎（像抱一顆大球），角度固定不變，手肘和肩膀的壓力會小很多。');
  if (eg === 'bent') tips.push('手肘彎太多，會變成臥推、胸肌伸展不足。把手臂再打開一點，維持微彎。');
  if (g === 'fast') tips.push('下放太快，啞鈴幾乎是掉下去的。放下時心裡數「1、2、3」。');
  if (g === 'mid') tips.push('下放有在控制了，再慢一點，數到 3 才碰地。');
  $('verdict').innerHTML = !a.count ? '沒有偵測到完整的動作。請確認全身入鏡，再試一次。'
    : tips.length ? tips.join('<br>') : '下放速度和手肘角度都控制得很好，可以考慮加重量或次數。';
  // 標準 vs 你這一組：用這一組量到的平均秒數與手肘角度畫成同一種簡圖來對照
  if (a.count && m.down != null) {
    const key = repKey({ down: m.down, elbow: m.elbow });
    demo($('cmpCv'), [STD, { label: '你這一組', down: m.down, up: m.up || 1.2, elbow: m.elbow ?? 150, color: key === 'good' ? '#8cff28' : key === 'fast' || key === 'lock' ? '#ff4646' : '#ffd700' }]);
    $('cmpTxt').textContent = '右邊是依你這一組量到的平均值畫的：下放 ' + m.down.toFixed(1) + ' 秒（標準 2–3 秒）'
      + (m.elbow != null ? '、手肘 ' + m.elbow.toFixed(0) + '°（標準約 150°）' : '、手肘角度這次量不到，先用標準角度畫') + '。兩邊同時開始每一下，可以直接看出速度和手臂形狀差在哪。這是簡圖，不是你的實際影像；實際影像看下面的回放。';
    $('cmp').style.display = 'block';
  } else { demo($('cmpCv'), null); $('cmp').style.display = 'none'; }
  const mx = Math.max(3, ...a.reps.map(r => r.down || 0));
  $('bars').innerHTML = a.reps.map((r, i) => {
    const c = { fast: 'var(--r)', mid: 'var(--y)', good: 'var(--g)' }[Core.grade(r.down)] || 'var(--line)';
    const e = Core.gradeElbow(r.elbow), et = r.elbow == null ? '' : `　<span class="${{ lock: 'fast', good: 'good', bent: 'mid' }[e]}">手肘 ${r.elbow.toFixed(0)}°</span>`;
    return `<div class="bar" data-i="${i}"><i>${i + 1}</i><span style="width:${(r.down || 0) / mx * 55}%;background:${c}"></span><u>${r.down == null ? '未完成' : r.down.toFixed(1) + ' 秒'}${et}</u></div>`;
  }).join('') || '<p class="tgt">沒有資料</p>';
  if (a.count) {
    const h = store.get('fa_hist', []);
    h.unshift({ d: Date.now(), n: a.count, down: m.down, bottom: m.bottom, elbow: m.elbow, kg, mode, ex: 'fly' });
    store.set('fa_hist', h.slice(0, 200));
  }
}

function renderHistory() {
  const h = store.get('fa_hist', []);
  $('histList').innerHTML = h.length ? h.map(x => {
    const g = Core.grade(x.down) || '';
    const name = x.ex === 'fly' ? '地板啞鈴飛鳥' : '地板臥推', e = Core.gradeElbow(x.elbow);
    return `<div class="hist"><div>${new Date(x.d).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}<br><small>${name}${x.kg ? '｜' + x.kg + ' 公斤' : ''}${x.mode === 'upload' ? '｜影片' : ''}</small></div><div style="text-align:right"><b>${x.n} 下</b><br><span class="${g}">下放 ${f1(x.down)} 秒</span>${x.elbow != null ? `　<span class="${{ lock: 'fast', good: 'good', bent: 'mid' }[e]}">手肘 ${x.elbow.toFixed(0)}°</span>` : ''}</div></div>`;
  }).join('') : '<p class="tgt">還沒有紀錄，做完一組就會出現在這裡。</p>';
}

$('btnLive').onclick = startLive;
$('btnAgain').onclick = () => S.mode === 'upload' ? $('file').click() : startLive();
$('btnUpload').onclick = () => $('file').click();
$('file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) startUpload(f); };
$('stop').onclick = finish;
$('btnModel').onclick = () => $('modelFile').click();
$('modelFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const b = await f.arrayBuffer(), msg = $('err');
  if (b.byteLength < 1e6) { msg.textContent = '這個檔案看起來不是模型檔（.task）。'; return; }
  mem.local = new Uint8Array(b); await idb.set('model_local', b);
  store.set('fa_local', f.name); addLocalOption(f.name); $('model').value = 'local'; store.set('fa_model', 'local');
  S.landmarker = null; $('modelFix').style.display = 'none';
  msg.style.cssText = 'display:block;background:#14301a;border-color:var(--g);color:#d6ffd0';
  msg.textContent = '模型檔已載入：' + f.name + '\n請再按一次「開始即時分析」或「上傳影片分析」。';
};
$('btnHome').onclick = $('btnHome2').onclick = () => { clearReplay(); show('home'); };
// 點某一下的長條：回放跳到那一下開始前
$('bars').onclick = e => {
  const b = e.target.closest('.bar'), r = b && RP.reps[b.dataset.i]; if (!r || !RP.url) return;
  const v = $('rpVid'); v.currentTime = Math.max(0, r.tTop - (r.up || 0) - RP.t0 - 0.3);
  v.play().catch(() => {}); $('rp').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
$('btnHist').onclick = () => { stopPreview(); renderHistory(); show('history'); };
let clearArmed = 0;
$('btnClear').onclick = e => {
  if (Date.now() - clearArmed < 4000) { store.set('fa_hist', []); renderHistory(); e.target.textContent = '清除紀錄'; clearArmed = 0; }
  else { clearArmed = Date.now(); e.target.textContent = '再按一次確認清除'; }
};
window.__fa = { S, Core };
