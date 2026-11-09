import { createStore } from './store.js';
import { analysePosture, scoreSelfAssessment, combine, RULES_VERSION, LM } from './scoring.js';
import { detect, fileToImage, loadModels, MODEL_VERSION } from './pose.js';

/* ---------- helpers ---------- */
const P = {
  home: 'M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1z',
  check: 'M6 3h8a1 1 0 0 1 1 1v13H5V4a1 1 0 0 1 1-1zM8 3v2h4V3M7.5 10l1.8 1.8L13 8',
  camera: 'M3 7h3l1.5-2h5L14 7h3v9H3zM10 14a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 10 14z',
  report: 'M5 3h7l3 3v11H5zM12 3v3h3M8 10h5M8 13h5',
  bell: 'M5 14V9a5 5 0 0 1 10 0v5l1.5 2h-13zM8.5 17.5a1.8 1.8 0 0 0 3 0',
  grid: 'M3 3h6v6H3zM11 3h6v4h-6zM11 9h6v8h-6zM3 11h6v6H3z',
  alert: 'M10 3 18 17H2zM10 8v4M10 14.5v.5',
  users: 'M7.5 9a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6zM2.5 16.5c.6-3 2.6-4.5 5-4.5s4.4 1.5 5 4.5M13 4a2.6 2.6 0 0 1 0 5M15 12c1.4.6 2.2 2 2.5 4.5',
  shield: 'M10 2.5 16 5v5c0 3.8-2.6 6.4-6 7.5-3.4-1.1-6-3.7-6-7.5V5z',
  list: 'M7 5h10M7 10h10M7 15h10M3 5h1M3 10h1M3 15h1',
  arrow: 'M6 14 14 6M7.5 6H14v6.5',
  upload: 'M10 13V4M6.5 7.5 10 4l3.5 3.5M4 13v3h12v-3',
  info: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 9v4.5M10 6.5v.5'
};
const ic = (n, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="${P[n]}"/></svg>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Risk levels come from stored data, so only known values reach class names and labels.
const SEV = ['Low', 'Medium', 'High'];
const sevOk = s => SEV.includes(s) ? s : 'Low';
const pill = c => SEV.includes(c) ? `<span class="pill ${c}">${c} risk</span>` : '<span class="pill Info">Not scored</span>';
const fmtDate = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const cls = a => a?.corrected_class || a?.risk_class;
function toast(msg) {
  const t = document.getElementById('toast-root');
  t.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.innerHTML = '', 3500);
}
function scoreDial(v, c) {
  const r = 42, C = 2 * Math.PI * r, col = c === 'High' ? 'var(--high)' : c === 'Medium' ? 'var(--med)' : 'var(--low)';
  return `<svg width="104" height="104" viewBox="0 0 104 104" aria-hidden="true"><circle cx="52" cy="52" r="${r}" fill="none" stroke="var(--tint-2)" stroke-width="8"/><circle cx="52" cy="52" r="${r}" fill="none" stroke="${col}" stroke-width="8" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - v / 100)}" transform="rotate(-90 52 52)"/><text x="52" y="58" text-anchor="middle" font-family="Poppins,sans-serif" font-size="24" font-weight="300" fill="var(--fg)">${v}</text></svg>`;
}

const STEPS = [
  { t: 'Desk setup', qs: ['Is your desk surface at or just below elbow height when your shoulders are relaxed?', 'Do you have enough leg room without objects under the desk?', 'Are frequently used items within forearm reach?'] },
  { t: 'Chair adjustments', qs: ['Are your feet flat on the floor (or on a footrest) with knees about level with hips?', 'Does the backrest support the curve of your lower back?', 'Is there a two-to-three-finger gap between the seat edge and the back of your knees?'] },
  { t: 'Monitor positioning', qs: ['Is the top line of text at or just below eye level?', 'Is the screen about an arm\'s length away?', 'Is the screen free of glare from windows or lights?'] },
  { t: 'Keyboard and mouse', qs: ['Are your wrists straight while typing?', 'Is the mouse right next to the keyboard?', 'Do you use keyboard shortcuts to reduce mouse use?'] }
];
const STEP_AREA = ['Chair and desk', 'Chair and desk', 'Monitor height and distance', 'Keyboard and mouse'];
const FIXES = {
  '0-0': 'Adjust the chair or desk so the desk surface is at elbow height. Use a footrest if your feet no longer reach the floor.',
  '0-1': 'Clear storage boxes and cables from under the desk so your legs can move freely.',
  '0-2': 'Move your phone, notepad and mouse within forearm reach.',
  '1-0': 'Lower the seat until your feet are flat, or request a footrest.',
  '1-1': 'Raise the lumbar support into the curve of your lower back and sit fully back.',
  '1-2': 'Slide the seat pan back so two to three fingers fit behind your knees.',
  '2-0': 'Raise the monitor so the top line of text is at eye level.',
  '2-1': 'Move the screen back to about an arm\'s length (50–75 cm).',
  '2-2': 'Turn the screen side-on to the window or lower the blinds.',
  '3-0': 'Lower the keyboard feet so your wrists stay straight.',
  '3-1': 'Place the mouse right beside the keyboard, inside shoulder width.',
  '3-2': 'Learn five shortcuts: copy, paste, undo, find and switch window.'
};
const EXERCISES = {
  break: ['Micro-break', 'Stand up and look at something far away for 30 seconds.'],
  stretch: ['Stretch: chin tucks', 'Sit tall, draw your chin straight back, hold 3 s. Repeat 8 times.'],
  posture: ['Posture check', 'Slide back in your chair and bring your head over your shoulders.']
};

/* ---------- state and routing ---------- */
const S = { store: null, me: null, settings: {}, answers: {}, step: 0, image: null, analysing: false, status: '', issues: null, currentId: null, filters: {}, delStep: null, report: null, timers: [] };
const ROUTES = {
  home: { role: 'employee', label: 'Home', icon: 'home' },
  check: { role: 'employee', label: 'Self-assessment', icon: 'check' },
  capture: { role: 'employee', label: 'AI posture check', icon: 'camera' },
  history: { role: 'employee', label: 'My results', icon: 'report' },
  reminders: { role: 'employee', label: 'Reminders', icon: 'bell' },
  mydata: { role: 'employee', label: 'My data', icon: 'shield' },
  result: { role: 'employee', label: 'Result', icon: 'report', hidden: true, parent: 'history' },
  dashboard: { role: 'hse', label: 'Dashboard', icon: 'grid' },
  followup: { role: 'hse', label: 'High-risk follow-up', icon: 'alert' },
  reviews: { role: 'hse', label: 'Specialist reviews', icon: 'check' },
  users: { role: 'admin', label: 'Users & roles', icon: 'users' },
  policies: { role: 'admin', label: 'Policies', icon: 'shield' },
  audit: { role: 'admin', label: 'Audit log', icon: 'list' }
};
const FIRST = { employee: 'home', hse: 'dashboard', admin: 'users' };
// HSE and admins can use the employee screens for themselves; the dashboard is shared by HSE and admin.
const allowed = (route, role) => {
  const r = ROUTES[route]; if (!r) return false;
  if (r.role === 'employee') return true;
  if (route === 'dashboard') return role === 'hse' || role === 'admin';
  return r.role === role;
};
const go = r => { if (location.hash.slice(1) === r) render(); else location.hash = r; };

