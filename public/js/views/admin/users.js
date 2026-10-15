import { h, mount, fmtDateTime, timeAgo, debounce } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import {
  button, busy, table, tabs, avatar, userAvatar, statusBadge, roleChip, memberNo, rankBadge, deptBadge, field, input, select, checkbox, formError,
  openModal, confirmDialog, toast, skeletons, empty, note, badge,
} from '../../ui/kit.js';
import { api } from '../../api.js';
import { can, state } from '../../state.js';
import { prepareAvatar } from '../account.js';
import { phoneInput, readFile, filePicker } from './partners.js';
import { extraFilesBox, extraFilesPicker } from './extra-files.js';

/** Dokumente der Personalakte: Schlüssel, Beschriftung, Pflicht (Pflicht gilt nur für Lieferanten – bei Mitgliedern sind alle freiwillig) */
const PERS_DOCS = [['id', 'Ausweis'], ['license', 'Führerschein'], ['weapon', 'Waffenschein'], ['clearance', 'Führungszeugnis (optional)']];
/** Persönliche Angaben eines Mitglieds: Vorname, Nachname, Straße, Postal Code, Telefonnummer, UMail (Endung fest), Kontonummer */
function personFields(a = {}, disabled = false) {
  const first = input({ value: a.firstName ?? '', maxLength: 40, disabled, autocomplete: 'off' }), last = input({ value: a.lastName ?? '', maxLength: 40, disabled, autocomplete: 'off' });
  const street = input({ value: a.street ?? '', maxLength: 80, disabled, autocomplete: 'off' }), postal = input({ value: a.postalCode ?? '', maxLength: 12, disabled, placeholder: 'z. B. 1234', autocomplete: 'off' });
  const phone = phoneInput(a.phone); phone.disabled = disabled;
  const umail = input({ value: a.umailLocal ?? '', maxLength: 40, disabled, placeholder: 'name', autocomplete: 'off' });
  umail.addEventListener('input', () => { umail.value = umail.value.toLowerCase().replace(/@.*$/, '').replace(/[^a-z0-9._-]/g, ''); });
  const account = input({ value: a.accountNumber ?? '', maxLength: 20, disabled, placeholder: 'z. B. LS28180705', autocomplete: 'off' });
  account.addEventListener('input', () => { account.value = account.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''); });
  return {
    el: h('div', null, h('div', { class: 'form-row' }, field('Vorname', first), field('Nachname', last)), h('div', { class: 'form-row' }, field('Street / Straße', street), field('Postal Code', postal)),
      h('div', { class: 'form-row' }, field('Telefonnummer', phone), field('Kontonummer', account)),
      field('UMail', h('div', { class: 'input-group' }, umail, h('span', { class: 'addon' }, '@umail.com')), { help: 'RP-interne Mail – die Endung ist fest.' })),
    values: () => ({ firstName: first.value.trim(), lastName: last.value.trim(), street: street.value.trim(), postalCode: postal.value.trim(), phone: phone.value.trim(), umail: umail.value.trim(), accountNumber: account.value.trim() }),
  };
}

let permCatalog = null;
const loadCatalog = async () => (permCatalog ??= (await api.get('/api/permissions')).permissions);

