import { h, mount } from '../ui/dom.js';
import { button, tabs, empty } from '../ui/kit.js';
import { api } from '../api.js';

/**
 * Legal: Reiter Gesetzessammlung und Bußgeldkatalog (je ein live eingebettetes Google-Dokument; Link in der Konfiguration, ohne Link ein Platzhalter)
 * sowie die Rechtsfälle (Aktensystem).
 */
const DOCS = {
  laws: { label: 'Gesetzessammlung', icon: 'book', todo: 'Die Gesetzessammlung wurde noch nicht hinterlegt.' },
  fines: { label: 'Bußgeldkatalog', icon: 'list', todo: 'Der Bußgeldkatalog wurde noch nicht hinterlegt.' },
};

export default async function render(container, ctx) {
  let data = await api.get('/api/legal');
  const TABS = [...Object.entries(DOCS).map(([id, d]) => ({ id, label: d.label })), ...(data.canCases ? [{ id: 'cases', label: 'Rechtsfälle' }] : [])];
  let tab = 'laws', casesApi = null;
  const tabHost = h('div', { style: { marginBottom: '12px' } }), host = h('div', { class: 'legal-host' });
  mount(container, tabHost, host);

  function doc(id) {
    const d = data[id], meta = DOCS[id];
    ctx.setActions(d && h('div', { class: 'row' },
      button('Neu laden', { icon: 'refresh', onClick: () => doc(id) }),
      button('In Google öffnen', { icon: 'link', onClick: () => window.open(d.openUrl, '_blank', 'noopener') }),
      data.canManage && button('Link ändern', { icon: 'edit', onClick: () => ctx.openApp('config') })));
    if (!d) {
      ctx.setActions(data.canManage && button('Link hinterlegen', { icon: 'edit', onClick: () => ctx.openApp('config') }));
      return mount(host, h('div', { class: 'card card-body' }, empty(`${meta.label} – to be done`, data.canManage ? `${meta.todo} Hinterlege den Link unter Konfiguration → „Legal“.` : `${meta.todo} Sie folgt in einem späteren Update.`, 'clock')));
    }
    mount(host,
      h('iframe', { class: 'legal-frame', src: d.embedUrl, title: meta.label, referrerpolicy: 'no-referrer', allow: 'clipboard-write' }),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
        'Live-Ansicht des Google-Dokuments – Änderungen im Dokument erscheinen hier nach „Neu laden“. Wird nichts angezeigt, muss das Dokument für „Jeder mit dem Link“ freigegeben sein.'));
  }

  function show(t) {
    tab = t; mount(tabHost, tabs(TABS, tab, show));
    if (t !== 'cases') delete host.dataset.lc; // Rechtsfälle schreiben nur, solange ihr Reiter offen ist
    if (t === 'cases') {
      ctx.setActions(null);
      mount(host, h('div', { class: 'muted' }, 'Lade …'));
      import('./legal-cases.js').then(async (mod) => { if (tab !== 'cases') return; try { casesApi = await mod.default(host, ctx, { setActions: (a) => ctx.setActions(a) }); } catch (e) { mount(host, empty('Fehler beim Laden', e.message, 'alert')); } });
    } else doc(t);
  }

  ctx.live?.(['legal', 'contacts', 'system'], async () => {
    if (tab === 'cases') return casesApi?.refresh();
    const before = JSON.stringify([data.laws, data.fines]);
    try { data = await api.get('/api/legal'); } catch { return; }
    if (JSON.stringify([data.laws, data.fines]) !== before) doc(tab); // nur neu laden, wenn sich ein Link geändert hat
  });
  show('laws');
}