async function render() {
  const view = document.getElementById('view');
  if (!S.me) return renderSignIn();
  let r = location.hash.slice(1);
  if (!allowed(r, S.me.role)) r = FIRST[S.me.role];
  document.querySelector('.app').classList.remove('signin');
  const navRoutes = Object.entries(ROUTES).filter(([k, v]) => !v.hidden && (v.role === S.me.role || (S.me.role === 'admin' && k === 'dashboard')));
  const own = S.me.role !== 'employee' ? Object.entries(ROUTES).filter(([k, v]) => v.role === 'employee' && !v.hidden && ['home', 'history', 'mydata'].includes(k)) : [];
  const active = ROUTES[r].parent || r;
  document.getElementById('nav').innerHTML = navRoutes.map(([k, v]) => `<a href="#${k}" ${k === active ? 'aria-current="page"' : ''}>${ic(v.icon)}<span>${v.label}</span></a>`).join('')
    + (own.length ? `<div class="label" style="margin:12px 0 4px 10px">My workstation</div>` + own.map(([k, v]) => `<a href="#${k}" ${k === active ? 'aria-current="page"' : ''}>${ic(v.icon)}<span>${v.label}</span></a>`).join('') : '');
  document.getElementById('who-name').textContent = S.me.full_name || S.me.email;
  document.getElementById('who-role').textContent = { employee: 'Employee', hse: 'Occupational Health – HSE', admin: 'Administrator' }[S.me.role] + (S.me.department ? ` · ${S.me.department}` : '');
  document.getElementById('who-av').textContent = (S.me.full_name || 'U').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('crumb').textContent = ROUTES[r].label;
  view.innerHTML = `<p class="muted"><span class="spinner"></span> Loading…</p>`;
  try {
    S.settings = await S.store.settings();
    view.innerHTML = await VIEWS[r]();
    BIND[r]?.(view);
  } catch (e) {
    view.innerHTML = `<div class="head"><div><h1>Something went wrong</h1><p class="err">${esc(e.message)}</p></div></div><div class="row"><button class="btn" id="retry">Try again</button></div>`;
    view.querySelector('#retry').onclick = render;
  }
  if (S.lastRoute !== r) window.scrollTo(0, 0);
  S.lastRoute = r;
}
window.addEventListener('hashchange', render);

/* ---------- sign-in ---------- */
function renderSignIn() {
  document.querySelector('.app').classList.add('signin');
  const local = S.store.mode === 'local';
  document.getElementById('view').innerHTML = `
  <div class="card signin-card">
    <div class="brand" style="padding:0"><div class="brand-mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#fff" stroke-width="1.6"><circle cx="9" cy="3.5" r="2"/><path d="M9 6v6l-3 4M9 12l3 4M5 8.5h8"/></svg></div><span class="brand-name">ErgoSense</span></div>
    <div><h1 style="font-size:26px">Sign in</h1><p class="muted">${local ? 'Local demo mode: no account needed. Data stays in this browser, with sample colleagues so the dashboard has data.' : 'Enter your work email. We send you a sign-in link; no password needed.'}</p></div>
    ${local ? `
      <div class="stack">${[['me', 'Employee'], ['hse', 'HSE / OH specialist'], ['admin', 'Administrator']].map(([id, l]) => `<button class="btn ${id === 'me' ? 'blue' : 'ghost'}" data-demo="${id}">${ic('arrow', 18)} Continue as ${l}</button>`).join('')}</div>
      <button class="link" id="reset-demo">Reset demo data</button>` : `
      <form id="signin-form" class="stack" novalidate>
        <label class="field"><span>Work email</span><input type="email" id="email" autocomplete="email" required placeholder="name@company.com"></label>
        <p class="err" id="signin-err" hidden></p>
        <button class="btn blue" type="submit">${ic('arrow', 18)} Send sign-in link</button>
      </form>`}
    <p class="muted" style="font-size:12px">Photos are analysed on your device and never uploaded. Results are ergonomic guidance, not a medical assessment.</p>
  </div>`;
  const v = document.getElementById('view');
  v.querySelectorAll('[data-demo]').forEach(b => b.onclick = async () => { await S.store.signIn(b.dataset.demo); S.me = await S.store.session(); go(FIRST[S.me.role]); });
  const reset = v.querySelector('#reset-demo'); if (reset) reset.onclick = async () => { await S.store.reset(); toast('Demo data reset.'); };
  const form = v.querySelector('#signin-form');
  if (form) form.onsubmit = async e => {
    e.preventDefault();
    const email = v.querySelector('#email').value.trim(), err = v.querySelector('#signin-err');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = 'Enter a valid email address, like name@company.com.'; err.hidden = false; return; }
    try { await S.store.signIn(email); v.querySelector('.signin-card').innerHTML = `<h1 style="font-size:26px">Check your email</h1><p>We sent a sign-in link to <b>${esc(email)}</b>. Open it on this device to continue.</p>`; }
    catch (x) { err.textContent = x.message; err.hidden = false; }
  };
}

/* ---------- employee views ---------- */
const VIEWS = {}, BIND = {};

function latestOf(list, kind) { return list.find(a => a.kind === kind) || null; }
function summary(list) {
  const ai = latestOf(list, 'ai'), self = latestOf(list, 'self');
  const c = combine(ai && { score: ai.score, riskClass: cls(ai) }, self && { score: self.score, riskClass: self.risk_class });
  return { ai, self, combined: c };
}

VIEWS.home = async () => {
  const list = await S.store.myAssessments();
  const { ai, self, combined } = summary(list);
  const last = list[0];
  const due = last ? new Date(Date.parse(last.created_at) + Number(S.settings.reassess_days || 90) * 864e5) : null;
  const first = (S.me.full_name || '').split(' ')[0];
  return `
  <div class="head"><div><h1>Hello${first ? ', ' + esc(first) : ''}</h1><p>${combined ? 'Your latest results are below. Work through the recommendations, then re-check your posture.' : 'Start with the 4-minute self-assessment, then run an AI posture check from a side photo.'}</p></div>
  <button class="btn blue" data-go="${self ? 'capture' : 'check'}">${ic(self ? 'camera' : 'check', 18)} ${self ? 'Run AI posture check' : 'Start self-assessment'}</button></div>
  <div class="grid g4">
    <div class="card kpi"><div class="label">Ergo score</div>${combined ? `<div class="row" style="gap:10px"><div class="v num">${combined.score}<small>/100</small></div>${pill(combined.riskClass)}</div><div class="d">${ai && self ? 'AI check 70% · self-assessment 30%' : ai ? 'From AI check only' : 'From self-assessment only'}</div>` : `<div class="v">–</div><div class="d">No assessment yet</div>`}</div>
    <div class="card kpi"><div class="label">AI posture check</div><div class="v num" style="font-size:28px;line-height:1.6">${ai ? fmtDate(ai.created_at) : 'Not done'}</div><div class="d">${ai ? `Score ${ai.score} · ${cls(ai)} risk` : S.me.ai_consent ? 'Ready when you are' : 'Needs your consent first'}</div></div>
    <div class="card kpi"><div class="label">Self-assessment</div><div class="v num" style="font-size:28px;line-height:1.6">${self ? fmtDate(self.created_at) : 'Not done'}</div><div class="d">${self ? `Score ${self.score} · ${self.risk_class} risk` : 'About 4 minutes'}</div></div>
    <div class="card kpi"><div class="label">Next assessment</div><div class="v num" style="font-size:28px;line-height:1.6">${due ? fmtDate(due) : 'After your first'}</div><div class="d">Every ${S.settings.reassess_days || 90} days</div></div>
  </div>
  ${last ? `<div class="card"><div class="row between"><h2>Latest findings</h2><button class="link" data-open="${last.id}">Open result ${ic('arrow', 16)}</button></div>
    ${(last.findings || []).filter(f => f.severity !== 'Low').slice(0, 4).map(f => `<div class="finding"><span class="sev ${sevOk(f.severity)}"></span><div><h3>${esc(f.label)}</h3><p class="measure">${esc(f.area || '')}${f.value !== null && f.value !== undefined ? ` · ${esc(f.value)}${esc(f.unit || '')}` : ''}</p></div>${pill(f.severity)}</div>`).join('') || '<p class="muted" style="padding:12px 0">No medium or high findings in this result.</p>'}</div>` : ''}`;
};

