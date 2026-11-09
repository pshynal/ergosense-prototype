// Data layer. Two implementations with the same interface:
//  - SupabaseStore: real database, login and row-level security (used when config.js has keys)
//  - LocalStore: browser-only demo with sample colleagues, same rules, no account needed
import { CONFIG } from './config.js';

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export async function createStore() {
  if (CONFIG.supabaseUrl && CONFIG.supabaseAnonKey) {
    const { createClient } = await import(SUPABASE_JS);
    return new SupabaseStore(createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey));
  }
  return new LocalStore();
}

const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

class SupabaseStore {
  constructor(sb) { this.sb = sb; this.mode = 'supabase'; this.profile = null; }
  async session() {
    const { data } = await this.sb.auth.getSession();
    if (!data.session) return null;
    this.profile = must(await this.sb.from('profiles').select('*').eq('id', data.session.user.id).single());
    return this.profile;
  }
  async signIn(email) {
    must(await this.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } }));
  }
  async signOut() { await this.sb.auth.signOut(); this.profile = null; }
  onAuth(cb) { this.sb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_IN' || evt === 'SIGNED_OUT') cb(evt); }); }
  async updateProfile(patch) {
    this.profile = must(await this.sb.from('profiles').update(patch).eq('id', this.profile.id).select().single());
    return this.profile;
  }
  async settings() {
    const rows = must(await this.sb.from('settings').select('*'));
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  }
  // Row-level security silently skips rows a user may not change, so an empty result means "not allowed".
  async saveSettings(patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (!must(await this.sb.from('settings').update({ value }).eq('key', key).select()).length) throw new Error('Only admins can change policies');
    }
  }
  async saveAssessment(a) {
    return must(await this.sb.from('assessments').insert({ ...a, user_id: this.profile.id }).select().single());
  }
  async myAssessments() {
    return must(await this.sb.from('assessments').select('*').order('created_at', { ascending: false }));
  }
  async requestReview(assessment_id, comment) {
    must(await this.sb.from('reviews').insert({ assessment_id, comment, user_id: this.profile.id }));
  }
  async myReviews() {
    return must(await this.sb.from('reviews').select('*').eq('user_id', this.profile.id).order('created_at', { ascending: false }));
  }
  async reminders() {
    return must(await this.sb.from('reminder_settings').select('*').eq('user_id', this.profile.id).maybeSingle());
  }
  async saveReminders(r) {
    must(await this.sb.from('reminder_settings').upsert({ ...r, user_id: this.profile.id, updated_at: new Date().toISOString() }));
  }
  async exportMyData() {
    const [assessments, reviews, reminders] = await Promise.all([this.myAssessments(), this.myReviews(), this.reminders()]);
    must(await this.sb.rpc('log_my_export'));
    return { profile: this.profile, assessments, reviews, reminders, exported_at: new Date().toISOString() };
  }
  async deleteMyData() { must(await this.sb.rpc('delete_my_data')); }
  async dashboard(f) {
    return must(await this.sb.rpc('hse_dashboard', { p_entity: f.entity || null, p_department: f.department || null, p_days: f.days || null }));
  }
  async highRisk() { return must(await this.sb.rpc('hse_high_risk')); }
  async openReport(userId, purpose) {
    const r = must(await this.sb.rpc('hse_open_report', { p_user: userId, p_purpose: purpose }));
    if (r?.denied) throw new Error(r.message);
    return r;
  }
  async reviewQueue() {
    return must(await this.sb.from('reviews').select('*, employee:profiles!reviews_user_id_fkey(full_name, department)').order('created_at', { ascending: false }));
  }
  async resolveReview(id, cls) { must(await this.sb.rpc('resolve_review', { p_review: id, p_class: cls })); }
  async profiles() { return must(await this.sb.from('profiles').select('*').order('full_name')); }
  async setRole(id, role) {
    if (!must(await this.sb.from('profiles').update({ role }).eq('id', id).select()).length) throw new Error('Only admins can change roles');
  }
  async audit() { return must(await this.sb.from('audit_log').select('*').order('at', { ascending: false }).limit(200)); }
}

