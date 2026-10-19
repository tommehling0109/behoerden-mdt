import { h, mount, fmtDateTime, timeAgo, debounce } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import {
  button, busy, table, tabs, avatar, userAvatar, statusBadge, roleChip, memberNo, rankBadge, deptBadge, field, input, select, checkbox, toggle, formError,
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

  const actions = () => h('div', { class: 'row' }, can('users.edit') && button('Person auf die Watchlist', { icon: 'eye', variant: 'danger', onClick: () => watchDialog() }), can('users.create') && button('Benutzer anlegen', { variant: 'primary', icon: 'userPlus', onClick: () => editor(null) }));
  if (can('users.create') || can('users.edit')) ctx.setActions(actions());

  let watch = { entries: [], canManage: false };
  async function load(silent = false) {
    if (!silent) mount(listHost, skeletons(5, 56));
    const p = new URLSearchParams();
    if (f.status !== 'all') p.set('status', f.status);
    if (f.q) p.set('q', f.q);
    const [{ users }, { counts }, wl] = await Promise.all([api.get('/api/users?' + p), api.get('/api/users'), api.get('/api/watchlist').catch(() => ({ entries: [], canManage: false }))]);
    watch = wl;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    mount(tabsHost, tabs([
      { id: 'all', label: 'Alle', count: total }, { id: 'pending', label: 'Ausstehend', count: counts.pending ?? 0 },
      { id: 'active', label: 'Aktiv', count: counts.active ?? 0 }, { id: 'blocked', label: 'Gesperrt', count: counts.blocked ?? 0 },
      { id: 'rejected', label: 'Abgelehnt', count: counts.rejected ?? 0 },
      ...(wl.entries.length || wl.canManage ? [{ id: 'watch', label: 'Watchlist', count: wl.entries.length || undefined }] : []),
    ], f.status, (id) => { f.status = id; load(); }));
    ctx.refreshCounters?.();
    if (f.status === 'watch') return watchView();
    mount(listHost, table([
      { label: 'Nr.', style: { width: '1%' }, render: (u) => memberNo(u.memberNumber) },
      { label: 'Benutzer', render: (u) => h('div', { class: 'cell-user' }, userAvatar(u), h('div', null, h('div', { class: 'nm' }, u.displayName, u.watch && h('span', { class: 'badge no-dot b-err', style: { marginLeft: '6px' }, title: `Watchlist: ${u.watch.reason}` }, 'Watchlist'), u.isSuperadmin && h('span', { class: 'badge no-dot b-warn', style: { marginLeft: '6px' } }, 'Superadmin')), h('div', { class: 'sub' }, u.username ? '@' + u.username : (u.isSelf ? 'Du' : 'Name geschützt')))) },
      { label: 'Rang / Abteilung', render: (u) => (u.rank || u.department ? h('div', { class: 'chips' }, rankBadge(u.rank), deptBadge(u.department)) : h('span', { class: 'muted' }, '–')) },
      { label: 'Status', render: (u) => statusBadge(u.status) },
      { label: 'Rollen', render: (u) => (u.roles.length ? h('div', { class: 'chips' }, u.roles.map(roleChip)) : h('span', { class: 'muted' }, '–')) },
      { label: 'Letzte Anmeldung', render: (u) => h('span', { class: 'muted', title: fmtDateTime(u.lastLoginAt) }, u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'nie') },
      { label: '', style: { width: '1%' }, render: (u) => h('div', { class: 'actions' }, rowActions(u)) },
    ], users, { onRowClick: (u) => editor(u.id), empty: empty('Keine Benutzer gefunden', 'Passe Filter oder Suche an.', 'users') }));
  }

  // ── Watchlist ──
  function watchView() {
    const rows = watch.entries;
    mount(listHost,
      h('div', { class: 'watch-alert', style: { marginBottom: 0 } }, icon('alert'), h('div', null, 'Beobachtete Personen – vertraulich. Sichtbar nur für die Führung, die beauftragten Beobachter und wer den Eintrag angelegt hat; die Person selbst sieht nichts davon. Beobachter erfahren, wenn die Person sich anmeldet oder (gesperrt) es versucht.')),
      h('div', { style: { height: '12px' } }),
      table([
        { label: 'Nr.', style: { width: '1%' }, render: (e) => h('span', { class: 'member-no watch-no' }, e.memberNumber ?? e.label) },
        { label: 'Status', render: (e) => (e.status ? statusBadge(e.status) : h('span', { class: 'muted' }, '–')) },
        { label: 'Rang', render: (e) => (e.rank ? rankBadge(e.rank) : h('span', { class: 'muted' }, '–')) },
        { label: 'Grund', render: (e) => h('div', { class: 'watch-reason' }, e.reason) },
        { label: 'Beobachter', render: (e) => (e.observers.length ? h('div', { class: 'chips' }, e.observers.map((o) => h('span', { class: 'badge no-dot' }, o.label))) : h('span', { class: 'muted' }, 'nur Führung')) },
        { label: 'Eingetragen', render: (e) => h('div', null, h('span', { class: 'muted', title: fmtDateTime(e.addedAt) }, timeAgo(e.addedAt)), e.addedBy && h('div', { class: 'muted', style: { fontSize: '12px' } }, e.addedBy)) },
        { label: '', style: { width: '1%' }, render: (e) => (e.canEdit ? h('div', { class: 'actions' }, button('Bearbeiten', { size: 'sm', icon: 'edit', onClick: (ev) => { ev.stopPropagation(); watchDialog({ edit: e.userId }); } }), button('Entfernen', { size: 'sm', variant: 'ghost', icon: 'trash', onClick: (ev) => { ev.stopPropagation(); removeWatch(e); } })) : null) },
      ], rows, { onRowClick: (e) => editor(e.userId), empty: empty('Niemand auf der Watchlist', watch.canManage ? 'Setze Personen über „Person auf die Watchlist“ oder im Profil auf die Liste.' : 'Für dich ist kein Eintrag sichtbar.', 'eye') }));
  }
  async function removeWatch(e) {
    if (!await confirmDialog({ title: 'Von der Watchlist nehmen?', message: `${e.label} wird nicht mehr beobachtet. Der Eintrag samt Grund wird gelöscht (das Audit-Log behält die Aktion).`, confirmLabel: 'Entfernen' })) return;
    try { await api.del(`/api/watchlist/${e.userId}`); toast('Von der Watchlist genommen.'); load(true); } catch (ex) { toast(ex.message, 'err'); }
  }
  /** Person auf die Watchlist setzen (userId bekannt oder aus der Liste wählen) bzw. einen Eintrag bearbeiten (edit). */
  async function watchDialog({ userId = null, edit = null } = {}) {
    let opts, cur = edit ? watch.entries.find((x) => x.userId === edit) : null;
    try { opts = await api.get('/api/watchlist/options'); } catch (e) { return toast(e.message, 'err'); }
    if (edit && !cur) { try { cur = (await api.get('/api/watchlist')).entries.find((x) => x.userId === edit); } catch { /* egal */ } }
    const err = h('div'), q = input({ type: 'search', placeholder: 'Dienstnummer suchen …' });
    const pick = select([{ value: '', label: '— Person wählen —' }, ...opts.candidates.map((c) => ({ value: c.id, label: `${c.label} (${{ active: 'aktiv', blocked: 'gesperrt', pending: 'ausstehend', rejected: 'abgelehnt' }[c.status] ?? c.status})` }))], userId ?? '');
    q.addEventListener('input', () => { const f = q.value.trim().toLowerCase(); for (const o of pick.options) o.hidden = !!f && !!o.value && !o.textContent.toLowerCase().includes(f); });
    const reason = h('textarea', { class: 'textarea', rows: 4, maxLength: 600, placeholder: 'Warum wird die Person beobachtet? (z. B. Ex-Mitglied, Verdacht auf Weitergabe von Informationen …)' }, cur?.reason ?? '');
    const sel = new Set((cur?.observers ?? []).map((o) => o.id)), box = h('div', { class: 'sch-pick' });
    const drawObs = () => mount(box, opts.members.filter((mm) => mm.id !== Number(pick.value)).map((mm) => { const cb = checkbox(mm.label, sel.has(mm.id)); cb.input.addEventListener('change', () => { cb.input.checked ? sel.add(mm.id) : sel.delete(mm.id); }); return cb; }));
    pick.addEventListener('change', drawObs); drawObs();
    const save = button(edit ? 'Speichern' : 'Auf die Watchlist setzen', { variant: 'danger', icon: 'check', onClick: () => busy(save, async () => {
      err.replaceChildren();
      try {
        if (edit) await api.patch(`/api/watchlist/${edit}`, { reason: reason.value, observers: [...sel] });
        else { if (!pick.value) throw new Error('Bitte eine Person auswählen.'); await api.post('/api/watchlist', { userId: Number(pick.value), reason: reason.value, observers: [...sel] }); }
        m.close(); toast(edit ? 'Watchlist-Eintrag gespeichert.' : 'Auf die Watchlist gesetzt.'); load(true);
      } catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) });
    const m = openModal({ title: edit ? `Watchlist: ${cur?.label ?? ''}` : 'Person auf die Watchlist setzen', wide: true,
      body: h('div', { class: 'stack' }, err, note('Beobachtete Personen sind nur für die Führung, die gewählten Beobachter und dich sichtbar – die Person selbst erfährt nichts davon.', 'alert'),
        !edit && !userId && field('Person', h('div', null, q, pick)), !edit && userId && field('Person', pick), field('Grund *', reason), field('Beauftragte Beobachter', box, { help: 'Diese Mitglieder sehen den Eintrag und bekommen Hinweise, wenn die Person sich anmeldet. Die Führung sieht ihn immer.' })),
      footer: [button('Abbrechen', { onClick: () => m.close() }), save] });
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
    const deptSel = select([{ value: '', label: '— keine Behörde —' }, ...org.departments.map((d) => ({ value: d.id, label: d.name }))], user?.department?.id ?? '', { disabled: !editable });
    // Ränge gehören zu einer Behörde: die Auswahl zeigt nur Ränge der gewählten Behörde (plus behördenlose Ränge)
    const rankSel = select([], '', { disabled: !editable });
    const fillRanks = (keep) => { const dep = Number(deptSel.value) || null; rankSel.replaceChildren(...[{ value: '', label: '— kein Rang —' }, ...org.ranks.filter((r) => !dep || r.departmentId == null || r.departmentId === dep).map((r) => ({ value: r.id, label: r.name }))].map((o) => h('option', { value: o.value, selected: String(o.value) === String(keep ?? '') }, o.label))); };
    fillRanks(user?.rank?.id); deptSel.addEventListener('change', () => fillRanks(''));
    // Zusätzliche Behörden-Freigaben (z. B. Verbindungsbeamte): nur mit dem Recht „Alle Behörden“
    const mayExtra = !!user && (state.user.isSuperadmin || state.user.isAdmin || can('departments.all'));
    const extraBoxes = mayExtra ? org.departments.map((d) => [d, toggle(d.name, (user.extraDepartments ?? []).some((x) => x.id === d.id))]) : null;
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
    const noInput = (state.user.isSuperadmin || can('users.badge')) ? input({ value: user?.memberNumber ?? '', maxLength: 20, placeholder: user ? 'Dienstnummer' : 'leer = automatisch die nächste Nummer', autocomplete: 'off' }) : null;
    if (noInput) noInput.addEventListener('input', () => { noInput.value = noInput.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''); });
    const personNew = !user && can('users.personnel_edit') ? personFields() : null;
    const extras = personNew ? extraFilesPicker() : null;
    const docPickers = personNew ? Object.fromEntries(PERS_DOCS.map(([k, label]) => [k, filePicker(`${label.replace(' (optional)', '')} hochladen`)])) : null;
    const general = h('div', null, err,
      user?.watch && h('div', { class: 'watch-alert' }, icon('alert'), h('div', { class: 'grow' }, h('div', { class: 'wa-title' }, 'Auf der Watchlist – wird gesondert beobachtet'), h('div', { class: 'wa-text' }, user.watch.reason), h('div', { class: 'wa-sub' }, `${user.watch.observers} beauftragte(r) Beobachter · vertraulich, die Person selbst sieht das nicht`)),
        user.watch.canEdit && button('Bearbeiten', { size: 'sm', onClick: () => { m.close(); watchDialog({ edit: user.id }); } })),
      user && !user.watch && !user.isSelf && can('users.edit') && h('div', { class: 'row', style: { margin: '0 0 12px' } }, button('Auf die Watchlist setzen', { size: 'sm', variant: 'danger', icon: 'eye', onClick: () => { m.close(); watchDialog({ userId: user.id }); } })),
      user && h('div', { class: 'member-card' }, userAvatar(user, 'lg'),
        h('div', { class: 'grow' }, h('div', { class: 'mc-name' }, user.displayName), h('div', { class: 'mc-sub' }, user.username ? `@${user.username}` : (user.memberNumber ? 'Dienstnummer' : '')),
          h('div', { class: 'mc-meta' }, statusBadge(user.status), rankBadge(user.rank), deptBadge(user.department))),
        memberNo(user.memberNumber, true)),
      user && !user.isSelf && (can('users.avatar_edit') || (user.avatarUrl && can('users.avatar_remove'))) && h('div', { class: 'row', style: { margin: '0 0 14px' } }, avatarFile,
        can('users.avatar_edit') && button(user.avatarUrl ? 'Profilbild ändern' : 'Profilbild hochladen', { size: 'sm', icon: 'download', onClick: () => avatarFile.click() }),
        user.avatarUrl && can('users.avatar_remove') && button('Profilbild entfernen', { size: 'sm', variant: 'danger', icon: 'trash', onClick: async () => {
          if (!await confirmDialog({ title: 'Profilbild entfernen?', message: 'Das Profilbild dieses Mitglieds wird gelöscht. Es kann ein neues hochladen.', confirmLabel: 'Entfernen' })) return;
          try { await api.del(`/api/users/${user.id}/avatar`); toast('Profilbild entfernt.'); m.close(); load(true); } catch (e) { toast(e.message, 'err'); }
        } })),
      h('div', { class: 'form-row' }, field('Name (Vor- und Nachname)', dn), field('Benutzername', un)),
      noInput && field('Dienstnummer', noInput, { help: 'Eindeutig, z. B. 1042 oder LSPD-1042. Vergeben und ändern dürfen Superadmin und Mitglieder mit dem Recht „Dienstnummern vergeben“.' }),
      h('div', { class: 'form-row' }, field('Behörde', deptSel), field('Rang', rankSel)),
      extraBoxes && field('Zusätzliche Behörden-Freigaben', h('div', { class: 'stack' }, ...extraBoxes.map(([, c]) => c)), { help: 'Zugriff auf Fahrzeuge, Lager und Mitglieder weiterer Behörden – zusätzlich zur eigenen.' }),
      supSel && field('Vorgesetzter', supSel, { help: 'Direkter Vorgesetzter dieses Mitglieds.' }),
      !user && field('Passwort', pw),
      !user && h('div', null, h('div', { class: 'sep' }), h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Persönliche Angaben (Personalakte)'),
        personNew ? [personNew.el, PERS_DOCS.map(([k, label]) => field(label, docPickers[k].el)), extras.el]
          : note('Vorname, Nachname, Straße, Postal Code, Telefonnummer, UMail, Kontonummer und die Dokumente (Ausweis, Führerschein, Waffenschein, Führungszeugnis) kannst du nur erfassen, wenn dir das Recht „users.personnel_edit“ zugewiesen ist (Rollen & Rechte → Rolle bearbeiten, oder beim Benutzer unter „Direkte Rechte“).', 'alert')),
      !user && h('div', { class: 'help' }, 'Der Benutzer wird sofort aktiv geschaltet und erhält automatisch die nächste Dienstnummer.'),
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
            rankId: idOrNull(rankSel), departmentId: idOrNull(deptSel), extraDepartmentIds: extraBoxes ? extraBoxes.filter(([, c]) => c.input.checked).map(([d]) => d.id) : undefined, supervisorId: supSel ? idOrNull(supSel) : undefined,
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