VIEWS.check = async () => {
  if (S.checkDone) {
    const failed = Object.entries(S.answers).filter(([, a]) => a === 'No' || a === 'Partly');
    return `<div class="head"><div><h1>Your setup recommendations</h1><p>Saved. Each recommendation comes from a question you answered No or Partly.</p></div>
      <div class="row"><button class="btn ghost" id="redo">Edit answers</button><button class="btn blue" data-go="capture">${ic('camera', 18)} Continue to AI posture check</button></div></div>
      <div class="card"><h2>${failed.length} things to adjust</h2>${failed.map(([k, a]) => { const [i, j] = k.split('-').map(Number); return `<div class="rec"><span class="pill ${a === 'No' ? 'Medium' : 'Low'}" style="min-width:64px">${a}</span><div><p style="color:var(--fg)">${FIXES[k]}</p><p class="muted" style="font-size:12px">Step ${i + 1}, ${STEPS[i].t}: “${STEPS[i].qs[j]}”</p></div></div>`; }).join('') || '<p class="muted" style="padding:16px 0">Every check passed.</p>'}</div>`;
  }
  const st = STEPS[S.step], n = Object.values(S.answers).filter(Boolean).length, last = S.step === STEPS.length - 1;
  return `
  <div class="head"><div><h1>Workstation self-assessment</h1><p>Four short steps, about 4 minutes.</p></div><span class="muted num">${n} of 12 answered</span></div>
  <div class="steps">${STEPS.map((s, i) => `<button type="button" data-step="${i}" ${i === S.step ? 'aria-current="step"' : ''}><span class="n">Step ${i + 1}</span><span class="t">${s.t}</span></button>`).join('')}</div>
  <div class="card">
    ${st.qs.map((q, j) => { const k = `${S.step}-${j}`, a = S.answers[k]; return `<div class="q"><p>${q}</p><div class="seg" role="group" aria-label="Answer">${['Yes', 'Partly', 'No'].map(o => `<button type="button" id="q-${k}-${o}" data-q="${k}" data-a="${o}" aria-pressed="${a === o}">${o}</button>`).join('')}</div></div>`; }).join('')}
    ${S.checkError ? `<p role="alert" class="err" style="margin-top:16px">${S.checkError}</p>` : ''}
    <div class="row between" style="margin-top:20px"><button class="btn ghost sm" id="prev" ${S.step === 0 ? 'disabled' : ''}>Back</button>
    ${last ? `<button class="btn blue" id="finish">${ic('arrow', 18)} Save and see recommendations</button>` : `<button class="btn" id="next">${ic('arrow', 18)} Next step</button>`}</div>
  </div>`;
};
BIND.check = v => {
  const on = (id, f) => { const b = v.querySelector('#' + id); if (b) b.onclick = f; };
  on('redo', () => { S.checkDone = false; render(); });
  v.querySelectorAll('[data-step]').forEach(b => b.onclick = () => { S.step = +b.dataset.step; render(); });
  v.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { S.answers[b.dataset.q] = b.dataset.a; S.checkError = null; render(); });
  on('prev', () => { S.step--; render(); });
  on('next', () => { S.step++; render(); });
  on('finish', async () => {
    const missing = 12 - Object.values(S.answers).filter(Boolean).length;
    if (missing) { S.checkError = `Answer the remaining ${missing} question${missing > 1 ? 's' : ''} to see your recommendations.`; return render(); }
    const s = scoreSelfAssessment(S.answers);
    const findings = s.failed.map(k => { const [i, j] = k.split('-').map(Number); return { area: STEP_AREA[i], key: 'self-' + k, label: STEPS[i].qs[j], value: null, unit: '', severity: S.answers[k] === 'No' ? 'Medium' : 'Low', recommendation: FIXES[k] }; });
    try {
      await S.store.saveAssessment({ kind: 'self', score: s.score, risk_class: s.riskClass, findings, self_answers: S.answers, rules_version: RULES_VERSION });
      S.checkDone = true; toast('Self-assessment saved.'); render();
    } catch (e) { toast(e.message); }
  });
};

