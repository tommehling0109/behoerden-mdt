import { h, mount } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, busy, card, field, input, tabs, formError, openModal, confirmDialog, toast, skeletons, empty, note, badge, toggle } from '../../ui/kit.js';
import { api } from '../../api.js';
import { can } from '../../state.js';

const COLORS = ['#f5a524', '#ef4444', '#f472b6', '#a78bfa', '#4f8cff', '#22d3ee', '#22c4a8', '#84cc16', '#94a3b8'];

export default async function render(container, ctx) {
  const canManage = can('lookups.manage');
  mount(container, skeletons(3, 90));
  let lists = [];
  let current = null;
  const tabHost = h('div', { style: { marginBottom: '16px' } });
  const host = h('div');

  async function load(keep) {
    ({ lists } = await api.get('/api/lookups'));
    if (!ctx.isCurrent()) return;
    current = keep && lists.some((l) => l.key === keep) ? keep : current && lists.some((l) => l.key === current) ? current : lists[0]?.key;
    draw();
  }

  function draw() {
    const list = lists.find((l) => l.key === current);
    if (!list) return mount(container, card(null, empty('Keine Listen vorhanden', null, 'tag')));
    mount(tabHost, tabs(lists.map((l) => ({ id: l.key, label: l.label })), current, (k) => { current = k; draw(); }));
    ctx.setActions(canManage && !list.isFixed ? button('Eintrag hinzufügen', { variant: 'primary', icon: 'plus', onClick: () => editor(list, null) }) : '');
    const rows = list.entries.map((e, i) => {
      const row = h('div', { class: 'list-row', style: { cursor: canManage ? 'pointer' : 'default' } },
        h('span', { class: 'badge', style: { '--c': e.color } }, e.label),
        h('div', { class: 'grow' }, e.description ? h('div', { class: 's', style: { whiteSpace: 'normal' } }, e.description) : h('div', { class: 's' }, e.isSystem ? 'Fester Eintrag' : '')),
        !e.isActive && badge('Inaktiv', 'b-mute', false), e.usage > 0 && h('span', { class: 'muted', style: { fontSize: '12px' } }, `${e.usage}× verwendet`),
        canManage && !list.isFixed && h('div', { class: 'actions' },
          button('', { size: 'sm', variant: 'ghost', icon: 'chevronU', title: 'Nach oben', disabled: i === 0, onClick: (ev) => { ev.stopPropagation(); move(list, i, -1); } }),
          button('', { size: 'sm', variant: 'ghost', icon: 'chevronD', title: 'Nach unten', disabled: i === list.entries.length - 1, onClick: (ev) => { ev.stopPropagation(); move(list, i, 1); } })));
      if (canManage) row.addEventListener('click', () => editor(list, e));
      return row;
    });
    mount(host, note(`${list.description}${list.isFixed ? ' Beschriftung, Farbe und Beschreibung sind anpassbar.' : ''}`, 'info'), h('div', { style: { height: '14px' } }),
      card(null, rows.length ? rows : empty('Noch keine Einträge', canManage ? 'Füge den ersten Eintrag hinzu.' : null, 'tag'), { flush: true }));
    mount(container, tabHost, host);
  }

  async function move(list, i, dir) {
    const ids = list.entries.map((e) => e.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    try { await api.post(`/api/lookups/${list.key}/order/set`, { ids }); await load(); } catch (e) { toast(e.message, 'err'); }
  }

  function editor(list, entry) {
    const err = h('div');
    const label = input({ value: entry?.label ?? '', maxLength: 60 });
    const desc = h('textarea', { class: 'textarea', maxLength: 500, placeholder: list.key === 'market.handover_place' ? 'Anweisung für Partner, z. B. Adresse oder Hinweis zur Übergabe' : 'Beschreibung (optional)' }, entry?.description ?? '');
    let color = entry?.color ?? '#4f8cff';
    const pick = input({ type: 'color', class: 'input input-color', value: color });
    const sw = h('div', { class: 'swatches' });
    const paint = () => mount(sw, COLORS.map((c) => h('button', { type: 'button', class: `swatch ${c === color ? 'on' : ''}`, style: { '--s': c }, 'aria-label': c, onclick: () => { color = c; pick.value = c; paint(); } })));
    pick.addEventListener('input', () => { color = pick.value; paint(); }); paint();
    const active = entry && !entry.isSystem ? toggle('Aktiv (auswählbar)', entry.isActive) : null;
    const footer = [];
    if (entry && !entry.isSystem) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      const r = await confirmDialog({ title: 'Eintrag löschen?', message: `„${entry.label}“ wird gelöscht.${entry.usage ? ` Er wird noch ${entry.usage}× verwendet – deaktiviere ihn stattdessen.` : ''}`, confirmLabel: 'Löschen' });
      if (!r) return;
      try { await api.del(`/api/lookups/${list.key}/${entry.id}`); m.close(); toast('Gelöscht.'); load(); } catch (e) { toast(e.message, 'err'); }
    } }));
    footer.push(h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }), button(entry ? 'Speichern' : 'Hinzufügen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      const payload = { label: label.value, description: desc.value, color };
      if (active) payload.isActive = active.input.checked;
      try { if (entry) await api.patch(`/api/lookups/${list.key}/${entry.id}`, payload); else await api.post(`/api/lookups/${list.key}`, payload); m.close(); toast('Gespeichert.'); load(); }
      catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) }));
    const m = openModal({ title: entry ? entry.label : `Neuer Eintrag – ${list.label}`, body: h('div', null, err, field('Bezeichnung', label), field('Beschreibung', desc), field('Farbe', h('div', null, h('div', { class: 'row' }, pick), sw)), active), footer });
  }

  ctx.live(['lookups'], () => load());
  await load();
}
