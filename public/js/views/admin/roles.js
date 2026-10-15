import { h, mount } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, busy, card, field, input, checkbox, formError, openModal, confirmDialog, toast, skeletons, empty, badge, note } from '../../ui/kit.js';
import { api } from '../../api.js';
import { can, state } from '../../state.js';

const MODULE_LABELS = { system: 'System', users: 'Benutzer', roles: 'Rollen', audit: 'Audit-Log', org: 'Organisation', chat: 'Chat', market: 'Börse', partners: 'Externe Zugänge', lookups: 'Kategorien', permissions: 'Eigene Rechte', vehicles: 'Fahrzeuge', warehouse: 'Lager', finance: 'Finanzen', tab: 'Deckel', credit: 'Kredit', map: 'Karte', legal: 'Legal' };
const COLORS = ['#f5a524', '#4f8cff', '#22c4a8', '#a78bfa', '#f472b6', '#f87171', '#84cc16', '#94a3b8'];

/** Eigene Rechte anlegen/löschen (Systemrechte aus dem Code bleiben unverändert). */
async function customPermissions() {
  const body = h('div');
  const err = h('div');
  const m = openModal({ title: 'Eigene Rechte', wide: true, body: h('div', null, err, body), footer: [button('Schließen', { onClick: () => m.close() })] });
  async function draw() {
    let { permissions } = await api.get('/api/permissions');
    const custom = permissions.filter((p) => p.is_custom);
    const key = input({ placeholder: 'z. B. legal.view', maxLength: 80 });
    const desc = input({ placeholder: 'Beschreibung', maxLength: 200 });
    mount(body, note('Eigene Rechte lassen sich Rollen, Rängen und Benutzern zuweisen. Schlüssel: Kleinbuchstaben, mit Punkten gegliedert (modul.aktion).', 'info'), h('div', { style: { height: '14px' } }),
      h('div', { class: 'form-row' }, field('Schlüssel', key), field('Beschreibung', desc)),
      button('Recht anlegen', { variant: 'primary', icon: 'plus', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        try { await api.post('/api/permissions', { key: key.value.trim(), description: desc.value.trim() }); toast('Recht angelegt.'); draw(); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) }),
      h('div', { class: 'sep' }),
      custom.length ? custom.map((p) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', { class: 't mono' }, p.key), h('div', { class: 's' }, p.description || '–')),
        button('', { size: 'sm', variant: 'danger', icon: 'trash', title: 'Löschen', onClick: async () => {
          const r = await confirmDialog({ title: 'Recht löschen?', message: `„${p.key}“ wird aus allen Rollen, Rängen und Benutzern entfernt.`, confirmLabel: 'Löschen' });
          if (!r) return;
          try { await api.del(`/api/permissions/${encodeURIComponent(p.key)}`); toast('Gelöscht.'); draw(); } catch (ex) { toast(ex.message, 'err'); }
        } })))
        : h('div', { class: 'muted' }, 'Noch keine eigenen Rechte angelegt.'));
  }
  draw().catch((e) => err.replaceChildren(formError(e.message)));
}