VIEWS.capture = async () => {
  if (S.settings.ai_suspended === true || S.settings.ai_suspended === 'true') return `
    <div class="head"><div><h1>AI posture check</h1><p>AI analysis is paused by Occupational Health – HSE. Nothing is wrong with your data.</p></div></div>
    <div class="row"><button class="btn" data-go="check">${ic('check', 18)} Go to self-assessment</button></div>`;
  if (!S.me.ai_consent) return `
    <div class="head"><div><h1>AI posture check</h1><p>Before the first check, please read how your photo is used.</p></div></div>
    <div class="card stack" style="max-width:720px">
      <div class="notice">${ic('shield', 20)}<p>Your photo is analysed by an AI model running in this browser. It finds 33 body keypoints and your screen, keyboard and mouse. Only the keypoints and scores are saved. The photo never leaves your device. You can withdraw consent at any time in My data, and everything except the AI check keeps working.</p></div>
      <label class="check"><input type="checkbox" id="consent"><span>I agree to AI posture analysis of my workstation photos.</span></label>
      <div class="row"><button class="btn blue" id="give-consent" disabled>${ic('arrow', 18)} Give consent</button><button class="btn ghost" data-go="check">Use self-assessment only</button></div>
    </div>`;
  return `
  <div class="head"><div><h1>AI posture check</h1><p>Use one photo taken from your side while you work. The model runs on this device; the photo is not uploaded.</p></div></div>
  <div class="grid g2">
    <div class="card stack">
      ${S.camOn ? `<div class="canvas-wrap" style="position:relative"><video id="cam" autoplay playsinline muted style="width:100%;display:block;border:1px solid var(--rule);background:#000"></video><div id="countdown" aria-live="assertive" style="position:absolute;inset:0;display:grid;place-items:center;font:300 96px/1 var(--display);color:#fff;text-shadow:0 2px 12px rgba(0,0,0,.6)"></div><div class="frame-guide"><span>Keep head, hips and knees inside</span></div></div>
        <div class="row"><label class="field"><span>Timer</span><select id="cam-delay"><option value="3">3 s</option><option value="10" selected>10 s</option><option value="20">20 s</option></select></label><button class="btn blue sm" id="cam-shoot">${ic('camera', 16)} Start timer</button><button class="btn ghost sm" id="cam-close">Close camera</button></div>`
      : S.image ? `<div class="canvas-wrap"><canvas id="preview"></canvas></div>` : `<div class="drop"><div style="text-align:center;padding:24px" class="stack"><div style="color:var(--accent);display:flex;justify-content:center">${ic('camera', 36)}</div><p style="color:var(--fg)">Side view, head to knees in frame</p><p class="muted" style="font-size:12px">JPG or PNG. On a phone, Take photo opens the camera.</p></div><div class="frame-guide"><span>Keep head, hips and knees inside</span></div></div>`}
      <div class="row">
        <label class="btn ghost sm" for="photo-in" style="cursor:pointer">${ic('upload', 16)} ${S.image ? 'Choose another photo' : 'Choose photo'}</label>
        <input type="file" id="photo-in" accept="image/*" class="sr-only">
        <label class="btn ghost sm" for="photo-cam" style="cursor:pointer">${ic('camera', 16)} Take photo</label>
        <input type="file" id="photo-cam" accept="image/*" capture="environment" class="sr-only">
        ${!S.camOn && navigator.mediaDevices?.getUserMedia ? `<button class="btn ghost sm" id="cam-open">${ic('camera', 16)} Use webcam with timer</button>` : ''}
      </div>
    </div>
    <div class="card stack">
      <div class="label">For an accurate result</div>
      <ul style="margin:0;padding-left:18px">
        <li>Ask a colleague, or put your phone 2–3 m away at desk height, to your side</li>
        <li>Sit as you normally work, hands on the keyboard</li>
        <li>Keep the screen, keyboard and chair visible</li>
      </ul>
      ${S.issues ? `<div class="notice" role="alert">${ic('alert', 20)}<div>${S.issues.map(i => `<p>${esc(i)}</p>`).join('')}</div></div>` : ''}
      ${S.analysing ? `<p><span class="spinner"></span> ${esc(S.status)}</p>` : ''}
      <button class="btn blue" id="analyse" ${S.image && !S.analysing ? '' : 'disabled'}>${ic('arrow', 18)} Analyse my posture</button>
      <p class="muted" style="font-size:12px">Model: ${MODEL_VERSION}. Rules: ${RULES_VERSION}.</p>
    </div>
  </div>`;
};
BIND.capture = v => {
  const c = v.querySelector('#consent'), g = v.querySelector('#give-consent');
  if (c) { c.onchange = () => g.disabled = !c.checked; g.onclick = async () => { S.me = await S.store.updateProfile({ ai_consent: true }); toast('Consent saved.'); render(); }; return; }
  const pick = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { S.image = await fileToImage(f); S.issues = null; render(); loadModels().catch(() => {}); } catch (x) { S.issues = [x.message]; render(); }
  };
  v.querySelectorAll('#photo-in, #photo-cam').forEach(i => i.onchange = pick);
  if (S.image && !S.camOn) drawPose(v.querySelector('#preview'), S.image, null);
  bindCamera(v);
  const a = v.querySelector('#analyse');
  if (a) a.onclick = async () => {
    S.analysing = true; S.issues = null; S.status = 'Starting…'; render();
    const status = m => { S.status = m; const p = document.querySelector('.view .spinner')?.parentElement; if (p) p.lastChild.textContent = ' ' + m; };
    try {
      const d = await detect(S.image, status);
      const r = analysePosture(d);
      if (!r.ok) { S.issues = r.issues; S.analysing = false; return render(); }
      status('Saving results…');
      const keypoints = d.landmarks.map(p => [+p.x.toFixed(3), +p.y.toFixed(3), +(p.visibility ?? 0).toFixed(2)]);
      const findings = [...r.findings, ...r.notScored.map(t => ({ area: '', key: 'notScored', label: 'Not scored', value: null, unit: '', severity: 'Low', message: t }))];
      const row = await S.store.saveAssessment({ kind: 'ai', score: r.score, risk_class: r.riskClass, findings, keypoints, confidence: +r.visibility.toFixed(2), model_version: MODEL_VERSION, rules_version: r.rulesVersion });
      S.lastDetection = { id: row.id, detection: d, side: r.side };
      S.currentId = row.id; S.analysing = false; go('result');
    } catch (e) {
      const m = String(e?.message ?? e);
      S.issues = [/fetch|network|timed out|load/i.test(m) ? 'The AI model could not be loaded. Check your internet connection and try again.' : m];
      S.analysing = false; render();
    }
  };
};

