import { h, mount } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import {
  button, busy, card, field, input, select, checkbox, formError, tabs, table, rankBadge, deptBadge,
  openModal, confirmDialog, toast, skeletons, empty, note,
} from '../../ui/kit.js';
import { api } from '../../api.js';
import { can, state } from '../../state.js';

const MODULE_LABELS = { system: 'System', users: 'Benutzer', roles: 'Rollen', audit: 'Audit-Log', org: 'Organisation', chat: 'Chat', market: 'Börse', partners: 'Externe Zugänge', lookups: 'Kategorien', permissions: 'Eigene Rechte', vehicles: 'Fahrzeuge', warehouse: 'Lager', finance: 'Finanzen', tab: 'Deckel', credit: 'Kredit', map: 'Karte' };
const COLORS = ['#f5a524', '#ef4444', '#f472b6', '#a78bfa', '#4f8cff', '#22d3ee', '#22c4a8', '#84cc16', '#94a3b8'];

/** Farbwahl: Schnellauswahl + freie Farbe. */
function colorPicker(initial, disabled) {
  let value = initial;
  const picker = input({ type: 'color', value, class: 'input input-color', disabled });
  const wrap = h('div');
  const sw = h('div', { class: 'swatches' });
  const paint = () => {
    mount(sw, COLORS.map((c) => h('button', { type: 'button', class: `swatch ${c === value ? 'on' : ''}`, style: { '--s': c }, disabled, 'aria-label': c,
      onclick: () => { value = c; picker.value = c; paint(); } })));
  };
  picker.addEventListener('input', () => { value = picker.value; paint(); });
  paint();
  mount(wrap, h('div', { class: 'row' }, picker), sw);
  return { el: wrap, get: () => value };
}