export default async function render(container, ctx) {
  ctx.setActions(can('permissions.manage') && button('Eigene Rechte', { icon: 'key', onClick: () => customPermissions() }),
    can('roles.manage') && button('Rolle erstellen', { variant: 'primary', icon: 'plus', onClick: () => editor(null) }));
  mount(container, skeletons(3, 150));
  const { permissions } = await api.get('/api/permissions');

  async function load() {
    const { roles } = await api.get('/api/roles');
    if (!ctx.isCurrent()) return;
    if (!roles.length) return mount(container, card(null, empty('Noch keine Rollen', 'Erstelle die erste Rolle und weise ihr Rechte zu.', 'shield')));
    mount(container, h('div', { class: 'role-grid' }, roles.map((r) => {
      const c = h('article', { class: 'card role-card hoverable', style: { '--rc': r.color, cursor: 'pointer' }, tabindex: 0, role: 'button' },
        h('h3', null, r.name, r.isSystem && badge('System', 'b-info', false)),
        h('div', { class: 'desc' }, r.description || h('span', { class: 'muted' }, 'Keine Beschreibung')),
        h('div', { class: 'meta' },
          h('span', null, icon('users', ''), ' ', `${r.memberCount} Mitglied${r.memberCount === 1 ? '' : 'er'}`),
          h('span', null, r.isAdmin ? 'Alle Rechte' : `${r.permissions.length} Rechte`)));
      c.querySelector('.meta span svg')?.setAttribute('style', 'width:14px;height:14px;vertical-align:-2px');
      c.addEventListener('click', () => editor(r));
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter') editor(r); });
      return c;
    })));
  }

  function editor(role) {
    const readOnly = !can('roles.manage') || (role?.isAdmin && !state.user.isAdmin);
    const err = h('div');
    const name = input({ value: role?.name ?? '', maxLength: 40, disabled: readOnly });
    const desc = input({ value: role?.description ?? '', maxLength: 200, disabled: readOnly });
    let color = role?.color ?? COLORS[1];
    const swatches = h('div', { class: 'swatches' });
    const paintSwatches = () => mount(swatches, COLORS.map((c) => h('button', { type: 'button', class: `swatch ${c === color ? 'on' : ''}`, style: { '--s': c }, 'aria-label': c, disabled: readOnly,
      onclick: () => { color = c; paintSwatches(); } })));
    paintSwatches();

    const have = new Set(role?.permissions ?? []);
    const boxes = [];
    const groups = {};
    for (const p of permissions) {
      const mine = state.user.isAdmin || state.user.permissions.includes(p.key) || have.has(p.key);
      const c = checkbox(h('code', null, p.key), role?.isAdmin || have.has(p.key), { desc: p.description, locked: readOnly || role?.isAdmin || !mine });
      boxes.push([p, c]);
      (groups[p.module] ??= []).push([p, c]);
    }
    const permUI = Object.entries(groups).map(([m, items]) => {
      const toggleAll = !readOnly && !role?.isAdmin && button('Alle', { size: 'sm', variant: 'ghost', onClick: () => {
        const free = items.filter(([, c]) => !c.input.disabled);
        const on = free.some(([, c]) => !c.input.checked);
        free.forEach(([, c]) => (c.input.checked = on));
      } });
      return h('div', { class: 'perm-group' }, h('h4', null, MODULE_LABELS[m] ?? m, toggleAll), h('div', { class: 'perm-grid' }, items.map(([, c]) => c)));
    });

    const body = h('div', null, err,
      role?.isAdmin && note('Administrator-Rollen besitzen immer alle Rechte, auch künftig hinzukommende. Die Rechte sind daher nicht einzeln einstellbar.', 'shield'),
      role?.isAdmin && h('div', { style: { height: '14px' } }),
      h('div', { class: 'form-row' }, field('Name', name), field('Beschreibung', desc)),
      field('Farbe', swatches),
      h('div', { class: 'sep' }), h('div', { class: 'label', style: { marginBottom: '10px' } }, 'Berechtigungen'), permUI);

    const footer = [];
    if (role && !role.isSystem && can('roles.manage')) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      const r = await confirmDialog({ title: 'Rolle löschen?', message: `„${role.name}“ wird gelöscht.${role.memberCount ? ` Sie ist noch ${role.memberCount} Benutzer(n) zugewiesen und kann nicht gelöscht werden.` : ''}`, confirmLabel: 'Löschen' });
      if (!r) return;
      try { await api.del(`/api/roles/${role.id}`); m.close(); toast('Rolle gelöscht.'); load(); } catch (e) { toast(e.message, 'err'); }
    } }));
    footer.push(h('span', { class: 'grow' }), button(readOnly ? 'Schließen' : 'Abbrechen', { onClick: () => m.close() }));
    if (!readOnly) footer.push(button(role ? 'Speichern' : 'Erstellen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      const payload = { name: name.value, description: desc.value, color };
      if (!role?.isAdmin) payload.permissions = boxes.filter(([, c]) => c.input.checked).map(([p]) => p.key);
      try {
        if (role) await api.patch(`/api/roles/${role.id}`, payload); else await api.post('/api/roles', payload);
        m.close(); toast(role ? 'Rolle gespeichert.' : 'Rolle erstellt.'); load();
      } catch (ex) { err.replaceChildren(formError(ex.message)); body.parentElement.scrollTop = 0; }
    }) }));
    const m = openModal({ title: role ? `Rolle: ${role.name}` : 'Neue Rolle', wide: true, body, footer });
  }

  ctx.live(['roles', 'org', 'system'], async () => { ({ permissions } = await api.get('/api/permissions')); await load(); });
  await load();
}