export default async function render(container, ctx) {
  const f = { status: 'all', q: '' };
  const [{ roles }, org] = await Promise.all([api.get('/api/roles'), api.get('/api/org'), loadCatalog().catch(() => [])]);
  const tabsHost = h('div');
  const listHost = h('div');
  const search = h('input', { class: 'input', placeholder: 'Benutzer suchen …', 'aria-label': 'Suche' });
  mount(container, h('div', { class: 'toolbar' }, tabsHost, h('div', { class: 'grow' }), h('div', { class: 'input-icon' }, icon('search'), search)), listHost);

  if (can('users.create')) ctx.setActions(button('Benutzer anlegen', { variant: 'primary', icon: 'userPlus', onClick: () => editor(null) }));

  async function load(silent = false) {
    if (!silent) mount(listHost, skeletons(5, 56));
    const p = new URLSearchParams();
    if (f.status !== 'all') p.set('status', f.status);
    if (f.q) p.set('q', f.q);
    const [{ users }, { counts }] = await Promise.all([api.get('/api/users?' + p), api.get('/api/users')]);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    mount(tabsHost, tabs([
      { id: 'all', label: 'Alle', count: total }, { id: 'pending', label: 'Ausstehend', count: counts.pending ?? 0 },
      { id: 'active', label: 'Aktiv', count: counts.active ?? 0 }, { id: 'blocked', label: 'Gesperrt', count: counts.blocked ?? 0 },
      { id: 'rejected', label: 'Abgelehnt', count: counts.rejected ?? 0 },
    ], f.status, (id) => { f.status = id; load(); }));
    ctx.refreshCounters?.();
    mount(listHost, table([
      { label: 'Nr.', style: { width: '1%' }, render: (u) => memberNo(u.memberNumber) },
      { label: 'Benutzer', render: (u) => h('div', { class: 'cell-user' }, userAvatar(u), h('div', null, h('div', { class: 'nm' }, u.displayName, u.isSuperadmin && h('span', { class: 'badge no-dot b-warn', style: { marginLeft: '6px' } }, 'Superadmin')), h('div', { class: 'sub' }, u.username ? '@' + u.username : (u.isSelf ? 'Du' : 'Name geschützt')))) },
      { label: 'Rang / Abteilung', render: (u) => (u.rank || u.department ? h('div', { class: 'chips' }, rankBadge(u.rank), deptBadge(u.department)) : h('span', { class: 'muted' }, '–')) },
      { label: 'Status', render: (u) => statusBadge(u.status) },
      { label: 'Rollen', render: (u) => (u.roles.length ? h('div', { class: 'chips' }, u.roles.map(roleChip)) : h('span', { class: 'muted' }, '–')) },
      { label: 'Letzte Anmeldung', render: (u) => h('span', { class: 'muted', title: fmtDateTime(u.lastLoginAt) }, u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'nie') },
      { label: '', style: { width: '1%' }, render: (u) => h('div', { class: 'actions' }, rowActions(u)) },
    ], users, { onRowClick: (u) => editor(u.id), empty: empty('Keine Benutzer gefunden', 'Passe Filter oder Suche an.', 'users') }));
  }

  function rowActions(u) {
    const out = [];
    const me = u.id === state.user.id;
    if (can('users.approve') && !me) {
      if (u.status === 'pending') {
        out.push(button('Freischalten', { size: 'sm', variant: 'ok', icon: 'check', onClick: (e) => approve(u, e.currentTarget) }));
        out.push(button('Ablehnen', { size: 'sm', variant: 'danger', icon: 'x', onClick: () => setStatus(u, 'rejected', { title: 'Zugang ablehnen?', msg: `${u.displayName} erhält keinen Zugriff.`, label: 'Ablehnen', reason: true }) }));
      } else if (u.status === 'active') out.push(button('Sperren', { size: 'sm', variant: 'danger', icon: 'lock', onClick: () => setStatus(u, 'blocked', { title: 'Benutzer sperren?', msg: `${u.displayName} wird sofort abgemeldet und kann sich nicht mehr anmelden.`, label: 'Sperren', reason: true }) }));
      else out.push(button('Freischalten', { size: 'sm', variant: 'ok', icon: u.status === 'blocked' ? 'unlock' : 'check', onClick: (e) => approve(u, e.currentTarget) }));
    }
    return out;
  }

  async function setStatus(u, status, c) {
    const r = await confirmDialog({ title: c.title, message: c.msg, confirmLabel: c.label, withReason: c.reason });
    if (!r) return;
    try { await api.post(`/api/users/${u.id}/status`, { status, reason: r.reason }); toast(`${u.displayName}: ${c.label.toLowerCase()} ✓`); await load(); } catch (e) { toast(e.message, 'err'); }
  }

  /** Freischalten mit Rollenauswahl (neue Benutzer haben noch keine Rolle). */
  function approve(u) {
    if (u.status !== 'pending' || u.roles.length) return quickActivate(u);
    const checks = roles.filter((r) => !r.isAdmin || state.user.isAdmin).map((r) => [r, checkbox(h('span', null, roleChip(r)), false, { desc: r.description })]);
    const m = openModal({
      title: `${u.displayName} freischalten`,
      body: h('div', { class: 'stack' }, h('p', { style: { color: 'var(--text-2)' } }, 'Wähle optional Rollen aus, die der Benutzer mit der Freischaltung erhält. Ohne Rolle sieht er nur das Dashboard.'),
        roles.length ? checks.map(([, c]) => c) : note('Es existieren noch keine Rollen. Du kannst sie im Bereich „Rollen & Rechte“ anlegen.')),
      footer: [button('Abbrechen', { onClick: () => m.close() }),
        button('Freischalten', { variant: 'ok', icon: 'check', onClick: async (e) => busy(e.currentTarget, async () => {
          try {
            await api.post(`/api/users/${u.id}/status`, { status: 'active', roleIds: checks.filter(([, c]) => c.input.checked).map(([r]) => r.id) });
            m.close(); toast(`${u.displayName} wurde freigeschaltet.`); await load();
          } catch (ex) { toast(ex.message, 'err'); }
        }) })],
    });
  }
  async function quickActivate(u) {
    try { await api.post(`/api/users/${u.id}/status`, { status: 'active' }); toast(`${u.displayName} wurde freigeschaltet.`); await load(); } catch (e) { toast(e.message, 'err'); }
  }

  /** Dialog zum Anlegen (id = null) bzw. Bearbeiten. */
  async function editor(id) {
    let user = null;
    if (id) { try { user = (await api.get(`/api/users/${id}`)).user; } catch (e) { return toast(e.message, 'err'); } }
    const err = h('div');
    const dn = input({ value: user?.displayName ?? '', maxLength: 60, disabled: !!user && !can('users.edit') });
    const un = input({ value: user?.username ?? '', maxLength: 32, disabled: !!user, autocomplete: 'off' });
    const pw = input({ type: 'password', autocomplete: 'new-password', placeholder: 'Mindestens 8 Zeichen' });
    const editable = !user || can('users.edit');
    const rankSel = select([{ value: '', label: '— kein Rang —' }, ...org.ranks.map((r) => ({ value: r.id, label: r.name }))], user?.rank?.id ?? '', { disabled: !editable });
    const deptSel = select([{ value: '', label: '— keine Abteilung —' }, ...org.departments.map((d) => ({ value: d.id, label: d.name }))], user?.department?.id ?? '', { disabled: !editable });
    let supSel = null;
    if (user) {
      let candidates = [];
      try { candidates = (await api.get('/api/users?status=active')).users.filter((x) => x.id !== user.id); } catch { /* ohne Auswahl */ }
      supSel = select([{ value: '', label: '— kein Vorgesetzter —' }, ...candidates.map((x) => ({ value: x.id, label: `${x.displayName}${x.memberNumber ? ' (' + x.memberNumber + ')' : ''}` }))], user.supervisor?.id ?? '', { disabled: !editable });
    }
    const idOrNull = (el) => (el.value ? Number(el.value) : null);
    const roleBoxes = roles.map((r) => [r, checkbox(roleChip(r), user?.roles.some((x) => x.id === r.id), { desc: r.description, locked: !can('users.edit') && !!user })]);
    const directSet = new Set(user?.directPermissions ?? []);
    const permBoxes = (permCatalog ?? []).map((p) => [p, checkbox(h('code', null, p.key), directSet.has(p.key), { desc: p.description, locked: !can('users.edit') })]);
    const groups = {};
    for (const [p, c] of permBoxes) (groups[p.module] ??= []).push(c);

    const roleBody = h('div', null, roles.length ? roleBoxes.map(([, c]) => c) : note('Noch keine Rollen vorhanden.'));
    const permBody = h('div', null, note('Direkte Rechte gelten zusätzlich zu den Rollen. Nutze sie sparsam – Rollen sind übersichtlicher.'), h('div', { style: { height: '12px' } }),
      Object.entries(groups).map(([m, boxes]) => h('div', { class: 'perm-group' }, h('h4', null, m), h('div', { class: 'perm-grid' }, boxes))));
    const effBody = h('div', null, user?.isSuperadmin ? note('Superadmin – uneingeschränkter Zugriff, inklusive endgültigem Löschen aller Daten.', 'shield') : user?.isAdmin && note('Administrator – dieser Benutzer besitzt automatisch alle Rechte.', 'shield'), h('div', { class: 'chips', style: { marginTop: '10px' } },
      (user?.effectivePermissions ?? []).map((k) => h('span', { class: 'badge no-dot b-info mono' }, k))));

    const avatarFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
    avatarFile.addEventListener('change', async () => {
      const fl = avatarFile.files[0]; if (!fl) return;
      try { const data = await prepareAvatar(fl); await api.post(`/api/users/${user.id}/avatar`, { data }); toast('Profilbild gespeichert.'); m.close(); load(true); }
      catch (e) { toast(e.message || 'Das Bild konnte nicht verarbeitet werden.', 'err'); }
      avatarFile.value = '';
    });
    const noInput = state.user.isSuperadmin ? input({ value: user?.memberNumber ?? '', maxLength: 20, placeholder: user ? 'Personalnummer' : 'leer = automatisch die nächste Nummer', autocomplete: 'off' }) : null;
    if (noInput) noInput.addEventListener('input', () => { noInput.value = noInput.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''); });
    const personNew = !user && can('users.personnel_edit') ? personFields() : null;
    const extras = personNew ? extraFilesPicker() : null;
    const docPickers = personNew ? Object.fromEntries(PERS_DOCS.map(([k, label]) => [k, filePicker(`${label.replace(' (optional)', '')} hochladen`)])) : null;
    const general = h('div', null, err,
      user && h('div', { class: 'member-card' }, userAvatar(user, 'lg'),
        h('div', { class: 'grow' }, h('div', { class: 'mc-name' }, user.displayName), h('div', { class: 'mc-sub' }, user.username ? `@${user.username}` : (user.memberNumber ? 'Personalnummer' : '')),
          h('div', { class: 'mc-meta' }, statusBadge(user.status), rankBadge(user.rank), deptBadge(user.department))),
        memberNo(user.memberNumber, true)),
      user && !user.isSelf && (can('users.avatar_edit') || (user.avatarUrl && can('users.avatar_remove'))) && h('div', { class: 'row', style: { margin: '0 0 14px' } }, avatarFile,
        can('users.avatar_edit') && button(user.avatarUrl ? 'Profilbild ändern' : 'Profilbild hochladen', { size: 'sm', icon: 'download', onClick: () => avatarFile.click() }),
        user.avatarUrl && can('users.avatar_remove') && button('Profilbild entfernen', { size: 'sm', variant: 'danger', icon: 'trash', onClick: async () => {
          if (!await confirmDialog({ title: 'Profilbild entfernen?', message: 'Das Profilbild dieses Mitglieds wird gelöscht. Es kann ein neues hochladen.', confirmLabel: 'Entfernen' })) return;
          try { await api.del(`/api/users/${user.id}/avatar`); toast('Profilbild entfernt.'); m.close(); load(true); } catch (e) { toast(e.message, 'err'); }
        } })),
      (!user || user.isSelf) ? h('div', { class: 'form-row' }, field('Anzeigename', dn), field('Benutzername', un))
        : user.nameVisible ? note(`Du siehst den Namen, weil dieses Mitglied in der Hierarchie unter dir steht (oder du Superadmin bist): ${user.displayName}${user.username ? ' (@' + user.username + ')' : ''}.`, 'shield')
          : note('Namen von Mitgliedern auf gleicher oder höherer Ebene werden aus Datenschutzgründen nicht angezeigt – die Identifikation läuft über die Personalnummer.', 'shield'),
      noInput && field('Personalnummer', noInput, { help: 'Nur der Superadmin kann Personalnummern ändern oder vergeben (eindeutig, z. B. MDT-221).' }),
      h('div', { class: 'form-row' }, field('Rang', rankSel), field('Abteilung', deptSel)),
      supSel && field('Vorgesetzter', supSel, { help: 'Direkter Vorgesetzter dieses Mitglieds.' }),
      !user && field('Passwort', pw),
      !user && h('div', null, h('div', { class: 'sep' }), h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Persönliche Angaben (Personalakte)'),
        personNew ? [personNew.el, PERS_DOCS.map(([k, label]) => field(label, docPickers[k].el)), extras.el]
          : note('Vorname, Nachname, Straße, Postal Code, Telefonnummer, UMail, Kontonummer und die Dokumente (Ausweis, Führerschein, Waffenschein, Führungszeugnis) kannst du nur erfassen, wenn dir das Recht „users.personnel_edit“ zugewiesen ist (Rollen & Rechte → Rolle bearbeiten, oder beim Benutzer unter „Direkte Rechte“).', 'alert')),
      !user && h('div', { class: 'help' }, 'Der Benutzer wird sofort aktiv geschaltet und erhält automatisch die nächste Mitgliedsnummer.'),
      user && h('dl', { class: 'details-dl' },
        h('dt', null, 'Erstellt'), h('dd', null, fmtDateTime(user.createdAt)),
        h('dt', null, 'Letzte Anmeldung'), h('dd', null, user.lastLoginAt ? fmtDateTime(user.lastLoginAt) : 'nie'),
        user.statusReason && [h('dt', null, 'Begründung'), h('dd', null, user.statusReason)]));

    const showPersonnel = !!user; // Tab immer sichtbar; ohne Recht erklärt er, welches Recht fehlt
    const personnelBody = h('div'), changelogBody = h('div');
    const panes = { general, roles: roleBody, perms: permBody, eff: effBody, personnel: personnelBody, changelog: changelogBody };
    let changelogLoaded = false;
    async function loadChangelog() {
      mount(changelogBody, skeletons(2, 60));
      let cl, bd;
      try { [cl, bd] = await Promise.all([api.get(`/api/users/${user.id}/changelog`), api.get(`/api/users/${user.id}/board`).catch(() => null)]); } catch (e) { mount(changelogBody, note(e.message, 'alert')); changelogLoaded = false; return; }
      const block = (title, d, noun) => h('div', { style: { marginBottom: '20px' } },
        h('div', { class: 'label', style: { marginBottom: '8px', fontSize: '13px' } }, title),
        h('div', { class: 'row', style: { gap: '10px', marginBottom: '10px' } }, d.open.length ? badge(`${d.open.length} unbestätigt`, 'b-warn', false) : badge('Alles bestätigt', 'b-ok', false), h('span', { class: 'muted' }, d.lastAckAt ? `Zuletzt bestätigt: ${fmtDateTime(d.lastAckAt)}` : `Noch nie ${noun} bestätigt`)),
        d.open.length > 0 && h('div', { style: { marginBottom: '10px' } }, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Noch nicht bestätigt'), d.open.map((e) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, e.version && h('span', { class: 'cl-ver' }, e.version), ' ', e.title), e.changed && badge('Geändert', 'b-warn', false)))),
        h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Verlauf der Bestätigungen'),
        d.history.length ? d.history.map((x) => h('div', { class: 'list-row' }, h('div', { class: 'dot-icon' }, icon('check')), h('div', { class: 'grow' }, h('div', { class: 't', style: { whiteSpace: 'normal' } }, x.version && h('span', { class: 'cl-ver' }, `${x.version} `), x.title), h('div', { class: 's' }, `Bestätigt am ${fmtDateTime(x.ackedAt)}`)), x.changed && badge('Geändert', 'b-info', false)))
          : h('div', { class: 'muted' }, 'Noch keine Bestätigungen.'));
      mount(changelogBody, block('Changelog', cl, 'ein Update'), bd && block('Schwarzes Brett', bd, 'einen Aushang'));
    }
    const body = h('div');
    let personnelLoaded = false;
    const show = (k) => { mount(body, panes[k]); if (k === 'personnel' && !personnelLoaded) { personnelLoaded = true; loadPersonnel(); } if (k === 'changelog' && !changelogLoaded) { changelogLoaded = true; loadChangelog(); } };
    show('general');
    const tabBar = user ? tabs([{ id: 'general', label: 'Allgemein' }, { id: 'roles', label: 'Rollen' }, { id: 'perms', label: 'Direkte Rechte' }, { id: 'eff', label: 'Effektiv' }, showPersonnel && { id: 'personnel', label: 'Personalakte' }, can('users.view') && { id: 'changelog', label: 'Updates' }].filter(Boolean), 'general', show) : null;
    if (tabBar) tabBar.style.marginBottom = '16px';

    const footer = [];
    if (user && can('users.delete') && user.id !== state.user.id) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      const r = await confirmDialog({ title: 'Benutzer löschen?', message: `${user.displayName} wird endgültig gelöscht. Audit-Einträge bleiben erhalten.`, confirmLabel: 'Endgültig löschen' });
      if (!r) return;
      try { await api.del(`/api/users/${user.id}`); m.close(); toast('Benutzer gelöscht.'); load(); } catch (e) { toast(e.message, 'err'); }
    } }));
    if (user && can('users.password_reset')) footer.push(button('Passwort setzen', { icon: 'key', onClick: () => passwordDialog(user) }));
    footer.push(h('span', { class: 'grow' }));
    footer.push(button('Schließen', { onClick: () => m.close() }));
    if (!user || can('users.edit')) footer.push(button(user ? 'Speichern' : 'Anlegen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, save) }));

    /** Personalakte: Angaben + Dokumente (ansehen mit users.personnel_view, ändern mit users.personnel_edit) */
    async function loadPersonnel() {
      mount(personnelBody, skeletons(2, 60));
      let d; try { d = await api.get(`/api/users/${user.id}/personnel`); } catch (e) { mount(personnelBody, note(e.message, 'alert')); personnelLoaded = false; return; }
      const canEdit = d.canEdit; let pf = personFields(d.personnel, !canEdit);
      const docsEl = h('div');
      const drawDocs = (docs) => mount(docsEl, PERS_DOCS.map(([k, label]) => {
        const has = docs[k]; const f = h('input', { type: 'file', accept: 'application/pdf,image/png,image/jpeg,image/webp', hidden: true });
        f.addEventListener('change', async () => { if (!f.files[0]) return; try { const r = await api.post(`/api/users/${user.id}/docs/${k}`, { data: await readFile(f.files[0]) }); drawDocs(r.personnel.docs); toast('Dokument gespeichert.'); } catch (ex) { toast(ex.message, 'err'); } });
        return h('div', { class: 'row', style: { alignItems: 'center', marginBottom: '6px' } }, h('b', { style: { minWidth: '170px' } }, label), has ? h('span', { class: 'badge b-ok' }, 'liegt vor') : h('span', { class: 'badge b-mute' }, 'fehlt'),
          has && h('a', { class: 'btn btn-sm', href: `/api/users/${user.id}/docs/${k}`, target: '_blank', rel: 'noopener' }, icon('search'), 'Ansehen'), canEdit && f,
          canEdit && button(has ? 'Ersetzen' : 'Hochladen', { size: 'sm', icon: 'download', onClick: () => f.click() }),
          canEdit && has && button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Dokument entfernen', onClick: async () => { try { const r = await api.del(`/api/users/${user.id}/docs/${k}`); drawDocs(r.personnel.docs); } catch (ex) { toast(ex.message, 'err'); } } }));
      }));
      drawDocs(d.personnel.docs);
      mount(personnelBody, note('Die Personalakte sehen nur das Mitglied selbst und Berechtigte (users.personnel_view). Die Angaben erscheinen nirgends sonst im System.', 'shield'), h('div', { style: { height: '12px' } }), pf.el,
        canEdit && h('div', { style: { margin: '8px 0 14px' } }, button('Angaben speichern', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => { try { await api.put(`/api/users/${user.id}/personnel`, pf.values()); toast('Personalakte gespeichert.'); } catch (ex) { toast(ex.message, 'err'); } }) })),
        h('div', { class: 'sep' }), h('div', { class: 'label', style: { marginBottom: '8px' } }, 'Dokumente'), docsEl,
        h('div', { style: { height: '14px' } }), extraFilesBox({ type: 'user', id: user.id }));
    }

    async function save() {
      err.replaceChildren();
      try {
        if (!user) {
          const { user: made } = await api.post('/api/users', { displayName: dn.value, username: un.value, password: pw.value, memberNumber: noInput?.value.trim() || undefined, rankId: idOrNull(rankSel), departmentId: idOrNull(deptSel), roleIds: roleBoxes.filter(([, c]) => c.input.checked).map(([r]) => r.id) });
          if (personNew) { // Personalakte direkt mit anlegen (Benutzer existiert bereits – Fehler hier verhindern ihn nicht)
            try {
              const v = personNew.values();
              if (Object.values(v).some(Boolean)) await api.put(`/api/users/${made.id}/personnel`, v);
              for (const [k] of PERS_DOCS) { const f = docPickers[k].file(); if (f) await api.post(`/api/users/${made.id}/docs/${k}`, { data: await readFile(f) }); }
              const failed = extras.count() ? await extras.upload('user', made.id) : [];
              if (failed.length) throw new Error(`Diese Dateien konnten nicht gespeichert werden: ${failed.join(', ')}`);
            } catch (ex) { toast(`Benutzer angelegt – die Personalakte konnte nicht vollständig gespeichert werden: ${ex.message}`, 'warn'); load(); m.close(); return; }
          }
        } else {
          await api.patch(`/api/users/${user.id}`, {
            displayName: user.isSelf ? dn.value : undefined,
            rankId: idOrNull(rankSel), departmentId: idOrNull(deptSel), supervisorId: supSel ? idOrNull(supSel) : undefined,
            roleIds: roleBoxes.filter(([, c]) => c.input.checked).map(([r]) => r.id),
            permissions: permBoxes.filter(([, c]) => c.input.checked).map(([p]) => p.key),
            memberNumber: noInput && noInput.value.trim() && noInput.value.trim() !== user.memberNumber ? noInput.value.trim() : undefined,
          });
        }
        m.close(); toast(user ? 'Änderungen gespeichert.' : 'Benutzer angelegt.'); load();
      } catch (ex) { err.replaceChildren(formError(ex.message)); if (tabBar) show('general'); body.scrollTop = 0; }
    }
    const m = openModal({ title: user ? 'Benutzer bearbeiten' : 'Benutzer anlegen', wide: true, body: h('div', null, tabBar, body), footer });
    if (!user) {
      // Rollenauswahl direkt im Anlege-Dialog
      if (roles.length) panes.general.append(h('div', { class: 'sep' }), h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Rollen'), ...roleBoxes.map(([, c]) => c));
    }
  }

  function passwordDialog(user) {
    const pw = input({ type: 'password', autocomplete: 'new-password', placeholder: 'Neues Passwort (min. 8 Zeichen)' });
    const err = h('div');
    const m = openModal({
      title: `Passwort für ${user.displayName}`,
      body: h('div', null, err, field('Neues Passwort', pw, { help: 'Alle aktiven Sitzungen des Benutzers werden beendet.' })),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Setzen', { variant: 'primary', onClick: (e) => busy(e.currentTarget, async () => {
        try { await api.post(`/api/users/${user.id}/password`, { password: pw.value }); m.close(); toast('Passwort gesetzt.'); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })],
    });
  }

  search.addEventListener('input', debounce(() => { f.q = search.value.trim(); load(); }));
  ctx.live(['users', 'org', 'roles', 'profile'], () => load(true));
  await load();
}