// ---------- Local demo store ----------

const KEY = 'ergosense-local-v1';
const DEPTS = [['Research Office', 'Science Park'], ['Education Programs', 'Education Campus'], ['Finance', 'Headquarters'], ['Information Technology', 'Headquarters'], ['Community Development', 'Education Campus']];
const SAMPLE_ISSUES = ['Neck flexion', 'Screen top below eye level', 'Trunk lean forward', 'Wrist bend', 'Upper arm raised', 'Knee angle'];

function seed() {
  const people = [
    { id: 'me', full_name: 'Demo Employee', email: 'you@example.com', department: 'Research Office', entity: 'Science Park', role: 'employee', ai_consent: false },
    { id: 'hse', full_name: 'Demo HSE Specialist', email: 'hse@example.com', department: 'OH – HSE', entity: 'Headquarters', role: 'hse', ai_consent: false },
    { id: 'admin', full_name: 'Demo Admin', email: 'admin@example.com', department: 'Information Technology', entity: 'Headquarters', role: 'admin', ai_consent: false }
  ];
  const assessments = [];
  let r = 7;
  const rand = () => (r = (r * 9301 + 49297) % 233280) / 233280;
  DEPTS.forEach(([department, entity], d) => {
    for (let i = 0; i < 6 + d; i++) {
      const id = `s${d}${i}`;
      people.push({ id, full_name: `Sample colleague ${d + 1}.${i + 1}`, email: `${id}@example.com`, department, entity, role: 'employee', ai_consent: true, sample: true });
      const score = Math.round(45 + rand() * 50);
      const cls = score >= 80 ? 'Low' : score >= 60 ? 'Medium' : 'High';
      const findings = SAMPLE_ISSUES.filter(() => rand() < (100 - score) / 70).map(label => ({ label, severity: rand() < 0.4 ? 'High' : 'Medium' }));
      assessments.push({ id: `a-${id}`, user_id: id, created_at: new Date(Date.now() - rand() * 40 * 864e5).toISOString(), kind: 'ai', score, risk_class: cls, findings, sample: true });
    }
  });
  return {
    people, assessments, reviews: [], audit: [],
    settings: { ai_suspended: false, min_group: 5, reassess_days: 90 },
    reminders: {}, session: null
  };
}

