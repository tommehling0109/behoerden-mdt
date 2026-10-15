import { all, get, run, now } from '../core/db.js';
import { bad, notFound, forbidden, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { getConfig } from '../core/config.js';
import { can } from '../core/permissions.js';
import { levelBrief } from '../core/levels.js';
import { HELP_ARTICLES, GROUPS_M, GROUPS_P } from '../core/help-content.js';
import { buildPdf } from '../core/pdf.js';
import { publish } from '../core/realtime.js';

/**
 * Hilfe-App: Anleitungen, die sich nach den Rechten der Person richten – Mitarbeiter und externe Partner sehen nur Kapitel (und Abschnitte) zu Dingen, die sie
 * nutzen dürfen. Standardtexte stehen in core/help-content.js; Administratoren (Recht „help.manage“) können sie überschreiben, ausblenden und eigene Kapitel
 * anlegen. Dazu: „War das hilfreich?“-Rückmeldungen, Status der Erste-Schritte-Tour und PDF-Export (nur Superadmin).
 */
const ICONS = ['home', 'dashboard', 'flag', 'bell', 'lock', 'check', 'shield', 'info', 'tag', 'star', 'map', 'storage', 'car', 'wallet', 'chart', 'bank', 'dollar', 'bug', 'scale', 'book', 'chat', 'users', 'sitemap', 'link', 'list', 'settings', 'audit', 'help'];
const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const BUILTIN = new Map(HELP_ARTICLES.map((a, i) => [a.id, { ...a, order: i }]));

/** Alle Kapitel (Standard + Überschreibungen + eigene), unabhängig von Rechten. */
export function allArticles() {
  const rows = new Map(all('SELECT * FROM help_articles').map((r) => [r.id, r]));
  const out = [];
  for (const a of BUILTIN.values()) {
    const o = rows.get(a.id);
    out.push({
      id: a.id, aud: a.aud, group: o?.grp || a.group, title: o?.title || a.title, icon: o?.icon || a.icon, summary: o?.summary ?? a.summary ?? '',
      app: a.app ?? null, perm: a.perm ?? [], cfg: a.cfg ?? null, needLevel: !!a.needLevel, sections: o?.sections ? json(o.sections, a.sections) : a.sections,
      hidden: !!o?.hidden, builtin: true, modified: !!(o && (o.title || o.summary != null || o.sections || o.grp || o.icon)), order: a.order,
      updatedAt: o?.updated_at ?? null,
    });
  }
  for (const r of rows.values()) {
    if (r.builtin) continue;
    out.push({ id: r.id, aud: r.aud, group: r.grp, title: r.title, icon: r.icon || 'info', summary: r.summary ?? '', app: null, perm: json(r.perm, []), cfg: null, needLevel: false, sections: json(r.sections, []), hidden: !!r.hidden, builtin: false, modified: false, order: 1000 + (r.sort_order ?? 0), updatedAt: r.updated_at });
  }
  return out.sort((a, b) => a.order - b.order);
}

/** Zugriffsprofil einer Person: was darf sie sehen? */
const memberView = (user) => ({
  aud: 'm', can: (p) => can(user, p),
  off: new Set(Array.isArray(getConfig('system.disabled_apps')) ? getConfig('system.disabled_apps') : []),
  cfg: (k) => !!getConfig(k), apps: null, level: false,
});
const partnerView = (partner) => ({ aud: 'p', can: () => true, off: new Set(), cfg: () => true, apps: partner.apps, level: !!levelBrief(partner.id) });

/** Sichtbare Kapitel (mit nur den sichtbaren Abschnitten) für eine Person. */
export function visibleArticles(view) {
  const out = [];
  for (const a of allArticles()) {
    if (a.aud !== view.aud || a.hidden) continue;
    if (view.aud === 'm') {
      if (a.perm.length && !a.perm.some((p) => view.can(p))) continue;
      if (a.app && view.off.has(a.app)) continue;
      if (a.cfg && !view.cfg(a.cfg)) continue;
    } else {
      if (a.app && !view.apps.has(a.app)) continue;
      if (a.needLevel && !view.level) continue;
    }
    const sections = a.sections.filter((s) => view.aud === 'p' || !s.perm?.length || s.perm.some((p) => view.can(p))).map((s) => ({ title: s.title, text: s.text }));
    if (!sections.length) continue;
    out.push({ id: a.id, group: a.group, title: a.title, icon: a.icon, summary: a.summary, app: a.app, sections, updatedAt: a.updatedAt });
  }
  return out;
}

const whoOf = (ctx) => (ctx.partner ? `p:${ctx.partner.id}` : `u:${ctx.user.id}`);
const label = (who) => {
  const [k, id] = [who[0], Number(who.slice(2))];
  return k === 'p' ? (get('SELECT partner_number n FROM partners WHERE id = ?', id)?.n ?? `Partner #${id}`) : (get('SELECT member_number n FROM users WHERE id = ?', id)?.n ?? `Mitglied #${id}`);
};

function payload(ctx, view) {
  const who = whoOf(ctx), articles = visibleArticles(view);
  const fb = Object.fromEntries(all('SELECT article_id, helpful FROM help_feedback WHERE who = ?', who).map((r) => [r.article_id, r.helpful ? 1 : 0]));
  const customGroups = [...new Set(articles.map((a) => a.group))];
  const base = view.aud === 'm' ? GROUPS_M : GROUPS_P;
  return {
    articles, groups: [...base.filter((g) => customGroups.includes(g)), ...customGroups.filter((g) => !base.includes(g))], feedback: fb,
    tourDone: !!get('SELECT 1 x FROM help_state WHERE who = ? AND tour_done_at IS NOT NULL', who),
  };
}
function feedback(ctx, view) {
  const id = String(ctx.body.articleId ?? ''), a = visibleArticles(view).find((x) => x.id === id);
  if (!a) throw notFound('Kapitel nicht gefunden.');
  const helpful = ctx.body.helpful === true || ctx.body.helpful === 1 ? 1 : ctx.body.helpful === false || ctx.body.helpful === 0 ? 0 : null;
  if (helpful === null) throw bad('Bitte „Ja“ oder „Nein“ wählen.');
  const comment = ctx.body.comment ? str(ctx.body.comment, 'Anmerkung', { max: 500, required: false }) : null, t = now();
  run(`INSERT INTO help_feedback (article_id, who, helpful, comment, created_at, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(article_id, who) DO UPDATE SET helpful = excluded.helpful, comment = excluded.comment, updated_at = excluded.updated_at`, id, whoOf(ctx), helpful, comment || null, t, t);
  publish({ topic: 'help', kind: 'feedback', staff: 1, staffPerm: 'help.manage' });
  return { ok: true };
}
function tour(ctx) {
  const done = ctx.body.done !== false, who = whoOf(ctx);
  run(`INSERT INTO help_state (who, tour_done_at) VALUES (?,?) ON CONFLICT(who) DO UPDATE SET tour_done_at = excluded.tour_done_at`, who, done ? now() : null);
  return { ok: true };
}

// Abschnitte prüfen (Verwaltung)
function cleanSections(v, permOk) {
  if (!Array.isArray(v) || !v.length) throw bad('Ein Kapitel braucht mindestens einen Abschnitt.');
  if (v.length > 30) throw bad('Höchstens 30 Abschnitte pro Kapitel.');
  return v.map((s) => {
    const perm = Array.isArray(s.perm) ? s.perm.map(String).filter(Boolean) : [];
    for (const p of perm) if (!permOk(p)) throw bad(`Unbekanntes Recht „${p}“.`);
    return { title: str(s.title, 'Abschnitts-Titel', { min: 1, max: 120 }), text: str(s.text, 'Text', { min: 1, max: 8000 }), ...(perm.length ? { perm } : {}) };
  });
}

function toBlocks(articles, sectionsOf = (a) => a.sections) {
  const blocks = []; let group = null;
  for (const a of articles) {
    if (a.group !== group) { group = a.group; blocks.push({ t: 'h1', text: group }); }
    blocks.push({ t: 'h2', text: a.title });
    if (a.summary) blocks.push({ t: 'p', text: a.summary });
    for (const s of sectionsOf(a)) {
      blocks.push({ t: 'h3', text: s.title });
      let n = 0;
      for (const para of String(s.text).split(/\n{2,}/)) {
        const lines = para.split('\n');
        if (lines.every((l) => /^\d+\.\s/.test(l))) { for (const l of lines) blocks.push({ t: 'step', n: ++n, text: l.replace(/^\d+\.\s+/, '') }); continue; }
        const nm = /^(Tipp|Achtung|Hinweis):\s*([\s\S]*)$/.exec(para);
        if (nm) { blocks.push({ t: 'note', label: nm[1], text: nm[2] }); continue; }
        let buf = [];
        const flush = () => { if (buf.length) { blocks.push({ t: 'p', text: buf.join(' ') }); buf = []; } };
        for (const l of lines) { if (/^-\s/.test(l)) { flush(); blocks.push({ t: 'li', text: l.replace(/^-\s+/, '') }); } else if (/^\d+\.\s/.test(l)) { flush(); blocks.push({ t: 'step', n: ++n, text: l.replace(/^\d+\.\s+/, '') }); } else buf.push(l); }
        flush();
      }
    }
  }
  return blocks;
}

export default {
  name: 'help',
  permissions: [['help.manage', 'Hilfe: Kapitel bearbeiten, ausblenden, eigene Kapitel anlegen und Rückmeldungen ansehen']],
  config: [
    { key: 'help.tour', group: 'Hilfe', label: 'Erste-Schritte-Tour anzeigen', help: 'Zeigt neuen Mitarbeitern und Partnern beim ersten Anmelden eine kurze Tour durch das Panel (überspringbar; in der Hilfe jederzeit wiederholbar).', type: 'bool', default: true, public: true },
  ],
  routes(r) {
    // ── Mitarbeiter ──
    r.get('/api/help', (ctx) => ({ ...payload(ctx, memberView(ctx.user)), canManage: can(ctx.user, 'help.manage'), canExport: !!ctx.user.isSuperadmin }));
    r.post('/api/help/feedback', (ctx) => feedback(ctx, memberView(ctx.user)));
    r.post('/api/help/tour', (ctx) => tour(ctx));

    // ── Partner ──
    const appOn = () => { const off = getConfig('system.disabled_apps'); if (Array.isArray(off) && off.includes('help')) throw forbidden('Diese App wurde vom Administrator deaktiviert.'); };
    r.get('/api/p/help', { auth: 'partner' }, (ctx) => { appOn(); return { ...payload(ctx, partnerView(ctx.partner)), canManage: false, canExport: false }; });
    r.post('/api/p/help/feedback', { auth: 'partner' }, (ctx) => { appOn(); return feedback(ctx, partnerView(ctx.partner)); });
    r.post('/api/p/help/tour', { auth: 'partner' }, (ctx) => { appOn(); return tour(ctx); });

    // ── Verwaltung ──
    r.get('/api/help/manage', { perm: 'help.manage' }, () => {
      const fb = new Map(all('SELECT article_id id, SUM(helpful) yes, SUM(1 - helpful) no FROM help_feedback GROUP BY article_id').map((x) => [x.id, x]));
      return {
        articles: allArticles().map((a) => ({ ...a, yes: fb.get(a.id)?.yes ?? 0, no: fb.get(a.id)?.no ?? 0 })),
        groups: { m: GROUPS_M, p: GROUPS_P }, icons: ICONS,
        perms: all('SELECT key, description FROM permissions ORDER BY key').map((p) => ({ key: p.key, description: p.description })),
      };
    });
    r.get('/api/help/feedback/:id', { perm: 'help.manage' }, (ctx) => ({
      items: all('SELECT who, helpful, comment, updated_at FROM help_feedback WHERE article_id = ? ORDER BY updated_at DESC LIMIT 100', ctx.params.id).map((f) => ({ who: label(f.who), kind: f.who[0] === 'p' ? 'partner' : 'member', helpful: !!f.helpful, comment: f.comment, at: f.updated_at })),
    }));
    const permOk = (p) => !!get('SELECT 1 x FROM permissions WHERE key = ?', p);
    const touch = (ctx, id, title, action) => { audit(ctx, { action, module: 'help', targetType: 'help_article', targetId: id, targetLabel: title }); return id; };
    r.put('/api/help/articles/:id', { perm: 'help.manage' }, (ctx) => {
      const id = ctx.params.id, a = allArticles().find((x) => x.id === id); if (!a) throw notFound('Kapitel nicht gefunden.');
      const b = ctx.body, t = now();
      const title = b.title !== undefined ? str(b.title, 'Titel', { min: 2, max: 100 }) : a.title;
      const summary = b.summary !== undefined ? str(b.summary, 'Kurzbeschreibung', { max: 240, required: false }) : a.summary;
      const sections = b.sections !== undefined ? cleanSections(b.sections, permOk) : a.sections;
      const grp = b.group !== undefined ? str(b.group, 'Gruppe', { min: 2, max: 40 }) : a.group;
      const icon = b.icon !== undefined ? (ICONS.includes(b.icon) ? b.icon : a.icon) : a.icon;
      const hidden = b.hidden !== undefined ? (b.hidden ? 1 : 0) : (a.hidden ? 1 : 0);
      if (a.builtin) run(`INSERT INTO help_articles (id, builtin, title, summary, sections, grp, icon, hidden, updated_at, updated_by) VALUES (?,1,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, summary=excluded.summary, sections=excluded.sections, grp=excluded.grp, icon=excluded.icon, hidden=excluded.hidden, updated_at=excluded.updated_at, updated_by=excluded.updated_by`, id, title, summary, JSON.stringify(sections), grp, icon, hidden, t, ctx.user.id);
      else {
        const perm = b.perm !== undefined ? (Array.isArray(b.perm) ? b.perm.map(String).filter((p) => { if (!permOk(p)) throw bad(`Unbekanntes Recht „${p}“.`); return true; }) : []) : a.perm;
        run('UPDATE help_articles SET title=?, summary=?, sections=?, grp=?, icon=?, hidden=?, perm=?, updated_at=?, updated_by=? WHERE id=?', title, summary, JSON.stringify(sections), grp, icon, hidden, JSON.stringify(perm), t, ctx.user.id, id);
      }
      touch(ctx, id, title, 'help.article_updated');
      return { ok: true };
    });
    r.post('/api/help/articles', { perm: 'help.manage' }, (ctx) => {
      const b = ctx.body, aud = b.aud === 'p' ? 'p' : 'm', t = now();
      const title = str(b.title, 'Titel', { min: 2, max: 100 }), summary = str(b.summary ?? '', 'Kurzbeschreibung', { max: 240, required: false }), grp = str(b.group ?? 'Grundlagen', 'Gruppe', { min: 2, max: 40 });
      const sections = cleanSections(b.sections, permOk);
      const perm = Array.isArray(b.perm) ? b.perm.map(String).filter((p) => { if (!permOk(p)) throw bad(`Unbekanntes Recht „${p}“.`); return true; }) : [];
      const id = `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, max = get('SELECT COALESCE(MAX(sort_order),0) m FROM help_articles').m;
      run('INSERT INTO help_articles (id, builtin, aud, grp, title, icon, summary, perm, sections, sort_order, hidden, updated_at, updated_by) VALUES (?,0,?,?,?,?,?,?,?,?,0,?,?)',
        id, aud, grp, title, ICONS.includes(b.icon) ? b.icon : 'info', summary, JSON.stringify(perm), JSON.stringify(sections), max + 1, t, ctx.user.id);
      touch(ctx, id, title, 'help.article_created');
      ctx.status = 201; return { id };
    });
    r.delete('/api/help/articles/:id', { perm: 'help.manage' }, (ctx) => {
      const a = allArticles().find((x) => x.id === ctx.params.id); if (!a) throw notFound('Kapitel nicht gefunden.');
      run('DELETE FROM help_articles WHERE id = ?', a.id); // eigenes Kapitel: weg · Standardkapitel: zurück auf den Standardtext
      touch(ctx, a.id, a.title, a.builtin ? 'help.article_reset' : 'help.article_deleted');
      return { ok: true };
    });

    // ── PDF-Export (nur Superadmin) ──
    r.get('/api/help/export.pdf', (ctx) => {
      if (!ctx.user.isSuperadmin) throw forbidden('Nur Superadmins dürfen die Hilfe als PDF exportieren.');
      const aud = ctx.query.aud === 'p' ? 'p' : 'm';
      const list = allArticles().filter((a) => a.aud === aud && !a.hidden);
      const name = getConfig('system.name') || 'MDT';
      const pdf = buildPdf({ title: `${name} – Anleitung`, subtitle: aud === 'm' ? 'Handbuch für Mitarbeiter (alle Kapitel)' : 'Anleitung für externe Partner', blocks: toBlocks(list) });
      audit(ctx, { action: 'help.export', module: 'help', targetType: 'help', targetLabel: aud === 'm' ? 'Mitarbeiter' : 'Partner' });
      ctx.raw = { contentType: 'application/pdf', filename: `Anleitung-${aud === 'm' ? 'Mitarbeiter' : 'Partner'}-${new Date().toISOString().slice(0, 10)}.pdf`, body: pdf };
    });
  },
};