export default async function render(container, ctx) {
  const canManage = can('org.manage');
  mount(container, skeletons(3, 120));
  const [org, permRes] = await Promise.all([api.get('/api/org'), api.get('/api/permissions').catch(() => ({ permissions: [] }))]);
  if (!ctx.isCurrent()) return;
  let data = org;
  const permissions = permRes.permissions;
  let tab = 'hierarchy';
  const host = h('div');
  const tabHost = h('div', { style: { marginBottom: '16px' } });
  mount(container, tabHost, host);

  const deptById = (id) => data.departments.find((d) => d.id === id);
  const rankById = (id) => data.ranks.find((r) => r.id === id);

  async function reload() {
    data = await api.get('/api/org');
    show(tab);
  }

  function show(t) {
    tab = t;
    mount(tabHost, tabs([
      { id: 'hierarchy', label: 'Hierarchie' }, { id: 'ranks', label: 'Ränge', count: data.ranks.length }, { id: 'departments', label: 'Abteilungen', count: data.departments.length },
    ], tab, show));
    if (canManage) {
      ctx.setActions(tab === 'departments'
        ? button('Abteilung erstellen', { variant: 'primary', icon: 'plus', onClick: () => deptEditor(null) })
        : button('Rang erstellen', { variant: 'primary', icon: 'plus', onClick: () => rankEditor(null) }));
    }
    mount(host, tab === 'hierarchy' ? hierarchy() : tab === 'ranks' ? ranksTable() : departments());
  }

  // ── Hierarchie (Organigramm) ──
  function hierarchy() {
    if (!data.ranks.length) return card(null, empty('Noch keine Ränge', canManage ? 'Lege Ränge an und verbinde sie über „Vorgesetzter Rang“ zu einer Hierarchie.' : 'Es wurden noch keine Ränge angelegt.', 'sitemap'));
    const kids = new Map();
    for (const r of data.ranks) {
      const k = r.parentRankId && rankById(r.parentRankId) ? r.parentRankId : 'root';
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(r);
    }
    const seen = new Set();
    const node = (r) => {
      if (seen.has(r.id)) return null;
      seen.add(r.id);
      const d = r.departmentId ? deptById(r.departmentId) : null;
      const el = h('div', { class: 'otree-node', style: { '--rc': r.color }, tabindex: canManage ? 0 : undefined, role: canManage ? 'button' : undefined },
        h('div', { class: 'on-main' }, rankBadge(r), d && deptBadge(d)),
        r.description && h('div', { class: 'on-desc' }, r.description),
        h('div', { class: 'on-meta' }, icon('users'), `${r.memberCount} Mitglied${r.memberCount === 1 ? '' : 'er'}`, r.permissions.length > 0 && ` · ${r.permissions.length} Rechte`));
      if (canManage) { el.addEventListener('click', () => rankEditor(r)); el.addEventListener('keydown', (e) => { if (e.key === 'Enter') rankEditor(r); }); }
      const children = (kids.get(r.id) ?? []).map(node).filter(Boolean);
      return h('li', null, el, children.length > 0 && h('ul', null, children));
    };
    const roots = (kids.get('root') ?? []).map(node).filter(Boolean);
    const hasTree = data.ranks.some((r) => r.parentRankId);
    return h('div', { class: 'stack' },
      !hasTree && note('Die Ränge sind noch nicht verbunden. Wähle bei einem Rang einen „Vorgesetzten Rang“, um eine Hierarchie aufzubauen.'),
      h('div', { class: 'card card-body' }, h('ul', { class: 'otree' }, roots)));
  }

  // ── Ränge ──
  async function move(rank, dir) {
    const ids = data.ranks.map((r) => r.id);
    const i = ids.indexOf(rank.id), j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await api.post('/api/ranks/order', { ids }); await reload(); } catch (e) { toast(e.message, 'err'); }
  }
  function ranksTable() {
    return table([
      { label: '#', style: { width: '48px' }, render: (r) => h('span', { class: 'muted mono' }, data.ranks.indexOf(r) + 1) },
      { label: 'Rang', render: (r) => h('div', null, rankBadge(r), r.description && h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px', whiteSpace: 'normal' } }, r.description)) },
      { label: 'Abteilung', render: (r) => (r.departmentId ? deptBadge(deptById(r.departmentId)) : h('span', { class: 'muted' }, '–')) },
      { label: 'Vorgesetzter Rang', render: (r) => (r.parentRankId ? rankById(r.parentRankId)?.name ?? '–' : h('span', { class: 'muted' }, '–')) },
      { label: 'Mitglieder', render: (r) => r.memberCount },
      { label: 'Rechte', render: (r) => (r.permissions.length ? r.permissions.length : h('span', { class: 'muted' }, 'keine')) },
      canManage && { label: '', style: { width: '1%' }, render: (r) => h('div', { class: 'actions' },
        button('', { size: 'sm', variant: 'ghost', icon: 'chevronU', title: 'Nach oben', disabled: data.ranks[0] === r, onClick: () => move(r, -1) }),
        button('', { size: 'sm', variant: 'ghost', icon: 'chevronD', title: 'Nach unten', disabled: data.ranks.at(-1) === r, onClick: () => move(r, 1) }),
        button('Bearbeiten', { size: 'sm', icon: 'edit', onClick: () => rankEditor(r) })) },
    ].filter(Boolean), data.ranks, { onRowClick: canManage ? rankEditor : undefined, empty: empty('Noch keine Ränge', 'Lege den ersten Rang an.', 'shield') });
  }

  function rankEditor(rank) {
    const err = h('div');
    const name = input({ value: rank?.name ?? '', maxLength: 60 });
    const desc = input({ value: rank?.description ?? '', maxLength: 200 });
    const col = colorPicker(rank?.color ?? '#4f8cff');
    const dept = select([{ value: '', label: '— keine Abteilung —' }, ...data.departments.map((d) => ({ value: d.id, label: d.name }))], rank?.departmentId ?? '');
    const parent = select([{ value: '', label: '— kein Vorgesetzter (oberste Ebene) —' }, ...data.ranks.filter((r) => r.id !== rank?.id).map((r) => ({ value: r.id, label: r.name }))], rank?.parentRankId ?? '');
    const have = new Set(rank?.permissions ?? []);
    const lowerSel = rank ? null : select([{ value: '', label: '— ans Ende der Rangfolge (keine Vererbung) —' }, ...data.ranks.map((r) => ({ value: r.id, label: r.name }))], '');
    const inhNote = h('div'); let inherited = new Set();
    const groups = {};
    const boxes = permissions.map((p) => {
      const mine = state.user.isAdmin || state.user.permissions.includes(p.key) || have.has(p.key);
      const c = checkbox(h('code', null, p.key), have.has(p.key), { desc: p.description, locked: !mine });
      (groups[p.module] ??= []).push(c);
      return [p, c];
    });
    // Rechte der darunterliegenden Rang übernehmen (nur solche, die man selbst vergeben darf); manuell weiter änderbar
    function inheritFrom(low, replace) {
      if (replace) boxes.forEach(([p, c]) => { if (inherited.has(p.key) && !c.input.disabled) c.input.checked = false; });
      inherited = new Set(); let skipped = 0;
      for (const [p, c] of boxes) { if (!low.permissions.includes(p.key)) continue; if (c.input.disabled) { skipped++; continue; } c.input.checked = true; inherited.add(p.key); }
      inhNote.replaceChildren(low.permissions.length ? note(`${inherited.size} Recht${inherited.size === 1 ? '' : 'e'} von „${low.name}“ übernommen${skipped ? ` (${skipped} nicht, da du sie selbst nicht besitzt)` : ''}. Du kannst einzelne Häkchen unten wieder entfernen.`) : note(`„${low.name}“ hat keine Rechte, die übernommen werden könnten.`));
    }
    if (lowerSel) lowerSel.addEventListener('change', () => {
      const low = rankById(Number(lowerSel.value));
      if (!low) { boxes.forEach(([p, c]) => { if (inherited.has(p.key) && !c.input.disabled) c.input.checked = false; }); inherited = new Set(); inhNote.replaceChildren(); return; }
      parent.value = low.parentRankId ?? ''; inheritFrom(low, true);
    });
    const below = rank ? data.ranks[data.ranks.indexOf(rank) + 1] : null;
    const permUI = Object.entries(groups).map(([m, items]) => h('div', { class: 'perm-group' }, h('h4', null, MODULE_LABELS[m] ?? m), h('div', { class: 'perm-grid' }, items)));
    const body = h('div', null, err,
      h('div', { class: 'form-row' }, field('Name', name), field('Beschreibung', desc)),
      field('Rangfarbe', col.el),
      h('div', { class: 'form-row' },
        field('Abteilung', dept, { help: 'Optional – z. B. für Legal-Ränge.' }),
        field('Vorgesetzter Rang', parent, { help: 'Bestimmt die Position im Organigramm.' })),
      lowerSel && field('Steht direkt über', lowerSel, { help: 'Der neue Rang wird über diesen Rang einsortiert, rückt in der Hierarchie über ihn und erbt seine Rechte (bereits vorhandene). Danach kannst du Rechte manuell wieder entfernen.' }),
      inhNote,
      h('div', { class: 'sep' }),
      h('div', { class: 'label', style: { marginBottom: '8px' } }, 'Rechte dieses Rangs'),
      below && h('div', { style: { marginBottom: '10px' } }, button(`Rechte von „${below.name}“ (darunter) hinzufügen`, { size: 'sm', icon: 'plus', onClick: () => inheritFrom(below, false) })),
      note('Rang und Rechte sind getrennt: Ein Rang hat standardmäßig keine Rechte. Hier konfigurierte Rechte gelten zusätzlich zu Rollen und direkten Rechten.'),
      h('div', { style: { height: '14px' } }),
      permissions.length ? permUI : h('div', { class: 'muted' }, 'Rechte-Katalog nicht verfügbar.'));
    const footer = [];
    if (rank) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      const r = await confirmDialog({ title: 'Rang löschen?', message: `„${rank.name}“ wird gelöscht.${rank.memberCount ? ` Er ist noch ${rank.memberCount} Mitglied(ern) zugewiesen und kann nicht gelöscht werden.` : ''}`, confirmLabel: 'Löschen' });
      if (!r) return;
      try { await api.del(`/api/ranks/${rank.id}`); m.close(); toast('Rang gelöscht.'); reload(); } catch (e) { toast(e.message, 'err'); }
    } }));
    footer.push(h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }),
      button(rank ? 'Speichern' : 'Erstellen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        const payload = {
          name: name.value, description: desc.value, color: col.get(),
          departmentId: dept.value ? Number(dept.value) : null, parentRankId: parent.value ? Number(parent.value) : null,
          permissions: boxes.filter(([, c]) => c.input.checked).map(([p]) => p.key),
        };
        if (lowerSel?.value) payload.placeAbove = Number(lowerSel.value);
        try {
          if (rank) await api.patch(`/api/ranks/${rank.id}`, payload); else await api.post('/api/ranks', payload);
          m.close(); toast(rank ? 'Rang gespeichert.' : 'Rang erstellt.'); reload();
        } catch (ex) { err.replaceChildren(formError(ex.message)); body.parentElement.scrollTop = 0; }
      }) }));
    const m = openModal({ title: rank ? `Rang: ${rank.name}` : 'Neuer Rang', wide: true, body, footer });
  }

  // ── Abteilungen ──
  function departments() {
    if (!data.departments.length) return card(null, empty('Noch keine Abteilungen', canManage ? 'Lege z. B. Führung, Operativ oder Legal an.' : null, 'sitemap'));
    return h('div', { class: 'role-grid' }, data.departments.map((d) => {
      const c = h('article', { class: 'card role-card hoverable', style: { '--rc': d.color, cursor: canManage ? 'pointer' : 'default' }, tabindex: 0 },
        h('h3', null, d.name),
        h('div', { class: 'desc' }, d.description || h('span', { class: 'muted' }, 'Keine Beschreibung')),
        h('div', { class: 'meta' }, h('span', null, `${d.memberCount} Mitglied${d.memberCount === 1 ? '' : 'er'}`), h('span', null, `${d.rankCount} Rang${d.rankCount === 1 ? '' : 'e'}`)));
      if (canManage) { c.addEventListener('click', () => deptEditor(d)); c.addEventListener('keydown', (e) => { if (e.key === 'Enter') deptEditor(d); }); }
      return c;
    }));
  }

  function deptEditor(dept) {
    const err = h('div');
    const name = input({ value: dept?.name ?? '', maxLength: 60 });
    const desc = input({ value: dept?.description ?? '', maxLength: 200 });
    const col = colorPicker(dept?.color ?? '#4f8cff');
    const footer = [];
    if (dept) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      const r = await confirmDialog({ title: 'Abteilung löschen?', message: `„${dept.name}“ wird gelöscht.${dept.memberCount ? ` Sie hat noch ${dept.memberCount} Mitglied(er) und kann nicht gelöscht werden.` : ''}`, confirmLabel: 'Löschen' });
      if (!r) return;
      try { await api.del(`/api/departments/${dept.id}`); m.close(); toast('Abteilung gelöscht.'); reload(); } catch (e) { toast(e.message, 'err'); }
    } }));
    footer.push(h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }),
      button(dept ? 'Speichern' : 'Erstellen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        const payload = { name: name.value, description: desc.value, color: col.get() };
        try {
          if (dept) await api.patch(`/api/departments/${dept.id}`, payload); else await api.post('/api/departments', payload);
          m.close(); toast(dept ? 'Abteilung gespeichert.' : 'Abteilung erstellt.'); reload();
        } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) }));
    const m = openModal({ title: dept ? `Abteilung: ${dept.name}` : 'Neue Abteilung',
      body: h('div', null, err, field('Name', name), field('Beschreibung', desc), field('Farbe', col.el)), footer });
  }

  ctx.live(['org'], reload);
  show('hierarchy');
}