// Live webcam with a self-timer, so a person can place a camera beside them and sit down.
// Frames stay in memory on this device, like uploaded photos.
function stopCamera() { S.camStream?.getTracks().forEach(t => t.stop()); S.camStream = null; S.camOn = false; clearInterval(S.camTimer); }
function bindCamera(v) {
  const open = v.querySelector('#cam-open');
  if (open) open.onclick = async () => {
    try {
      S.camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      S.camOn = true; S.issues = null; render();
    } catch (e) {
      S.issues = [e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow the camera in your browser settings, or upload a photo instead.' : 'No camera was found. Upload a photo instead.'];
      render();
    }
  };
  const video = v.querySelector('#cam');
  if (!video) return;
  video.srcObject = S.camStream;
  v.querySelector('#cam-close').onclick = () => { stopCamera(); render(); };
  v.querySelector('#cam-shoot').onclick = e => {
    e.target.disabled = true;
    let left = +v.querySelector('#cam-delay').value;
    const cd = v.querySelector('#countdown');
    cd.textContent = left;
    S.camTimer = setInterval(() => {
      left--; cd.textContent = left > 0 ? left : '';
      if (left > 0) return;
      clearInterval(S.camTimer);
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      const img = new Image();
      img.onload = () => { S.image = img; stopCamera(); render(); loadModels().catch(() => {}); };
      img.src = c.toDataURL('image/jpeg', 0.92);
    }, 1000);
  };
}
window.addEventListener('hashchange', () => { if (S.camOn && location.hash !== '#capture') stopCamera(); });

// Draws the photo with the detected skeleton and workstation boxes. Stays on this device.
function drawPose(canvas, img, det, side = 'left') {
  if (!canvas || !img) return;
  const w = Math.min(img.naturalWidth, 1200), h = Math.round(img.naturalHeight * w / img.naturalWidth), k = w / img.naturalWidth;
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  if (!det?.landmarks) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2979FF';
  const lm = n => det.landmarks[LM[side + n] ?? LM[n]];
  const pt = n => [lm(n).x * w, lm(n).y * h];
  // Draw only joints the model actually sees inside the photo; hidden legs are left out.
  const vis = n => { const p = lm(n), min = ['Hip', 'Knee', 'Ankle'].includes(n) && n !== 'Hip' ? 0.8 : 0.5; return (p.visibility ?? 1) >= min && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1; };
  g.lineWidth = Math.max(3, w / 200); g.strokeStyle = accent; g.fillStyle = '#fff';
  [['Ear', 'Shoulder'], ['Shoulder', 'Elbow'], ['Elbow', 'Wrist'], ['Wrist', 'Index'], ['Shoulder', 'Hip'], ['Hip', 'Knee'], ['Knee', 'Ankle']]
    .filter(([a, b]) => vis(a) && vis(b)).forEach(([a, b]) => { g.beginPath(); g.moveTo(...pt(a)); g.lineTo(...pt(b)); g.stroke(); });
  ['Ear', 'Shoulder', 'Elbow', 'Wrist', 'Hip', 'Knee', 'Ankle'].filter(vis).forEach(n => { g.beginPath(); g.arc(...pt(n), Math.max(4, w / 150), 0, 7); g.fill(); g.stroke(); });
  g.font = `${Math.max(12, w / 60)}px Inter, sans-serif`;
  det.objects.forEach(o => { g.strokeStyle = '#FFB628'; g.strokeRect(o.box.x * k, o.box.y * k, o.box.width * k, o.box.height * k); g.fillStyle = '#FFB628'; g.fillText(o.label === 'tv' ? 'monitor' : o.label, o.box.x * k + 4, o.box.y * k + 16); });
}

async function resultHtml(a, own) {
  const reviews = own ? (await S.store.myReviews()).filter(r => r.assessment_id === a.id) : [];
  const rv = reviews[0];
  const areas = ['Sitting posture', 'Monitor height and distance', 'Keyboard and mouse', 'Chair and desk'].map(area => {
    const f = (a.findings || []).filter(x => x.area === area && (x.value !== null || x.key === 'laptopOnly' || a.kind === 'self'));
    const sev = f.length ? f.reduce((m, x) => ({ Low: 0, Medium: 1, High: 2 })[x.severity] > ({ Low: 0, Medium: 1, High: 2 })[m] ? x.severity : m, 'Low') : null;
    return [area, sev];
  });
  const showCanvas = own && S.lastDetection?.id === a.id && S.image;
  return `
  <div class="grid g-main">
    <div class="card">${showCanvas ? `<div class="label">Detected posture (shown on this device only)</div><div class="canvas-wrap" style="margin-top:8px"><canvas id="result-canvas"></canvas></div>` : `<div class="label">${a.kind === 'ai' ? 'AI posture check' : 'Self-assessment'} · ${fmtDate(a.created_at)}</div><p class="muted" style="margin-top:8px">${a.kind === 'ai' ? 'The photo is not stored, so only the measurements are shown.' : 'Based on your answers to 12 workstation questions.'}</p>`}</div>
    <div class="card stack"><div class="label">Overall</div>
      <div class="score-ring">${scoreDial(a.score, cls(a))}<div class="stack" style="gap:6px">${pill(cls(a))}${a.corrected_class ? `<p class="muted" style="font-size:12px">Corrected by an OH specialist (AI said ${a.risk_class})</p>` : ''}</div></div>
      <div class="divider"></div>
      ${areas.map(([n, c]) => `<div class="row between"><span style="color:var(--fg)">${n}</span>${pill(c)}</div>`).join('')}
      ${a.kind === 'ai' ? `<p class="measure">Confidence ${a.confidence ?? '–'} · ${esc(a.rules_version || '')}</p>` : ''}
      <p class="muted" style="font-size:12px">Ergonomic guidance, not a medical assessment.</p>
    </div>
  </div>
  ${own && a.kind === 'ai' ? (rv ? `<div class="card stack"><div class="row between"><h2>Specialist review</h2><span class="pill ${rv.status === 'Resolved' ? 'Low' : 'Info'}">${rv.status}</span></div><p>${rv.status === 'Resolved' ? esc(rv.decision) : 'An Occupational Health specialist will review this result, usually within 3 working days.'}</p></div>`
    : S.reviewOpen ? `<div class="card stack"><h2>Request specialist review</h2><label class="field"><span>What looks wrong? (optional)</span><textarea id="rv-comment" rows="3" maxlength="1000" placeholder="For example: I use a footrest that is not visible in the photo."></textarea></label><div class="row"><button class="btn blue" id="rv-send">Send request</button><button class="btn ghost" id="rv-cancel">Cancel</button></div></div>`
    : `<div class="card row between"><div><h2>Does this look wrong?</h2><p class="muted">Ask an Occupational Health specialist to review the AI result.</p></div><button class="btn ghost" id="rv-open">Request specialist review</button></div>`) : ''}
  <div class="grid g2">
    <div class="card"><h2>Findings</h2>${(a.findings || []).map(f => `<div class="finding"><span class="sev ${f.key === 'notScored' ? '' : sevOk(f.severity)}" style="${f.key === 'notScored' ? 'background:var(--rule)' : ''}"></span><div class="stack" style="gap:2px"><h3>${esc(f.label)}</h3><p class="measure">${esc(f.area || '')}${f.value !== null && f.value !== undefined ? ` · ${esc(f.value)}${esc(f.unit || '')}` : ''}</p>${f.message ? `<p>${esc(f.message)}</p>` : ''}</div>${pill(f.key === 'notScored' ? null : f.severity)}</div>`).join('') || '<p class="muted">No findings.</p>'}</div>
    <div class="card"><h2>What to change</h2>${[...new Set((a.findings || []).filter(f => f.severity !== 'Low' && f.recommendation).map(f => f.recommendation))].map(t => `<div class="rec"><span style="color:var(--accent);flex:none;margin-top:4px">${ic('arrow', 16)}</span><p style="color:var(--fg)">${esc(t)}</p></div>`).join('') || '<p class="muted" style="padding:12px 0">Nothing to change. Keep it up.</p>'}</div>
  </div>`;
}

VIEWS.result = async () => {
  const list = await S.store.myAssessments();
  const a = list.find(x => x.id === S.currentId) || list[0];
  if (!a) return `<div class="empty">No results yet. <button class="link" data-go="check">Start with the self-assessment</button></div>`;
  S.currentId = a.id;
  return `<div class="head"><div><h1>${a.kind === 'ai' ? 'AI posture result' : 'Self-assessment result'}</h1><p>${fmtDate(a.created_at)}</p></div><div class="row"><button class="btn ghost" data-go="history">All results</button><button class="btn blue" data-go="capture">${ic('camera', 18)} New AI check</button></div></div>` + await resultHtml(a, true);
};
BIND.result = v => {
  if (S.lastDetection?.id === S.currentId) drawPose(v.querySelector('#result-canvas'), S.image, S.lastDetection.detection, S.lastDetection.side);
  const on = (id, f) => { const b = v.querySelector('#' + id); if (b) b.onclick = f; };
  on('rv-open', () => { S.reviewOpen = true; render(); });
  on('rv-cancel', () => { S.reviewOpen = false; render(); });
  on('rv-send', async () => { try { await S.store.requestReview(S.currentId, v.querySelector('#rv-comment').value.trim()); S.reviewOpen = false; toast('Review requested.'); render(); } catch (e) { toast(e.message); } });
};

VIEWS.history = async () => {
  const list = await S.store.myAssessments();
  return `<div class="head"><div><h1>My results</h1><p>Visible only to you and authorised Occupational Health – HSE staff. Never used for appraisal or HR decisions.</p></div></div>
  ${list.length ? `<div class="tbl"><table><thead><tr><th>Date</th><th>Type</th><th>Score</th><th>Risk</th><th></th></tr></thead><tbody>${list.map(a => `<tr><td class="num">${fmtDate(a.created_at)}</td><td>${a.kind === 'ai' ? 'AI posture check' : 'Self-assessment'}</td><td class="num" style="color:var(--fg)">${a.score}</td><td>${pill(cls(a))}</td><td><button class="link" data-open="${a.id}">Open ${ic('arrow', 14)}</button></td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">No results yet. <button class="link" data-go="check">Start with the self-assessment</button></div>`}`;
};

VIEWS.reminders = async () => {
  const r = await S.store.reminders() || { profile: 'Balanced', break_min: 30, stretch_min: 60, posture_min: 45, start_time: '08:00', end_time: '16:00' };
  S.rem = { ...r, start_time: r.start_time.slice(0, 5), end_time: r.end_time.slice(0, 5) };
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  return `<div class="head"><div><h1>Reminders</h1><p>Reminders run while ErgoSense is open in a browser tab. A desktop agent for reminders outside the browser is planned.</p></div></div>
  <div class="grid g2">
    <div class="card stack"><h2>Your schedule</h2>
      <div class="chips">${['Light', 'Balanced', 'Active'].map(p => `<button type="button" data-profile="${p}" aria-pressed="${S.rem.profile === p}">${p}</button>`).join('')}</div>
      ${[['break_min', 'Micro-break'], ['stretch_min', 'Stretch'], ['posture_min', 'Posture check']].map(([k, l]) => `<div class="slider"><label for="${k}" style="color:var(--fg)">${l}</label><span></span><input type="range" id="${k}" min="10" max="180" step="5" value="${S.rem[k]}"><span class="num">every <b id="${k}-v">${S.rem[k]}</b> min</span></div>`).join('')}
      <div class="row" style="gap:16px"><label class="field"><span>Start</span><input type="time" id="start_time" value="${S.rem.start_time}"></label><label class="field"><span>End</span><input type="time" id="end_time" value="${S.rem.end_time}"></label></div>
      <p class="err" id="rem-err" role="alert" hidden></p>
      <div class="row"><button class="btn" id="save-rem">Save</button></div>
    </div>
    <div class="card stack"><h2>In this tab</h2>
      <p>${S.timers.length ? 'Reminders are running in this tab.' : 'Reminders are off in this tab.'} Desktop notifications: <b>${{ granted: 'allowed', denied: 'blocked in browser settings', default: 'not yet allowed', unsupported: 'not supported here' }[perm]}</b>.</p>
      <div class="row">${S.timers.length ? `<button class="btn ghost" id="stop-rem">Stop reminders</button>` : `<button class="btn blue" id="start-rem">${ic('bell', 18)} Start reminders</button>`}<button class="btn ghost" id="test-rem">Show a test reminder</button></div>
    </div>
  </div>`;
};
BIND.reminders = v => {
  const presets = { Light: [60, 120, 90], Balanced: [30, 60, 45], Active: [20, 40, 30] };
  v.querySelectorAll('[data-profile]').forEach(b => b.onclick = () => { const p = presets[b.dataset.profile]; Object.assign(S.rem, { profile: b.dataset.profile, break_min: p[0], stretch_min: p[1], posture_min: p[2] }); render(); });
  ['break_min', 'stretch_min', 'posture_min'].forEach(k => v.querySelector('#' + k).oninput = e => { S.rem[k] = +e.target.value; v.querySelector(`#${k}-v`).textContent = e.target.value; });
  v.querySelector('#save-rem').onclick = async () => {
    const st = v.querySelector('#start_time').value, en = v.querySelector('#end_time').value, err = v.querySelector('#rem-err');
    if (!st || !en || en <= st) { err.textContent = 'Working hours must end after they start.'; err.hidden = false; return; }
    Object.assign(S.rem, { start_time: st, end_time: en });
    const { user_id, updated_at, ...rest } = S.rem;
    try { await S.store.saveReminders(rest); toast('Reminders saved.'); if (S.timers.length) startReminders(); } catch (e) { toast(e.message); }
  };
  const on = (id, f) => { const b = v.querySelector('#' + id); if (b) b.onclick = f; };
  on('start-rem', async () => { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); startReminders(); render(); });
  on('stop-rem', () => { stopReminders(); render(); });
  on('test-rem', () => showReminder('stretch'));
};
function stopReminders() { S.timers.forEach(clearInterval); S.timers = []; }
function startReminders() {
  stopReminders();
  const inHours = () => { const t = new Date().toTimeString().slice(0, 5); return t >= S.rem.start_time && t < S.rem.end_time; };
  [['break', S.rem.break_min], ['stretch', S.rem.stretch_min], ['posture', S.rem.posture_min]]
    .forEach(([k, m]) => S.timers.push(setInterval(() => inHours() && showReminder(k), m * 60000)));
}
function showReminder(kind) {
  const [t, body] = EXERCISES[kind];
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) { try { new Notification(t, { body }); } catch { /* fall through to in-page card */ } }
  const root = document.getElementById('notify-root');
  root.innerHTML = `<div class="notify" role="dialog" aria-label="Reminder"><header><span>ErgoSense reminder</span><button type="button" aria-label="Close" id="n-x">×</button></header><div class="body"><h3>${t}</h3><p>${body}</p><div class="row"><button class="btn blue sm" data-n="Done. Nice work.">Done</button><button class="btn ghost sm" data-n="Snoozed for 10 minutes." data-snooze="${kind}">Snooze 10 min</button><button class="link" data-n="Skipped.">Skip</button></div></div></div>`;
  root.querySelector('#n-x').onclick = () => root.innerHTML = '';
  root.querySelectorAll('[data-n]').forEach(b => b.onclick = () => { root.innerHTML = ''; toast(b.dataset.n); if (b.dataset.snooze) S.timers.push(setTimeout(() => showReminder(kind), 600000)); });
}

