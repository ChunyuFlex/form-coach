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
function pickVoice() { const vs = window.speechSynthesis?.getVoices() || []; zhVoice = vs.find(v => /zh[-_]TW/i.test(v.lang)) || vs.find(v => /^zh/i.test(v.lang)) || null; }
if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function say(t, urgent) {
  if (S.mode !== 'live' || $('voice').value !== '1' || !window.speechSynthesis) return;
  try {
    if (urgent) speechSynthesis.cancel();
    else if (speechSynthesis.pending) return;
    const u = new SpeechSynthesisUtterance(t); u.lang = zhVoice?.lang || 'zh-TW'; if (zhVoice) u.voice = zhVoice; u.rate = 1.15;
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
    minPoseDetectionConfidence: 0.3, minPosePresenceConfidence: 0.3, minTrackingConfidence: 0.3
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

function resetSet() {
  S.buf = []; S.res = null; S.said = 0; S.fbDone = 0; S.recording = false; S.lastRepT = 0;
  $('count').textContent = '0'; $('fb').style.display = 'none'; $('warn').style.display = 'none';
  setPhase('準備', 'var(--b)');
}
function setPhase(t, c) { const p = $('phase'); p.textContent = t; p.style.background = c; }

async function startLive() {
  $('err').style.display = 'none';
  if (!navigator.mediaDevices?.getUserMedia) return fail('這個瀏覽器無法使用鏡頭。請用 https 網址開啟，並使用 Chrome 或 Safari。');
  S.mode = 'live'; resetSet(); show('session'); say('準備', true); // 先在點擊事件內發聲一次，解鎖手機語音
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: $('cam').value, width: { ideal: 1280 }, height: { ideal: 720 } } });
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
    else { cd.style.display = 'none'; say('開始', true); S.recording = true; S.t0 = performance.now() / 1000; S.lastRepT = S.t0; setPhase(...PH.bot); }
  };
  tick();
}

async function startUpload(file) {
  $('err').style.display = 'none';
  S.mode = 'upload'; resetSet(); show('session'); $('stage').classList.remove('mirror');
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
  if (!lm) { warn('沒偵測到人，請讓全身入鏡'); return; }
  // 有些版本的程式庫不回傳「可見度」：這時一律當作看得到，否則骨架畫不出來、也無法分析
  if (!lm.some(p => p.visibility > 0)) lm = lm.map(p => ({ x: p.x, y: p.y, z: p.z, visibility: 1 }));
  draw(lm, W, H);
  if (!S.recording) return;
  const t = S.mode === 'upload' ? vid.currentTime : now / 1000;
  S.buf.push({ t, ...Core.sample(lm, W, H) });
  const a = S.res = Core.analyze(S.buf);
  S.lowVis = a.vis < 0.4 ? (S.lowVis || 0) + 1 : 0; // 連續約 1 秒看不清楚才提醒
  warn(S.lowVis > 30 ? '看不清楚肩膀或手肘，調整一下手機位置' : '');
  if (a.ok) setPhase(...PH[a.phase]);
  if (a.count > S.said) { S.said = a.count; S.lastRepT = t; $('count').textContent = a.count; say(String(a.count)); }
  // 剛放到底：給這一下的回饋
  const done = a.reps.filter(x => x.down != null).length;
  if (done > S.fbDone) {
    S.fbDone = done; const rp = a.reps[done - 1], d = rp.down, g = Core.grade(d), eg = Core.gradeElbow(rp.elbow), fb = $('fb');
    // 優先順序：太快 > 手肘鎖死 > 稍快 > 手肘彎太多 > 很好
    const key = g === 'fast' ? 'fast' : eg === 'lock' ? 'lock' : g === 'mid' ? 'mid' : eg === 'bent' ? 'bent' : 'good';
    fb.textContent = `下放 ${d.toFixed(1)} 秒` + (rp.elbow != null ? `｜手肘 ${rp.elbow.toFixed(0)}°` : '') + ' ' + { fast: '× 太快', lock: '× 手肘打直了', mid: '△ 再慢一點', bent: '△ 手肘彎太多', good: '✓ 很好' }[key];
    const bad = key === 'fast' || key === 'lock';
    fb.style.background = bad ? 'var(--r)' : key === 'good' ? 'var(--g)' : 'var(--y)'; fb.style.color = bad ? '#fff' : '#111'; fb.style.display = 'block';
    say({ fast: '太快，慢慢放', lock: '手肘微彎', mid: '再慢一點', bent: '手肘彎太多', good: '很好' }[key]);
  }
  if (S.mode === 'live' && ((a.count > 0 && a.phase === 'bot' && t - S.lastRepT > AUTO_END) || t - S.t0 > MAX_SET)) finish();
}

function warn(t) { const w = $('warn'); w.textContent = t; w.style.display = t ? 'block' : 'none'; }

function draw(lm, W, H) {
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
  try { S.wake?.release(); } catch {} S.wake = null;
  $('cd').style.display = 'none'; $('load').style.display = 'none';
}

function finish() {
  if (!S.running) return;
  const a = S.res || { reps: [], count: 0 }, mode = S.mode;
  if (mode === 'live') { const d = Core.avg(a.reps, 'down'); say(a.count ? `結束，共 ${a.count} 下` + (d != null ? `，平均下放 ${d.toFixed(1)} 秒` : '') : '結束', true); }
  stopAll(); renderSummary(a, mode); show('summary');
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
  const mx = Math.max(3, ...a.reps.map(r => r.down || 0));
  $('bars').innerHTML = a.reps.map((r, i) => {
    const c = { fast: 'var(--r)', mid: 'var(--y)', good: 'var(--g)' }[Core.grade(r.down)] || 'var(--line)';
    const e = Core.gradeElbow(r.elbow), et = r.elbow == null ? '' : `　<span class="${{ lock: 'fast', good: 'good', bent: 'mid' }[e]}">手肘 ${r.elbow.toFixed(0)}°</span>`;
    return `<div class="bar"><i>${i + 1}</i><span style="width:${(r.down || 0) / mx * 55}%;background:${c}"></span><u>${r.down == null ? '未完成' : r.down.toFixed(1) + ' 秒'}${et}</u></div>`;
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
$('btnHome').onclick = $('btnHome2').onclick = () => show('home');
$('btnHist').onclick = () => { renderHistory(); show('history'); };
let clearArmed = 0;
$('btnClear').onclick = e => {
  if (Date.now() - clearArmed < 4000) { store.set('fa_hist', []); renderHistory(); e.target.textContent = '清除紀錄'; clearArmed = 0; }
  else { clearArmed = Date.now(); e.target.textContent = '再按一次確認清除'; }
};
window.__fa = { S, Core };