class LocalStore {
  constructor() {
    this.mode = 'local';
    try { this.db = JSON.parse(localStorage.getItem(KEY)) || seed(); } catch { this.db = seed(); }
  }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.db)); } catch { /* storage blocked: keep in memory */ } }
  get profile() { return this.db.people.find(p => p.id === this.db.session) || null; }
  person(id) { return this.db.people.find(p => p.id === id); }
  async session() { return this.profile; }
  async signIn(roleId) { this.db.session = roleId; this.save(); await this.log('Signed in (demo)', roleId); }
  async signOut() { this.db.session = null; this.save(); }
  onAuth() {}
  async reset() { this.db = seed(); this.save(); }
  async updateProfile(patch) {
    const p = this.profile;
    if ('role' in patch && patch.role !== p.role) throw new Error('You cannot change your own role');
    if ('ai_consent' in patch && patch.ai_consent !== p.ai_consent) {
      patch.consent_at = new Date().toISOString();
      await this.log(patch.ai_consent ? 'Gave AI consent' : 'Withdrew AI consent', p.email);
    }
    Object.assign(p, patch); this.save(); return p;
  }
  async settings() { return { ...this.db.settings }; }
  async saveSettings(patch) {
    if (this.profile.role !== 'admin') throw new Error('Only admins can change policies');
    if ('ai_suspended' in patch && typeof patch.ai_suspended !== 'boolean') throw new Error('ai_suspended must be true or false');
    if ('min_group' in patch && !(Number.isInteger(patch.min_group) && patch.min_group >= 5)) throw new Error('min_group must be a number of at least 5');
    if ('reassess_days' in patch && ![90, 180, 365].includes(patch.reassess_days)) throw new Error('reassess_days must be 90, 180 or 365');
    Object.assign(this.db.settings, patch); await this.log('Saved organisation policies', JSON.stringify(patch)); this.save();
  }
  async saveAssessment(a) {
    if (a.kind === 'ai') {
      if (this.db.settings.ai_suspended) throw new Error('AI analysis is paused by Occupational Health - HSE');
      if (!this.profile.ai_consent) throw new Error('AI consent is required for an AI posture check');
    }
    const row = { ...a, id: crypto.randomUUID(), user_id: this.profile.id, created_at: new Date().toISOString(), corrected_class: null };
    this.db.assessments.push(row); this.save(); return row;
  }
  async myAssessments() {
    return this.db.assessments.filter(a => a.user_id === this.profile.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async requestReview(assessment_id, comment) {
    this.db.reviews.push({ id: crypto.randomUUID(), assessment_id, user_id: this.profile.id, comment, status: 'Submitted', created_at: new Date().toISOString() });
    await this.log('Requested specialist review', assessment_id); this.save();
  }
  async myReviews() { return this.db.reviews.filter(r => r.user_id === this.profile.id).reverse(); }
  async reminders() { return this.db.reminders[this.profile.id] || null; }
  async saveReminders(r) { this.db.reminders[this.profile.id] = r; this.save(); }
  async exportMyData() {
    await this.log('Exported own data', null);
    return { profile: this.profile, assessments: await this.myAssessments(), reviews: await this.myReviews(), reminders: await this.reminders(), exported_at: new Date().toISOString() };
  }
  async deleteMyData() {
    this.db.assessments = this.db.assessments.filter(a => a.user_id !== this.profile.id);
    this.db.reviews = this.db.reviews.filter(r => r.user_id !== this.profile.id);
    await this.log('Deleted own assessment data', null); this.save();
  }
  // Same privacy rules as hse_dashboard() in supabase/schema.sql: a selection is hidden when it has
  // fewer than min_group people or differs from a wider view by fewer than min_group people.
  async dashboard(f) {
    if (!['hse', 'admin'].includes(this.profile.role)) throw new Error('Not allowed');
    if (f.days && ![30, 90].includes(f.days)) throw new Error('Period must be 30 or 90 days');
    await this.log('Viewed HSE dashboard', [f.entity, f.department, f.days].filter(Boolean).join(' · '));
    const min = Math.max(5, Number(this.db.settings.min_group) || 5);
    const withPerson = a => ({ ...a, p: this.person(a.user_id) });
    const latestIn = days => this.latestByUser(a => !days || Date.parse(a.created_at) > Date.now() - days * 864e5).map(withPerson);
    const inScope = a => (!f.entity || a.p.entity === f.entity) && (!f.department || a.p.department === f.department);
    const all = latestIn(f.days), s = all.filter(inScope), n = s.length;
    const close = wider => wider - n >= 1 && wider - n < min;
    let hidden = n < min || close(all.length);
    if (f.department) {
      const ents = new Set(s.map(a => a.p.entity));
      hidden ||= close(all.filter(a => ents.has(a.p.entity)).length);
    }
    if (f.days) hidden ||= close(latestIn(null).filter(inScope).length);
    if (hidden) return { min_group: min, suppressed: true };

    const cls = a => a.corrected_class || a.risk_class;
    const depts = {};
    s.forEach(a => { const k = `${a.p.department}|${a.p.entity}`; (depts[k] ||= { department: a.p.department, entity: a.p.entity, assessed: 0, high: 0, sum: 0 }); depts[k].assessed++; depts[k].sum += a.score; if (cls(a) === 'High') depts[k].high++; });
    const dl = Object.values(depts);
    const smallTotal = dl.filter(d => d.assessed < min).reduce((t, d) => t + d.assessed, 0);
    let vis = dl.filter(d => d.assessed >= min);
    if (smallTotal >= 1 && smallTotal < min && vis.length) {
      const extra = vis.slice().sort((a, b) => a.assessed - b.assessed || a.department.localeCompare(b.department))[0];
      vis = vis.filter(d => d !== extra);
    }
    const issues = {};
    s.forEach(a => new Set((a.findings || []).filter(x => ['Medium', 'High'].includes(x.severity) && x.key !== 'notScored').map(x => x.label)).forEach(l => issues[l] = (issues[l] || 0) + 1));
    return {
      min_group: min, suppressed: false,
      employees: this.db.people.filter(p => (!f.entity || p.entity === f.entity) && (!f.department || p.department === f.department)).length,
      assessed: n, high: s.filter(a => cls(a) === 'High').length,
      avg_score: Math.round(s.reduce((t, a) => t + a.score, 0) / n),
      issues: Object.entries(issues).filter(([, c]) => c >= min).map(([label, c]) => ({ label, n: c })).sort((a, b) => b.n - a.n),
      departments: vis.map(d => ({ ...d, avg_score: Math.round(d.sum / d.assessed) })).sort((a, b) => a.department.localeCompare(b.department)),
      hidden_departments: dl.length - vis.length
    };
  }
  // Latest AI check per person, or latest self-assessment if they have no AI check (same rule as the database).
  latestByUser(filter = () => true) {
    const rank = a => (a.kind === 'ai' ? '1' : '0') + a.created_at;
    return Object.values(this.db.assessments.filter(filter).sort((a, b) => rank(a).localeCompare(rank(b))).reduce((m, a) => (m[a.user_id] = a, m), {}));
  }
  async highRisk() {
    if (this.profile.role !== 'hse') throw new Error('Only Occupational Health - HSE can see named results');
    return this.latestByUser().filter(a => (a.corrected_class || a.risk_class) === 'High')
      .map(a => { const p = this.person(a.user_id); return { user_id: a.user_id, full_name: p.full_name, department: p.department, score: a.score, risk_class: a.corrected_class || a.risk_class, created_at: a.created_at }; })
      .sort((a, b) => a.score - b.score);
  }
  async openReport(userId, purpose) {
    if (this.profile.role !== 'hse') { await this.log('Denied: individual report access', userId); throw new Error('Access denied: only Occupational Health - HSE can open individual reports'); }
    if (!purpose || !purpose.trim()) throw new Error('Record a purpose for opening this report');
    await this.log('Viewed individual report', `${userId} · ${purpose}`);
    const { email, ...profile } = this.person(userId);
    return { profile, assessments: this.db.assessments.filter(a => a.user_id === userId).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(({ keypoints, ...a }) => a) };
  }
  async reviewQueue() {
    return this.db.reviews.slice().reverse().map(r => ({ ...r, employee: { full_name: this.person(r.user_id).full_name, department: this.person(r.user_id).department } }));
  }
  async resolveReview(id, cls) {
    if (this.profile.role !== 'hse') throw new Error('Only Occupational Health - HSE can resolve reviews');
    const r = this.db.reviews.find(x => x.id === id);
    if (cls) { const a = this.db.assessments.find(x => x.id === r.assessment_id); if (a) a.corrected_class = cls; }
    Object.assign(r, { status: 'Resolved', reviewer_id: this.profile.id, resolved_at: new Date().toISOString(), decision: cls ? `Corrected to ${cls} risk` : 'AI result confirmed' });
    await this.log('Resolved specialist review', `${id} · ${cls || 'confirmed'}`); this.save();
  }
  async profiles() {
    if (!['hse', 'admin'].includes(this.profile.role)) throw new Error('Not allowed');
    return this.db.people.slice().sort((a, b) => a.full_name.localeCompare(b.full_name));
  }
  async setRole(id, role) {
    const me = this.profile, p = this.person(id);
    if (id === me.id) throw new Error('You cannot change your own role');
    if (me.role !== 'admin') throw new Error('Only admins can change roles');
    if (role === 'hse') throw new Error('HSE access needs approval by the OH - HSE manager');
    await this.log('Changed role', `${p.email}: ${p.role} -> ${role}`); p.role = role; this.save();
  }
  async audit() {
    const me = this.profile;
    return this.db.audit.filter(a => me.role === 'admin' || a.actor_id === me.id).slice(-200).reverse();
  }
  async log(action, details) {
    const me = this.profile;
    this.db.audit.push({ at: new Date().toISOString(), actor_id: me?.id || null, actor_name: me?.full_name || 'System', action, details }); this.save();
  }
}
