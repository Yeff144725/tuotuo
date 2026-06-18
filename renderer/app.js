'use strict';
/* Renderer: dense, period-switchable token panel.
   A segmented control (today / 7d / 30d) drives the total, input/output split,
   cost, and the chart. Runs in Electron (real data) or a browser (mock). */

const $ = (id) => document.getElementById(id);

/* ---------- formatting ---------- */
const abbr = (n) => {
  n = Math.max(0, n);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
};
const full = (n) => Math.round(n).toLocaleString();
const money = (n) => (n >= 1000 ? '$' + Math.round(n).toLocaleString() : '$' + n.toFixed(2));

/* ---------- thermal color (burn rate → cyan→amber→red) ---------- */
const STOPS = [[0, [86, 214, 255]], [0.5, [255, 176, 32]], [1, [255, 77, 61]]];
function thermal(t) {
  t = Math.max(0, Math.min(1, t));
  let a = STOPS[0], b = STOPS[STOPS.length - 1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (t >= STOPS[i][0] && t <= STOPS[i + 1][0]) { a = STOPS[i]; b = STOPS[i + 1]; break; }
  }
  const f = (t - a[0]) / ((b[0] - a[0]) || 1);
  return a[1].map((v, i) => Math.round(v + (b[1][i] - v) * f));
}
const rgb = (c, al) => (al == null ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${al})`);
const burnT = (burn) => Math.min(1, Math.log10(1 + Math.max(0, burn)) / Math.log10(1 + 10000));

/* ---------- count-up tweening ---------- */
const tweens = new Map();
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
function setNum(el, to, fmt) {
  const from = el._v || 0;
  el.title = full(to);
  if (Math.abs(from - to) < 1) { el.textContent = fmt(to); el._v = to; return; }
  tweens.set(el, { from, to, start: performance.now(), dur: 600, fmt });
}

/* ---------- charts ---------- */
function drawSpark(canvas, data, burn, phase) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) { const y = (H * i) / 4; ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
  const n = data.length, max = Math.max(1, ...data), pad = 9;
  const X = (i) => pad + ((W - 2 * pad) * i) / (n - 1);
  const Y = (v) => H - pad - (H - 2 * pad) * (v / max);
  const c = thermal(burnT(burn));
  ctx.beginPath(); ctx.moveTo(X(0), H);
  for (let i = 0; i < n; i++) ctx.lineTo(X(i), Y(data[i]));
  ctx.lineTo(X(n - 1), H); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, rgb(c, 0.36)); g.addColorStop(1, rgb(c, 0.02));
  ctx.fillStyle = g; ctx.fill();
  ctx.shadowColor = rgb(c, 0.85); ctx.shadowBlur = 10;
  ctx.strokeStyle = rgb(c, 0.95); ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < n; i++) { const px = X(i), py = Y(data[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
  ctx.stroke(); ctx.shadowBlur = 0;
  const lx = X(n - 1), ly = Y(data[n - 1]);
  const pulse = 2.5 + Math.sin(phase / 380) * 1.2;
  ctx.fillStyle = rgb(c); ctx.beginPath(); ctx.arc(lx, ly, 3, 0, 7); ctx.fill();
  ctx.strokeStyle = rgb(c, 0.45); ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(lx, ly, 5 + pulse, 0, 7); ctx.stroke();
}

function drawBars(canvas, data) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const n = data.length, max = Math.max(1, ...data);
  const gap = n > 20 ? 2 : 4, bw = (W - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const h = Math.max(2, (H - 2) * (data[i] / max));
    const t = data[i] / max;
    ctx.fillStyle = rgb(thermal(0.15 + t * 0.85), 0.55 + t * 0.45);
    ctx.fillRect(i * (bw + gap), H - h, bw, h);
  }
}

/* ---------- state ---------- */
let snap = null;
let period = 'today';
let inputMode = 'all';   // 'all' = fresh + cache, 'fresh' = fresh input only
let prevTs = 0;
const pct = (v, t) => (t ? (v / t * 100 < 1 ? (v / t * 100).toFixed(1) : Math.round(v / t * 100)) + '%' : '');

const windowFor = (s) => (period === 'd7' ? s.d7 : period === 'd30' ? s.d30 : s.today);
const totalOf = (w) => w.in + w.out + w.cw + w.cr;

/* ---------- render ---------- */
function render(s) {
  snap = s;
  const c = thermal(burnT(s.burnPerMin));
  document.documentElement.style.setProperty('--accent', `${c[0]}, ${c[1]}, ${c[2]}`);
  const sparkRate = (2.2 - burnT(s.burnPerMin) * 1.55).toFixed(2) + 's';
  if (window._pets) for (const p of window._pets) p.style.setProperty('--spark-rate', sparkRate);

  renderPeriod();

  if (s.lastEventTs && s.lastEventTs !== prevTs) {
    prevTs = s.lastEventTs;
    const dot = $('liveDot'); dot.classList.remove('beat'); void dot.offsetWidth; dot.classList.add('beat');
    const hero = document.querySelector('.hero'); hero.classList.remove('flash'); void hero.offsetWidth; hero.classList.add('flash');
    if (window._pets) for (const p of window._pets) { p.classList.remove('zap'); void p.offsetWidth; p.classList.add('zap'); }
  }
}

function renderPeriod() {
  for (const b of document.querySelectorAll('.seg-btn')) b.classList.toggle('active', b.dataset.period === period);
  if (!snap) return;
  const w = windowFor(snap);
  const inAll = w.in + w.cw + w.cr, outTok = w.out;
  const inVal = inputMode === 'fresh' ? w.in : inAll;
  const total = inVal + outTok;            // TOTAL follows the INPUT toggle
  setNum($('total'), total, abbr);
  $('cNum').textContent = abbr(total);     // SAME value AND SAME format as the big total
  $('cost').textContent = '≈ ' + money(w.cost) + ' list';
  setNum($('inNum'), inVal, abbr);
  setNum($('outNum'), outTok, abbr);
  $('inShare').textContent = pct(inVal, total);
  $('inCap').textContent = inputMode === 'fresh' ? 'fresh input only' : 'fresh + cache';
  $('outShare').textContent = pct(outTok, total);

  if (period === 'today') {
    $('sub2').innerHTML = '<span class="caret">▲</span> ' + full(snap.burnPerMin) + ' tok/min';
    $('chartCap').textContent = 'last 60 min · live';
  } else {
    const days = period === 'd7' ? 7 : 30;
    $('sub2').textContent = 'avg ' + abbr(total / days) + ' / day';
    $('chartCap').textContent = period === 'd7' ? 'last 7 days' : 'last 30 days';
  }
  requestAnimationFrame(fitToContent);
}

function setStatus(st) {
  const el = $('status');
  if (st.phase === 'scanning') { el.style.display = 'block'; el.innerHTML = st.total ? `calibrating · ${st.done}/${st.total}` : 'calibrating…'; }
  else { el.style.display = 'none'; requestAnimationFrame(fitToContent); }
}

/* ---------- pet interactions: hover = jump+spin, click = thunderbolt ---------- */
function playAnim(svg, cls, ms) {
  if (!svg || svg.classList.contains('attack')) return; // attack has priority
  if (cls === 'hop' && svg.classList.contains('hop')) return; // don't restack a hop mid-hop
  svg.classList.add(cls);
  setTimeout(() => svg.classList.remove(cls), ms);
}
const heroPet = () => document.querySelector('.pet-host-sm .pet-svg');
const ATTACK_MS = 1300;
function fireAttack(svg, then) {                          // every click → the yellow Thunderbolt
  if (!svg) { if (then) then(); return; }
  if (svg.classList.contains('attack')) { if (then) then(); return; }
  svg.classList.remove('hop');
  svg.classList.add('attack');
  setTimeout(() => { svg.classList.remove('attack'); if (then) then(); }, ATTACK_MS);
}
function setupPetInteractions() {
  for (const host of document.querySelectorAll('.pet-host')) {
    host.addEventListener('mouseenter', () => playAnim(host.querySelector('.pet-svg'), 'hop', 740));
  }
  const hero = document.querySelector('.pet-host-sm');           // click the (expanded) pet → thunder
  if (hero) hero.addEventListener('click', () => fireAttack(heroPet()));
}

/* ---------- auto-fit + collapse/expand ---------- */
let lastFitH = 0;
function fitToContent() {
  if (!window.trackpad || !window.trackpad.fit) return;
  if (document.body.classList.contains('collapsed')) return;
  const h = document.getElementById('app').offsetHeight;
  if (h && Math.abs(h - lastFitH) > 2) { lastFitH = h; window.trackpad.fit(h); }
}
function applyMode(m) {
  const collapsed = m === 'collapsed';
  document.body.classList.toggle('collapsed', collapsed);
  document.body.classList.toggle('expanded', !collapsed);
  if (!collapsed) { lastFitH = 0; requestAnimationFrame(fitToContent); }
}
function setMode(m) { applyMode(m); if (window.trackpad && window.trackpad.setMode) window.trackpad.setMode(m); }
function setupPetDrag() {
  const el = document.getElementById('collapsed');
  let d = null;
  el.addEventListener('mousedown', (e) => { if (e.button === 0) d = { sx: e.screenX, sy: e.screenY, moved: false }; });
  window.addEventListener('mousemove', (e) => {
    if (!d) return;
    const dx = e.screenX - d.sx, dy = e.screenY - d.sy;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.moved) { if (window.trackpad && window.trackpad.dragBy) window.trackpad.dragBy(dx, dy); d.sx = e.screenX; d.sy = e.screenY; }
  });
  window.addEventListener('mouseup', () => {
    if (!d) return; const click = !d.moved; d = null;
    if (click) fireAttack(document.querySelector('.pet-host-lg .pet-svg'), () => setMode('expanded')); // play on the icon, THEN open
  });
}

/* ---------- animation loop ---------- */
function frame(now) {
  for (const [el, a] of tweens) {
    const p = Math.min(1, (now - a.start) / a.dur);
    const v = a.from + (a.to - a.from) * easeOut(p);
    el.textContent = a.fmt(v); el._v = v;
    if (p >= 1) tweens.delete(el);
  }
  if (snap) {
    const c = $('chart');
    if (period === 'today') drawSpark(c, snap.spark, snap.burnPerMin, now);
    else drawBars(c, period === 'd7' ? snap.daily.slice(-7) : snap.daily);
  }
  requestAnimationFrame(frame);
}

/* ---------- boot ---------- */
function boot() {
  requestAnimationFrame(frame);
  const tpl = document.getElementById('petTpl');
  if (tpl) document.querySelectorAll('.pet-host').forEach((h) => h.appendChild(tpl.content.cloneNode(true)));
  window._pets = Array.from(document.querySelectorAll('.pet-svg'));

  try { period = localStorage.getItem('tt-period') || 'today'; } catch (_e) {}
  try { inputMode = localStorage.getItem('tt-inmode') || 'all'; } catch (_e) {}
  for (const b of document.querySelectorAll('.seg-btn')) {
    b.addEventListener('click', () => { period = b.dataset.period; try { localStorage.setItem('tt-period', period); } catch (_e) {} renderPeriod(); });
  }
  $('inTile').addEventListener('click', () => {
    inputMode = inputMode === 'fresh' ? 'all' : 'fresh';
    try { localStorage.setItem('tt-inmode', inputMode); } catch (_e) {}
    renderPeriod();
  });
  renderPeriod(); // mark active tab before first data

  $('collapseBtn').addEventListener('click', () => setMode('collapsed'));
  setupPetDrag();
  setupPetInteractions();

  if (window.trackpad) {
    window.trackpad.onInit((d) => applyMode(d && d.mode === 'collapsed' ? 'collapsed' : 'expanded'));
    window.trackpad.onStatus(setStatus);
    window.trackpad.onSnapshot(render);
    $('closeBtn').addEventListener('click', () => window.trackpad.quit());
    window.trackpad.ready();
  } else {
    applyMode('expanded');
    startMock();
  }
}

/* Mock seeded with real measured figures so the preview mirrors reality. */
function startMock() {
  setStatus({ phase: 'live' });
  const base = {
    today: { in: 187121, out: 536330, cw: 6550160, cr: 129883466, cost: 141.34 },
    d7: { in: 3207152, out: 4474719, cw: 47840627, cr: 987975745, cost: 1117.25 },
    d30: { in: 6531519, out: 12178495, cw: 169909917, cr: 3801486198, cost: 3886.64 },
  };
  const daily = Array.from({ length: 30 }, (_, i) => 60e6 + Math.sin(i / 3) * 35e6 + (i / 30) * 90e6 + Math.random() * 25e6);
  let phase = 0;
  const tick = () => {
    phase += 1;
    const burn = Math.max(0, 3500 + Math.sin(phase / 2) * 3200 + (Math.random() - 0.5) * 2600);
    const spark = Array.from({ length: 60 }, (_, i) => {
      const lull = i < 22 ? 0.25 : 1;
      return Math.max(0, (8e5 + Math.sin((i + phase) / 4) * 6e5 + Math.random() * 9e5) * lull);
    });
    render({ now: Date.now(), today: base.today, d7: base.d7, d30: base.d30, spark, daily, burnPerMin: burn, lastEventTs: Date.now() });
  };
  tick();
  setInterval(tick, 2000);
}

document.addEventListener('DOMContentLoaded', boot);