VIEWS.mydata = async () => {
  const list = await S.store.myAssessments();
  return `<div class="head"><div><h1>My data</h1><p>What ErgoSense keeps about you, why, and for how long.</p></div></div>
  <div class="tbl"><table><thead><tr><th>Data</th><th>Why</th><th>How long</th><th>Now</th></tr></thead><tbody>
    <tr><td style="color:var(--fg)">Self-assessment answers</td><td>Your setup recommendations</td><td>3 years or end of employment</td><td class="muted">${list.filter(a => a.kind === 'self').length} saved</td></tr>
    <tr><td style="color:var(--fg)">Pose keypoints and scores</td><td>Measure posture over time</td><td>3 years or end of employment</td><td class="muted">${list.filter(a => a.kind === 'ai').length} AI checks</td></tr>
    <tr><td style="color:var(--fg)">Reminder settings</td><td>Run your reminders</td><td>While your account exists</td><td class="muted">–</td></tr>
    <tr><td style="color:var(--fg)">Photos and videos</td><td>Not stored; analysed on your device</td><td>Never kept</td><td class="muted">None</td></tr>
  </tbody></table></div>
  <div class="grid g2">
    <div class="card stack"><div class="row between"><h2>AI posture analysis</h2>${S.me.ai_consent ? '<span class="pill Low">Consent given</span>' : '<span class="pill Medium">No consent</span>'}</div>
      <p>${S.me.ai_consent ? 'Withdrawing stops new AI checks straight away. Everything else keeps working.' : 'AI checks are off for you. Self-assessment and reminders still work.'}</p>
      <div class="row">${S.me.ai_consent ? '<button class="btn ghost" id="consent-off">Withdraw consent</button>' : '<button class="btn" data-go="capture">Give consent</button>'}</div></div>
    <div class="card stack"><h2>Download or delete</h2>
      ${S.delStep === 'confirm' ? `<div class="notice" role="alert">${ic('alert', 20)}<p>This permanently deletes all your answers, keypoints, results and review requests. Your account and reminder settings stay.</p></div><div class="row"><button class="btn" id="del-yes" style="background:var(--high);border-color:var(--high);color:#fff">Delete my data</button><button class="btn ghost" id="del-no">Cancel</button></div>`
      : `<div class="row"><button class="btn ghost" id="dl">${ic('upload', 18)} Download my data</button><button class="btn ghost" id="del">Delete my data</button></div>`}
      <pre id="export-out" hidden style="max-height:240px;overflow:auto;font-size:11px;background:var(--tint);padding:12px;margin:0"></pre>
    </div>
  </div>`;
};
BIND.mydata = v => {
  const on = (id, f) => { const b = v.querySelector('#' + id); if (b) b.onclick = f; };
  on('consent-off', async () => { S.me = await S.store.updateProfile({ ai_consent: false }); toast('Consent withdrawn.'); render(); });
  on('dl', async () => {
    const data = JSON.stringify(await S.store.exportMyData(), null, 2);
    const out = v.querySelector('#export-out'); out.textContent = data; out.hidden = false;
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: 'ergosense-my-data.json' });
    a.click(); toast('Your data is shown below and downloaded as JSON where the browser allows it.');
  });
  on('del', () => { S.delStep = 'confirm'; render(); });
  on('del-no', () => { S.delStep = null; render(); });
  on('del-yes', async () => { await S.store.deleteMyData(); S.delStep = null; S.lastDetection = null; toast('Your assessment data was deleted.'); render(); });
};

