import { h, mount } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, field, input, select, tabs, openModal, confirmDialog, toast, empty, formError, badge } from '../ui/kit.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { renderText } from '../help-text.js';

const base = () => (state.user?.isPartner ? '/api/p/help' : '/api/help');
const short = (t, n = 140) => (t.length > n ? `${t.slice(0, n).trimEnd()} …` : t);

/** Hilfe-App: Kapitel passend zu den eigenen Rechten, Suche, „War das hilfreich?“ und (mit Recht) Verwaltung der Kapitel. */
export default async function render(container, ctx) {
  let data = await api.get(base());
  let q = '', cur = null, tab = 'read';
  const target = () => { const t = state.helpTarget; state.helpTarget = null; return t; };
  const pick = (id) => (id && data.articles.some((a) => a.id === id) ? id : null);
  cur = pick(target()) ?? data.articles[0]?.id ?? null;

  const tabHost = h('div', { style: { marginBottom: '12px' } }), host = h('div', { class: 'help-host' });
  mount(container, data.canManage ? tabHost : null, host);

  const article = () => data.articles.find((a) => a.id === cur);
  const results = () => {
    const s = q.trim().toLowerCase(); if (!s) return null;
    return data.articles.map((a) => {
      const hit = a.sections.find((x) => x.text.toLowerCase().includes(s) || x.title.toLowerCase().includes(s));
      const score = (a.title.toLowerCase().includes(s) ? 3 : 0) + (a.summary.toLowerCase().includes(s) ? 2 : 0) + (hit ? 1 : 0);
      return score ? { a, hit, score } : null;
    }).filter(Boolean).sort((x, y) => y.score - x.score);
  };

  function drawActions() {
    ctx.setActions(h('div', { class: 'row' },
      button('Tour ansehen', { icon: 'star', onClick: async () => { const { startTour } = await import('../tour.js'); startTour({ force: true }); } }),
      data.canExport && tab === 'read' && button('PDF (Mitarbeiter)', { icon: 'download', onClick: () => window.open('/api/help/export.pdf?aud=m', '_blank', 'noopener') }),
      data.canExport && tab === 'read' && button('PDF (Partner)', { icon: 'download', onClick: () => window.open('/api/help/export.pdf?aud=p', '_blank', 'noopener') })));
  }

  // ── Lesen ──
  function read() {
    drawActions();
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Hilfe durchsuchen …', value: q, 'aria-label': 'Hilfe durchsuchen' });
    const nav = h('nav', { class: 'help-nav' }), body = h('article', { class: 'help-article' });
    const drawNav = () => {
      const res = results();
      if (res) mount(nav, res.length ? res.map(({ a, hit }) => h('button', { class: `help-item ${a.id === cur ? 'on' : ''}`, type: 'button', onclick: () => { cur = a.id; drawNav(); drawBody(); } },
        icon(a.icon), h('div', null, h('div', { class: 'ht' }, a.title), h('div', { class: 'hs' }, hit ? short(hit.text.replace(/\s+/g, ' '), 90) : a.summary)))) : h('div', { class: 'muted', style: { padding: '8px' } }, 'Nichts gefunden.'));
      else mount(nav, data.groups.map((g) => h('div', { class: 'help-group' }, h('div', { class: 'help-gt' }, g),
        data.articles.filter((a) => a.group === g).map((a) => h('button', { class: `help-item ${a.id === cur ? 'on' : ''}`, type: 'button', onclick: () => { cur = a.id; drawNav(); drawBody(); } }, icon(a.icon), h('div', null, h('div', { class: 'ht' }, a.title)))))));
      nav.querySelector('.help-item.on')?.scrollIntoView({ block: 'nearest' });
    };
    function drawBody() {
      const a = article();
      if (!a) return mount(body, empty('Keine Hilfe verfügbar', 'Für dich sind noch keine Kapitel freigeschaltet.', 'help'));
      const same = data.articles.filter((x) => x.group === a.group && x.id !== a.id);
      const idx = data.articles.findIndex((x) => x.id === a.id), next = data.articles[idx + 1];
      mount(body,
        h('header', { class: 'help-head' }, h('div', { class: 'help-hicon' }, icon(a.icon)), h('div', null, h('div', { class: 'muted', style: { fontSize: '12px' } }, a.group), h('h2', null, a.title), a.summary && h('p', { class: 'muted', style: { margin: '2px 0 0' } }, a.summary))),
        a.sections.map((s) => h('section', { class: 'help-sec' }, h('h3', null, s.title), renderText(s.text))),
        feedbackBox(a),
        (same.length > 0 || next) && h('div', { class: 'help-related' }, h('div', { class: 'help-gt' }, 'Weiterlesen'),
          h('div', { class: 'row', style: { flexWrap: 'wrap' } }, [...(next && !same.includes(next) ? [next] : []), ...same].slice(0, 5).map((x) => button(x.title, { size: 'sm', icon: x.icon, onClick: () => { cur = x.id; drawNav(); drawBody(); body.scrollTop = 0; } })))));
      body.scrollTop = 0;
    }
    search.addEventListener('input', () => { q = search.value; const r = results(); if (r?.length && !r.some((x) => x.a.id === cur)) { cur = r[0].a.id; drawBody(); } drawNav(); });
    mount(host, h('div', { class: 'help-layout' }, h('aside', { class: 'help-side' }, h('div', { class: 'input-icon' }, icon('search'), search), nav), body));
    drawNav(); drawBody();
  }

  function feedbackBox(a) {
    const box = h('div', { class: 'help-fb' });
    const draw = () => {
      const v = data.feedback[a.id];
      mount(box, h('span', null, v === undefined ? 'War das hilfreich?' : v ? 'Danke für deine Rückmeldung!' : 'Danke – wir verbessern das Kapitel.'),
        h('div', { class: 'row' },
          button('Ja', { size: 'sm', icon: 'check', variant: v === 1 ? 'primary' : '', onClick: () => send(true) }),
          button('Nein', { size: 'sm', icon: 'x', variant: v === 0 ? 'primary' : '', onClick: () => comment() })));
    };
    async function send(helpful, commentText) {
      try { await api.post(`${base()}/feedback`, { articleId: a.id, helpful, comment: commentText || undefined }); data.feedback[a.id] = helpful ? 1 : 0; draw(); }
      catch (e) { toast(e.message, 'err'); }
    }
    function comment() {
      const t = h('textarea', { class: 'input', rows: 3, maxlength: 500, placeholder: 'Was hat gefehlt oder war unklar? (optional)' });
      const m = openModal({ title: 'Was können wir besser machen?', body: field('Anmerkung', t, { help: 'Wird anonym an die Verwaltung gemeldet – nur mit deiner Personal- bzw. Zugangsnummer.' }),
        footer: [button('Abbrechen', { onClick: () => m.close() }), button('Senden', { variant: 'primary', onClick: async () => { await send(false, t.value.trim()); m.close(); } })] });
    }
    draw();
    return box;
  }

  // ── Verwaltung ──
  async function manage() {
    drawActions();
    mount(host, h('div', { class: 'muted' }, 'Lade …'));
    const info = await api.get('/api/help/manage');
    const row = (a) => h('tr', null,
      h('td', null, h('div', { class: 'row', style: { flexWrap: 'nowrap', gap: '12px', alignItems: 'center' } }, h('div', { class: 'dot-icon' }, icon(a.icon)), h('div', null, h('strong', null, a.title), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${a.aud === 'm' ? 'Mitarbeiter' : 'Partner'} · ${a.group}`)))),
      h('td', null, a.hidden && badge('Ausgeblendet', 'b-warn'), a.builtin ? (a.modified ? badge('Angepasst', 'b-info') : badge('Standard', 'b-mute', false)) : badge('Eigenes Kapitel', 'b-ok')),
      h('td', { style: { whiteSpace: 'nowrap' } }, a.yes + a.no ? h('span', null, `👍 ${a.yes}  👎 `, a.no > 0 ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); feedbackList(a); } }, String(a.no)) : '0') : h('span', { class: 'muted' }, '–')),
      h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } }, h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '4px' } },
        button('Bearbeiten', { size: 'sm', icon: 'edit', onClick: () => editor(info, a) }),
        button('', { size: 'sm', variant: 'ghost', icon: 'eye', title: a.hidden ? 'Einblenden' : 'Ausblenden', onClick: async () => { await api.put(`/api/help/articles/${a.id}`, { hidden: !a.hidden }); refresh(); } }),
        (a.modified || !a.builtin) && button('', { size: 'sm', variant: 'ghost', icon: a.builtin ? 'refresh' : 'trash', title: a.builtin ? 'Auf Standardtext zurücksetzen' : 'Löschen', onClick: async () => { if (await confirmDialog({ title: a.builtin ? 'Zurücksetzen?' : 'Kapitel löschen?', message: a.builtin ? `„${a.title}“ erhält wieder den Standardtext.` : `„${a.title}“ wird endgültig gelöscht.`, confirmLabel: a.builtin ? 'Zurücksetzen' : 'Löschen' })) { await api.del(`/api/help/articles/${a.id}`); refresh(); } } }))));
    async function refresh() { data = await api.get(base()); if (!pick(cur)) cur = data.articles[0]?.id ?? null; manage(); }
    mount(host, h('div', { class: 'card' },
      h('div', { class: 'card-body', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
        h('div', { class: 'muted' }, 'Standardtexte lassen sich anpassen oder ausblenden, eigene Kapitel anlegen. Sichtbar sind Kapitel nur für Personen mit dem passenden Recht.'),
        button('Neues Kapitel', { variant: 'primary', icon: 'plus', onClick: () => editor(info, null) })),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Kapitel', 'Status', 'Rückmeldungen', ''].map((t) => h('th', null, t)))), h('tbody', null, info.articles.map(row))))));
    return info;
  }
  async function feedbackList(a) {
    const { items } = await api.get(`/api/help/feedback/${a.id}`);
    openModal({ title: `Rückmeldungen: ${a.title}`, body: items.length ? h('div', { class: 'stack' }, items.map((f) => h('div', { class: 'card card-body' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('strong', null, `${f.who} · ${f.kind === 'partner' ? 'Partner' : 'Mitglied'}`), badge(f.helpful ? 'Hilfreich' : 'Nicht hilfreich', f.helpful ? 'b-ok' : 'b-warn')), f.comment && h('div', { style: { marginTop: '6px' } }, f.comment)))) : empty('Noch keine Rückmeldungen', null, 'info') });
  }

  function editor(info, a) {
    const isNew = !a, custom = isNew || !a.builtin;
    const title = input({ value: a?.title ?? '', maxlength: 100 }), summary = input({ value: a?.summary ?? '', maxlength: 240 });
    const group = input({ value: a?.group ?? 'Grundlagen', maxlength: 40, list: 'help-groups' });
    const aud = select([{ value: 'm', label: 'Mitarbeiter' }, { value: 'p', label: 'Externe Partner' }], a?.aud ?? 'm');
    const ic = select(info.icons.map((i) => ({ value: i, label: i })), a?.icon ?? 'info');
    const perm = input({ value: (a?.perm ?? []).join(', '), placeholder: 'z. B. market.view, market.trade (leer = alle)', list: 'help-perms' });
    const dl = h('datalist', { id: 'help-perms' }, info.perms.map((p) => h('option', { value: p.key }, p.description)));
    const dg = h('datalist', { id: 'help-groups' }, [...new Set([...info.groups.m, ...info.groups.p])].map((g) => h('option', { value: g })));
    let secs = (a?.sections ?? [{ title: '', text: '' }]).map((s) => ({ title: s.title, text: s.text, perm: (s.perm ?? []).join(', ') }));
    const list = h('div', { class: 'stack' }), err = h('div');
    const drawSecs = () => mount(list, secs.map((s, i) => {
      const t = h('input', { class: 'input', value: s.title, placeholder: 'Abschnitts-Titel', maxlength: 120 }), x = h('textarea', { class: 'input', rows: 6, style: { minHeight: '140px', resize: 'vertical' }, placeholder: 'Text …' }, s.text), p = h('input', { class: 'input', value: s.perm, placeholder: 'Nur sichtbar mit Recht (optional, z. B. market.manage)', list: 'help-perms' });
      t.addEventListener('input', () => { s.title = t.value; }); x.addEventListener('input', () => { s.text = x.value; }); p.addEventListener('input', () => { s.perm = p.value; });
      return h('div', { class: 'card card-body' }, t, h('div', { style: { height: '6px' } }), x, h('div', { style: { height: '6px' } }), p,
        h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '6px' } },
          button('', { size: 'sm', variant: 'ghost', icon: 'chevronU', title: 'Nach oben', disabled: i === 0, onClick: () => { [secs[i - 1], secs[i]] = [secs[i], secs[i - 1]]; drawSecs(); } }),
          button('', { size: 'sm', variant: 'ghost', icon: 'chevronD', title: 'Nach unten', disabled: i === secs.length - 1, onClick: () => { [secs[i + 1], secs[i]] = [secs[i], secs[i + 1]]; drawSecs(); } }),
          button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Abschnitt entfernen', disabled: secs.length === 1, onClick: () => { secs.splice(i, 1); drawSecs(); } })));
    }));
    drawSecs();
    const permList = (v) => v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
    const save = button('Speichern', { variant: 'primary', onClick: () => busy(save, async () => {
      try {
        const body = { title: title.value, summary: summary.value, group: group.value, icon: ic.value, sections: secs.map((s) => ({ title: s.title, text: s.text, perm: permList(s.perm) })) };
        if (custom) body.perm = permList(perm.value);
        if (isNew) await api.post('/api/help/articles', { ...body, aud: aud.value }); else await api.put(`/api/help/articles/${a.id}`, body);
        m.close(); toast('Gespeichert.'); data = await api.get(base()); manage();
      } catch (e) { mount(err, formError(e.message)); }
    }) });
    const m = openModal({ title: isNew ? 'Neues Kapitel' : `Kapitel bearbeiten: ${a.title}`, wide: true,
      body: h('div', { class: 'stack' }, err, dl, dg, field('Titel', title), field('Kurzbeschreibung', summary), h('div', { class: 'row', style: { flexWrap: 'wrap' } }, field('Gruppe', group), isNew && field('Zielgruppe', aud), field('Symbol', ic)),
        custom && field('Sichtbar für Personen mit mindestens einem dieser Rechte', perm, { help: 'Leer lassen, wenn alle das Kapitel sehen sollen. Partner haben keine Rechte – für sie gilt nur die Zielgruppe.' }),
        h('h4', null, 'Abschnitte'), h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Format: Leerzeile = neuer Absatz · „1. …“ = Schritt · „- …“ = Aufzählung · „Tipp: …“, „Achtung: …“, „Hinweis: …“ = Kasten · **fett**. Ein Recht am Abschnitt blendet ihn für alle ohne dieses Recht aus.'),
        list, button('Abschnitt hinzufügen', { icon: 'plus', onClick: () => { secs.push({ title: '', text: '', perm: '' }); drawSecs(); } })),
      footer: [button('Abbrechen', { onClick: () => m.close() }), save] });
  }

  function show(t) {
    tab = t; if (data.canManage) mount(tabHost, tabs([{ id: 'read', label: 'Anleitung' }, { id: 'manage', label: 'Kapitel verwalten' }], tab, show));
    if (t === 'manage') manage().catch((e) => mount(host, empty('Fehler beim Laden', e.message, 'alert'))); else read();
  }
  show('read');

  const onHelp = (e) => { const id = pick(e.detail?.id); state.helpTarget = null; if (id) { cur = id; q = ''; show('read'); } };
  window.addEventListener('mdt:help', onHelp);
  ctx.live(['help'], async () => { data = await api.get(base()); if (!pick(cur)) cur = data.articles[0]?.id ?? null; if (tab === 'read' && !document.activeElement?.closest?.('.help-side')) read(); }, { wait: 500 });
  return () => window.removeEventListener('mdt:help', onHelp);
}
