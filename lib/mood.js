/** 情绪是独立的事件流；不参与记忆选取、权重、退役或工具执行决策。 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getConfig, poolOverride, storeDir, currentMoodLexicon } from './config.js';

export const MOOD_GRACE_HOURS = 3;
export const MOOD_HALF_LIFE_HOURS = 24;
export const MOOD_FADE_THRESHOLD = 0.15;
const KINDS = { 被陪伴: 'positive', 得意: 'positive', 安心: 'positive', 挫败: 'negative', 警觉: 'negative', 难过: 'negative', 开心: 'positive', 服气: 'positive', 平静: 'positive', 疲惫: 'negative', 担心: 'negative' };
const clean = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const clamp = (n) => Math.max(0, Math.min(1, n));
const round = (n) => Math.round(n * 1e6) / 1e6;
let cache = null;
let suppressLegacy = 0;
export function moodPath() { return join(storeDir(), 'mood.json'); }
export function moodsPath() { return join(storeDir(), 'moods.jsonl'); }
const recordingEnabled = () => getConfig().moodEnabled !== false && getConfig().preset !== 'work';

export function moodStrength(record, now = Date.now()) {
  const from = Date.parse(record?.ts);
  if (!Number.isFinite(from)) return { ageHours: Infinity, strength: 0 };
  const ageHours = Math.max(0, (now - from) / 3600000);
  const def = poolOverride('emotion') || {};
  const grace = Number.isFinite(def.graceDays) ? def.graceDays * 24 : MOOD_GRACE_HOURS;
  const half = Number.isFinite(def.halfLifeDays) && def.halfLifeDays > 0 ? def.halfLifeDays * 24 : MOOD_HALF_LIFE_HOURS;
  return { ageHours, strength: clamp(Number(record.intensity) || 0) * Math.pow(0.5, Math.max(0, ageHours - grace) / half) };
}

function readJournal() {
  try {
    const signature = [moodPath(), moodsPath()].map((p) => existsSync(p) ? p + ':' + statSync(p).size + ':' + statSync(p).mtimeMs : p).join('|') + JSON.stringify(poolOverride('emotion'));
    if (cache?.signature === signature) return cache;
    const states = new Map(), events = [], keys = new Set(), ids = new Set(), decayAt = new Map();
    let skipped = 0;
    if (existsSync(moodPath())) {
      try {
        const old = JSON.parse(readFileSync(moodPath(), 'utf8').replace(/^\uFEFF/, ''));
        if (clean(old?.mood) && Number.isFinite(Date.parse(old.ts))) {
          const intensity = Number.isFinite(Number(old.intensity)) ? clamp(Number(old.intensity)) : 0.6;
          const e = { id: 'legacy', ts: old.ts, kind: KINDS[old.mood] || 'neutral', name: clean(old.mood, 60), delta: intensity, strength: intensity, cause: 'legacy', causeText: clean(old.why), source: 'legacy', eventType: '旧状态' };
          states.set(e.name, { ...e, intensity, startedAt: e.ts, sources: [e] });
        }
      } catch { skipped++; }
    }
    const raw = existsSync(moodsPath()) ? readFileSync(moodsPath(), 'utf8') : '';
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e || !Number.isFinite(Date.parse(e.ts)) || !['positive', 'negative', 'neutral', 'control'].includes(e.kind) || !['event', 'self-report', 'decay', 'reset'].includes(e.cause) || typeof e.name !== 'string' || !Number.isFinite(e.delta) || !Number.isFinite(e.strength)) { skipped++; continue; }
        if (e.id && ids.has(e.id)) continue;
        if (e.id) ids.add(e.id);
        if (e.sourceKey) keys.add(e.sourceKey);
        events.push(e);
        if (e.cause === 'reset') {
          const keep = Array.isArray(e.keep) ? e.keep : [];
          for (const [name, state] of states) if (!keep.includes(name) && !keep.includes(state.kind)) states.delete(name);
        } else if (e.cause === 'decay') {
          // 衰减行只审计，不重置宽限起点；重复读取不会延长情绪寿命。
          decayAt.set(e.name, Date.parse(e.ts));
        } else if (e.delta !== 0 || states.has(e.name)) {
          const old = states.get(e.name);
          const current = old ? moodStrength(old, Date.parse(e.ts)).strength : 0;
          // delta 是事实；strength 是当时的观测值，绝不拿快照覆盖另一种状态。
          const sources = old?.sources || [];
          sources.push(e);
          states.set(e.name, { ...e, intensity: clamp(current + e.delta), startedAt: old && current >= MOOD_FADE_THRESHOLD ? old.startedAt : e.ts, sources });
        }
      } catch { skipped++; }
    }
    cache = { signature, states, events, keys, decayAt, raw, skipped, error: null };
    return cache;
  } catch (e) { return { states: new Map(), events: [], keys: new Set(), decayAt: new Map(), raw: '', skipped: 0, error: String(e?.message || e) }; }
}

export function moodTendency(states) {
  const active = states.filter((s) => s.strength >= MOOD_FADE_THRESHOLD);
  const positive = active.some((s) => s.kind === 'positive');
  const negative = active.some((s) => s.kind === 'negative');
  // 「被哄了你总不能一直伤心」落在表达缓和，不落在把挫败清零。
  if (positive && negative) return '此刻更愿意交流，但仍有些低落，表达相对缓和';
  if (positive) return '此刻更愿意多说一点，表达较放松';
  if (negative) return '此刻表达可能更谨慎，底气不足';
  return active.length ? '此刻表达较平稳' : '';
}

export function readMoods({ now = Date.now(), limit = 20 } = {}) {
  limit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const journal = readJournal();
  const states = [...journal.states.values()].map((s) => ({
    name: s.name, kind: s.kind, intensity: s.intensity, ts: s.ts, startedAt: s.startedAt,
    cause: s.cause, causeText: s.causeText || '', ...moodStrength(s, now), sources: s.sources.slice(-limit),
  })).filter((s) => s.strength > 0).sort((a, b) => b.strength - a.strength);
  const enabled = recordingEnabled(), influenceEnabled = getConfig().moodInfluenceEnabled !== false;
  return { states, events: journal.events.slice(-limit).reverse(), count: journal.events.length, enabled, influenceEnabled,
    tendency: enabled && influenceEnabled ? moodTendency(states) : '', error: journal.error, skipped: journal.skipped };
}

function append(rows) {
  if (!rows.length) return { ok: true, written: 0 };
  try {
    const journal = readJournal();
    if (journal.error || journal.skipped) return { ok: false, written: 0, error: journal.error || '情绪记录包含损坏行，未继续写入。' };
    mkdirSync(storeDir(), { recursive: true });
    const prefix = journal.raw && !journal.raw.endsWith('\n') ? '\n' : '';
    appendFileSync(moodsPath(), prefix + rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    cache = null;
    return { ok: true, written: rows.length };
  } catch (e) { cache = null; return { ok: false, written: 0, error: String(e?.message || e) }; }
}

/** 只看语气，不把纠正、催促本身判成挫败。引用、代码和长说明不作为对话事件。 */
export function classifyMoodEvents(text) {
  const plain = String(text ?? '').replace(/```[\s\S]*?```|`[^`]*`|「[^」]*」|“[^”]*”|"[^"\n]*"/g, '');
  const out = [];
  const lexicon = currentMoodLexicon();
  const words = (event, tone) => lexicon[event]?.[tone] || [];
  const matches = (text, phrases) => phrases.some((phrase) => text.includes(phrase));
  for (const raw of plain.split(/[。！？!?；;\n]/)) {
    const s = raw.trim();
    if (!s || s.length > 120 || /^(?:[>|#]|示例|例如|比如)/.test(s)) continue;
    const toneText = s.replace(/(?:并)?(?:没有|没|不|别|不用|不要|不会|从不|毫不)(?:让(?:我|人)|感到)?失望/g, '');
    const disappointed = matches(toneText, [...words('纠正', 'disappointed'), ...words('催', 'disappointed')]);
    const rules = [
      ['夸', words('夸', 'positive'), '得意', 0.25],
      ['哄', words('哄', 'positive'), '安心', 0.3],
      ['陪', words('陪', 'positive'), '被陪伴', 0.25],
      ['纠正', words('纠正', 'neutral'), disappointed ? '挫败' : '纠正', disappointed ? 0.25 : 0],
      ['催', words('催', 'neutral'), disappointed ? '警觉' : '催', disappointed ? 0.2 : 0],
    ];
    let matched = false;
    for (const [eventType, phrases, name, delta] of rules) {
      if (!matches(s, phrases)) continue;
      if (delta > 0 && ['夸', '哄', '陪'].includes(eventType) && /不(?:算|是|太|够|要)?(?:厉害|摸摸|陪)|别(?:陪|抱)/.test(s)) continue;
      matched = true;
      out.push({ eventType, name, kind: KINDS[name] || 'neutral', delta, causeText: clean(s), tone: disappointed ? 'disappointed' : delta ? 'positive' : 'neutral' });
    }
    if (disappointed && !matched) out.push({ eventType: '失望语气', name: '难过', kind: 'negative', delta: 0.25, causeText: clean(s), tone: 'disappointed' });
  }
  return out;
}

export function recordMoodEvents(text, { now = Date.now(), sourceKey = '', source = 'dialogue' } = {}) {
  if (!recordingEnabled()) return { ok: true, written: 0, disabled: true };
  try {
    const journal = readJournal(), current = new Map(readMoods({ now }).states.map((s) => [s.name, s.strength]));
    const rows = classifyMoodEvents(text).map((event, i) => {
      const key = sourceKey ? sourceKey + ':' + i : '';
      if (key && journal.keys.has(key)) return null;
      const before = current.get(event.name) || 0, strength = clamp(before + event.delta);
      current.set(event.name, strength);
      return { id: randomUUID(), ts: new Date(now).toISOString(), ...event, delta: round(strength - before), strength: round(strength), cause: 'event', source, ...(key ? { sourceKey: key } : {}) };
    }).filter(Boolean);
    return append(rows);
  } catch (e) { return { ok: false, written: 0, error: String(e?.message || e) }; }
}

export function recordMoodFromScope(scope, extractText) {
  try {
    if (!recordingEnabled()) return;
    const messages = scope?.session?.deriveMessages?.() || [];
    const users = messages.filter((m) => m.role === 'user');
    const m = users[users.length - 1];
    if (!m) return;
    const text = extractText ? extractText(m) : typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text' || p.type === 'input_text').map((p) => p.text || '').join('\n') : '';
    const identity = m.id || m.messageId || m.ts || m.timestamp || users.length;
    const sourceKey = createHash('sha256').update(String(scope.id) + ':' + String(identity) + ':' + text).digest('hex');
    return recordMoodEvents(text, { sourceKey });
  } catch { return { ok: false, written: 0 }; }
}

/** 自述只描述状态，不作为对话事件证据；仅修改点名的状态，另一方向原样保留。 */
export function recordMoodStates(items, { now = Date.now() } = {}) {
  if (!recordingEnabled()) return { ok: true, written: 0, disabled: true };
  try {
    if (!Array.isArray(items) || !items.length || items.length > 12) return { ok: false, written: 0, error: '请提供 1–12 条状态。' };
    const current = new Map(readMoods({ now }).states.map((s) => [s.name, s.strength]));
    const rows = items.map((item) => {
      const name = clean(item.name ?? item.mood, 60);
      if (!name) throw new Error('状态名称不能为空。');
      const intensity = item.intensity == null ? 0.6 : Number(item.intensity);
      if (!Number.isFinite(intensity)) throw new Error('强度必须是数字。');
      const strength = clamp(intensity), delta = round(strength - (current.get(name) || 0));
      current.set(name, strength);
      return { id: randomUUID(), ts: new Date(now).toISOString(), kind: KINDS[name] || (['positive', 'negative'].includes(item.kind) ? item.kind : 'neutral'), name, delta, strength, cause: 'self-report', causeText: clean(item.why), source: 'self-report', eventType: '自述' };
    });
    return append(rows);
  } catch (e) { return { ok: false, written: 0, error: String(e?.message || e) }; }
}

export function resetMoods(keep = [], { now = Date.now() } = {}) {
  try {
    keep = Array.isArray(keep) ? keep.map((v) => v === '正向' ? 'positive' : v === '负向' ? 'negative' : clean(v, 60)).slice(0, 20) : [];
    return append([{ id: randomUUID(), ts: new Date(now).toISOString(), kind: 'control', name: '*', delta: 0, strength: 0, cause: 'reset', keep, source: 'manual', eventType: '重置' }]);
  } catch (e) { return { ok: false, written: 0, error: String(e?.message || e) }; }
}

/** 每小时最多留一次可见衰减记录；读取接口不写盘，无额外后台定时器。 */
export function recordMoodDecay(now = Date.now()) {
  if (!recordingEnabled()) return { ok: true, written: 0 };
  try {
    const journal = readJournal(), rows = [];
    for (const s of journal.states.values()) {
      const last = Math.max(Date.parse(s.ts), journal.decayAt.get(s.name) || 0);
      const strength = moodStrength(s, now).strength;
      if (now - last < 3600000 || moodStrength(s, last).strength - strength < 0.02) continue;
      rows.push({ id: randomUUID(), ts: new Date(now).toISOString(), kind: s.kind, name: s.name, delta: 0, cause: 'decay', strength: round(strength), source: 'clock', eventType: '自然衰减' });
    }
    return append(rows);
  } catch { return { ok: false, written: 0 }; }
}

export function formatMoodInjection({ now = Date.now(), influenceEnabled = getConfig().moodInfluenceEnabled !== false } = {}) {
  try {
    const report = readMoods({ now });
    if (!report.enabled || report.error || report.skipped) return '';
    const states = report.states.filter((s) => s.strength >= MOOD_FADE_THRESHOLD).slice(0, 3);
    if (!states.length) return '';
    const lines = ['当前状态：', ...states.map((s) => '- ' + clean(s.name, 10) + ' ' + s.strength.toFixed(2) + '（' + humanAge(s.ageHours) + (s.causeText ? (s.cause === 'self-report' ? ' · 自述「' : ' · 因为「') + clean(s.causeText, 12) + '」' : '') + '）')];
    if (influenceEnabled) lines.push('倾向：' + moodTendency(report.states));
    return lines.join('\n').slice(0, 200);
  } catch { return ''; }
}

/** format.js 的旧调用仅在此同步渲染期间关闭；保留全部原记忆预算和选择规则。 */
export function withoutLegacyMood(render) { suppressLegacy++; try { return render(); } finally { suppressLegacy--; } }
export function readMood() {
  const s = readMoods().states[0];
  return s ? { ts: s.ts, mood: s.name, why: s.causeText, intensity: s.intensity } : null;
}
export function writeMood(input) {
  const result = recordMoodStates([{ name: input?.mood, why: input?.why, intensity: input?.intensity }]);
  const s = readMoods().states.find((v) => v.name === clean(input?.mood, 60));
  return { ts: s?.ts || '', mood: s?.name || '', why: s?.causeText || '', intensity: s?.intensity || 0, ...result };
}
export function visibleMood(now = Date.now()) {
  if (suppressLegacy) return null;
  const s = readMoods({ now }).states.find((v) => v.strength >= MOOD_FADE_THRESHOLD);
  return s ? { ts: s.ts, mood: s.name, why: s.causeText, intensity: s.intensity, ageHours: s.ageHours, strength: s.strength } : null;
}
export function humanAge(hours) {
  if (!Number.isFinite(hours)) return '很久以前';
  if (hours < 1 / 60) return '刚刚';
  if (hours < 1) return Math.floor(hours * 60) + ' 分钟前';
  if (hours < 24) return Math.floor(hours) + ' 小时前';
  return Math.floor(hours / 24) + ' 天前';
}