/* ---------- HSE views ---------- */
VIEWS.dashboard = async () => {
  const people = await S.store.profiles();
  const entities = [...new Set(people.map(p => p.entity).filter(Boolean))].sort();
  const depts = [...new Set(people.filter(p => !S.filters.entity || p.entity === S.filters.entity).map(p => p.department).filter(Boolean))].sort();
  const d = await S.store.dashboard(S.filters);
  const max = Math.max(1, ...(d.issues || []).map(i => i.n));
  return `<div class="head"><div><h1>Ergonomics overview</h1><p>Latest result per employee. Groups under ${d.min_group} people are hidden to protect privacy.</p></div></div>
  <div class="row" style="gap:16px">
    <label class="field"><span>Entity</span><select id="f-entity"><option value="">All</option>${entities.map(e => `<option ${S.filters.entity === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></label>
    <label class="field"><span>Department</span><select id="f-dept"><option value="">All</option>${depts.map(e => `<option ${S.filters.department === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></label>
    <label class="field"><span>Period</span><select id="f-days"><option value="">All time</option>${[[30, 'Last 30 days'], [90, 'Last 90 days']].map(([n, l]) => `<option value="${n}" ${+S.filters.days === n ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  </div>
  ${d.suppressed ? `<div class="notice">${ic('info', 20)}<p>Results for this selection are hidden to protect privacy. Either it has fewer than ${esc(d.min_group)} assessed people, or it differs from a wider view by fewer than ${esc(d.min_group)}, which could reveal someone's result. Widen the filters.</p></div>` : `
  <div class="grid g4">
    <div class="card kpi"><div class="label">Assessed</div><div class="v num">${d.assessed}</div><div class="d">${d.employees ? Math.round(d.assessed / d.employees * 100) : 0}% of ${d.employees} employees</div></div>
    <div class="card kpi"><div class="label">High risk</div><div class="v num" style="color:var(--high)">${d.high}</div><div class="d">${Math.round(d.high / d.assessed * 100)}% of assessed</div></div>
    <div class="card kpi"><div class="label">Average score</div><div class="v num">${d.avg_score}<small>/100</small></div><div class="d">Higher is better</div></div>
    <div class="card kpi"><div class="label">Departments hidden</div><div class="v num">${d.hidden_departments}</div><div class="d">Fewer than ${d.min_group} assessed</div></div>
  </div>
  <div class="grid g2">
    <div class="card"><h2>Most common issues</h2><div style="margin-top:12px">${(d.issues || []).map(i => `<div class="hbar"><span class="nm" title="${esc(i.label)}">${esc(i.label)}</span><span class="track"><i style="width:${i.n / max * 100}%"></i></span><span class="val num">${i.n}</span></div>`).join('') || '<p class="muted">No repeated issues.</p>'}</div><p class="muted" style="font-size:12px;margin-top:8px">Employees with a medium or high finding</p></div>
    <div class="card" style="padding:0"><div style="padding:24px 24px 8px"><h2>Departments</h2></div><div style="overflow-x:auto"><table><thead><tr><th style="padding-left:24px">Department</th><th>Assessed</th><th>High risk</th><th>Avg score</th></tr></thead><tbody>
      ${d.departments.map(x => `<tr><td style="padding-left:24px;color:var(--fg)">${esc(x.department)}<br><span class="muted" style="font-size:12px">${esc(x.entity)}</span></td><td class="num">${x.assessed}</td><td class="num">${Math.round(x.high / x.assessed * 100)}%</td><td class="num" style="color:var(--fg);font-weight:500">${x.avg_score}</td></tr>`).join('')}
    </tbody></table></div></div>
  </div>`}`;
};
BIND.dashboard = v => {
  v.querySelector('#f-entity').onchange = e => { S.filters.entity = e.target.value || null; S.filters.department = null; render(); };
  v.querySelector('#f-dept').onchange = e => { S.filters.department = e.target.value || null; render(); };
  v.querySelector('#f-days').onchange = e => { S.filters.days = e.target.value ? +e.target.value : null; render(); };
};

VIEWS.followup = async () => {
  const rows = await S.store.highRisk();
  const rep = S.report;
  return `<div class="head"><div><h1>High-risk follow-up</h1><p>Employees whose latest result is High risk. Opening a report needs a purpose and is recorded in the audit log. Never share this list with HR or line managers.</p></div></div>
  ${rep ? `<div class="card stack"><div class="row between"><h2>${esc(rep.profile.full_name)}</h2><button class="btn ghost sm" id="close-rep">Close report</button></div><p class="muted">${esc(rep.profile.department)} · AI consent ${rep.profile.ai_consent ? 'given' : 'not given'}</p>
    ${rep.assessments[0] ? await resultHtml(rep.assessments[0], false) : '<p class="muted">No assessments.</p>'}</div>` : ''}
  ${rows.length ? `<div class="tbl"><table><thead><tr><th>Employee</th><th>Department</th><th>Score</th><th>Risk</th><th>Assessed</th><th>Purpose</th><th></th></tr></thead><tbody>
    ${rows.map(r => `<tr><td style="color:var(--fg)">${esc(r.full_name)}</td><td>${esc(r.department)}</td><td class="num">${r.score}</td><td>${pill(r.risk_class)}</td><td class="num">${fmtDate(r.created_at)}</td><td><input type="text" id="purpose-${r.user_id}" aria-label="Purpose" placeholder="e.g. Follow-up call" style="width:160px"></td><td><button class="link" data-report="${r.user_id}">Open ${ic('arrow', 14)}</button></td></tr>`).join('')}
  </tbody></table></div>` : '<div class="empty">No employees are currently High risk.</div>'}`;
};
BIND.followup = v => {
  const c = v.querySelector('#close-rep'); if (c) c.onclick = () => { S.report = null; render(); };
  v.querySelectorAll('[data-report]').forEach(b => b.onclick = async () => {
    const purpose = v.querySelector(`#purpose-${CSS.escape(b.dataset.report)}`).value;
    try { S.report = await S.store.openReport(b.dataset.report, purpose); render(); } catch (e) { toast(e.message); }
  });
};

VIEWS.reviews = async () => {
  const q = await S.store.reviewQueue();
  return `<div class="head"><div><h1>Specialist reviews</h1><p>Employees who asked for their AI result to be checked. Confirm it or correct the risk class; the employee sees your decision.</p></div></div>
  ${q.length ? `<div class="stack" style="gap:16px">${q.map(r => `<div class="card stack"><div class="row between"><div><h3>${esc(r.employee?.full_name)}</h3><p class="measure">${esc(r.employee?.department)} · requested ${fmtDate(r.created_at)}</p></div><span class="pill ${r.status === 'Resolved' ? 'Low' : 'Medium'}">${r.status}</span></div>
    <p style="color:var(--fg)">${r.comment ? `“${esc(r.comment)}”` : '<span class="muted">No comment</span>'}</p>
    ${r.status === 'Resolved' ? `<p class="muted">${esc(r.decision)}</p>` : `<div class="row" style="gap:12px;align-items:flex-end"><label class="field"><span>Decision</span><select id="dec-${r.id}"><option value="">Confirm AI result</option><option>Medium</option><option>Low</option><option>High</option></select></label><button class="btn sm" data-resolve="${r.id}">Resolve</button></div>`}
  </div>`).join('')}</div>` : '<div class="empty">No review requests yet.</div>'}`;
};
BIND.reviews = v => v.querySelectorAll('[data-resolve]').forEach(b => b.onclick = async () => {
  try { await S.store.resolveReview(b.dataset.resolve, v.querySelector('#dec-' + CSS.escape(b.dataset.resolve)).value || null); toast('Review resolved.'); render(); } catch (e) { toast(e.message); }
});

/* ---------- admin views ---------- */
VIEWS.users = async () => {
  const people = await S.store.profiles();
  return `<div class="head"><div><h1>Users &amp; roles</h1><p>People appear here after their first sign-in. HSE / OH access is granted by the OH – HSE manager in the database, not here.</p></div></div>
  <div class="tbl"><table><thead><tr><th>Name</th><th>Department</th><th>Entity</th><th>Role</th><th>AI consent</th></tr></thead><tbody>
  ${people.map(p => `<tr><td style="color:var(--fg)">${esc(p.full_name)}${p.sample ? ' <span class="muted" style="font-size:12px">(sample)</span>' : ''}<br><span class="muted" style="font-size:12px">${esc(p.email || '')}</span></td><td>${esc(p.department)}</td><td>${esc(p.entity)}</td><td>${p.id === S.me.id || p.role === 'hse' ? esc({ employee: 'Employee', hse: 'HSE / OH', admin: 'Admin' }[p.role]) : `<select data-role="${p.id}" aria-label="Role for ${esc(p.full_name)}"><option value="employee" ${p.role === 'employee' ? 'selected' : ''}>Employee</option><option value="admin" ${p.role === 'admin' ? 'selected' : ''}>Admin</option></select>`}</td><td>${p.ai_consent ? 'Yes' : 'No'}</td></tr>`).join('')}
  </tbody></table></div>`;
};
BIND.users = v => v.querySelectorAll('[data-role]').forEach(s => s.onchange = async () => {
  try { await S.store.setRole(s.dataset.role, s.value); toast('Role changed and logged.'); } catch (e) { toast(e.message); render(); }
});

VIEWS.policies = async () => {
  const st = S.settings;
  const susp = st.ai_suspended === true || st.ai_suspended === 'true';
  return `<div class="head"><div><h1>Policies</h1><p>Organisation-wide settings. Every change is logged.</p></div></div>
  <div class="card"><div class="grid g3">
    <label class="field"><span>AI analysis</span><select id="p-ai"><option value="false" ${susp ? '' : 'selected'}>Active</option><option value="true" ${susp ? 'selected' : ''}>Suspended (self-assessment only)</option></select></label>
    <label class="field"><span>Smallest group shown in dashboards</span><select id="p-min">${[5, 10, 20].map(n => `<option ${+st.min_group === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="field"><span>Re-assessment interval (days)</span><select id="p-days">${[90, 180, 365].map(n => `<option ${+st.reassess_days === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="field"><span>Raw photos and videos</span><select disabled><option>Never uploaded or stored (fixed)</option></select></label>
  </div><div class="row" style="margin-top:20px"><button class="btn" id="save-pol">Save policies</button></div></div>`;
};
BIND.policies = v => v.querySelector('#save-pol').onclick = async () => {
  try { await S.store.saveSettings({ ai_suspended: v.querySelector('#p-ai').value === 'true', min_group: +v.querySelector('#p-min').value, reassess_days: +v.querySelector('#p-days').value }); toast('Policies saved.'); render(); } catch (e) { toast(e.message); }
};

VIEWS.audit = async () => {
  const rows = await S.store.audit();
  return `<div class="head"><div><h1>Audit log</h1><p>Report access, exports, consent and role changes, deletions and policy changes.</p></div></div>
  ${rows.length ? `<div class="tbl"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th></tr></thead><tbody>${rows.map(a => `<tr><td class="num">${new Date(a.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td><td style="color:var(--fg)">${esc(a.actor_name)}</td><td>${esc(a.action)}</td><td class="muted">${esc(a.details)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No events yet.</div>'}`;
};

/* ---------- boot ---------- */
document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]'); if (g) { e.preventDefault(); go(g.dataset.go); return; }
  const o = e.target.closest('[data-open]'); if (o) { S.currentId = o.dataset.open; go('result'); }
});
// Clears everything the previous person left in memory on this device.
function resetSession() {
  stopReminders(); stopCamera();
  Object.assign(S, { me: null, image: null, lastDetection: null, report: null, answers: {}, step: 0, checkDone: false, checkError: null,
    filters: {}, currentId: null, rem: null, delStep: null, reviewOpen: false, issues: null, analysing: false });
  document.getElementById('notify-root').innerHTML = '';
}
document.getElementById('sign-out').onclick = async () => { await S.store.signOut(); resetSession(); history.replaceState(null, '', location.pathname); render(); };

(async () => {
  try {
    S.store = await createStore();
    document.getElementById('mode-chip').textContent = S.store.mode === 'local' ? 'Local demo mode · data stays in this browser' : 'Connected · Supabase';
    S.store.onAuth(async evt => { if (evt === 'SIGNED_OUT') resetSession(); S.me = await S.store.session(); render(); });
    S.me = await S.store.session();
  } catch (e) {
    document.getElementById('view').innerHTML = `<p class="err">Could not start: ${esc(e.message)}</p>`; return;
  }
  render();
})();
