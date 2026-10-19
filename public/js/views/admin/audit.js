import { h, mount, fmtDateTime, debounce } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, table, select, badge, openModal, skeletons, empty, toast, input } from '../../ui/kit.js';
import { api } from '../../api.js';
import { can } from '../../state.js';

const LABELS = {
  'system.setup': 'System eingerichtet', 'config.changed': 'Einstellung geändert',
  'auth.login': 'Anmeldung', 'auth.login_failed': 'Fehlgeschlagene Anmeldung',
  'user.registered': 'Zugang beantragt', 'user.created': 'Benutzer erstellt', 'user.updated': 'Benutzer bearbeitet',
  'user.approved': 'Benutzer freigeschaltet', 'user.rejected': 'Zugang abgelehnt', 'user.blocked': 'Benutzer gesperrt',
  'user.unblocked': 'Benutzer entsperrt', 'user.reset_pending': 'Auf „Ausstehend“ gesetzt', 'user.deleted': 'Benutzer gelöscht',
  'user.password_changed': 'Passwort geändert', 'user.password_reset': 'Passwort zurückgesetzt',
  'rank.created': 'Rang erstellt', 'rank.updated': 'Rang bearbeitet', 'rank.deleted': 'Rang gelöscht', 'rank.reordered': 'Rangfolge geändert',
  'department.created': 'Abteilung erstellt', 'department.updated': 'Abteilung bearbeitet', 'department.deleted': 'Abteilung gelöscht',
  'partner.created': 'Externen Zugang erstellt', 'partner.updated': 'Externen Zugang bearbeitet', 'partner.disabled': 'Externen Link deaktiviert', 'partner.enabled': 'Externen Link aktiviert',
  'partner.code_reset': 'Zugangscode erneuert', 'partner.link_regenerated': 'Externen Link erneuert', 'partner.deleted': 'Externen Zugang gelöscht',
  'partner.login': 'Partner-Anmeldung', 'partner.login_failed': 'Partner-Anmeldung fehlgeschlagen', 'partner.locked': 'Partner-Zugang gesperrt (Fehlversuche)',
  'market.item_created': 'Item angelegt', 'market.item_updated': 'Item bearbeitet', 'market.item_deleted': 'Item gelöscht',
  'market.wanted_created': 'Gesuch erstellt', 'market.wanted_updated': 'Gesuch bearbeitet', 'market.wanted_deleted': 'Gesuch gelöscht',
  'market.deal_created': 'Geschäft eröffnet', 'market.deal_accept': 'Geschäft angenommen', 'market.deal_counter': 'Gegenangebot', 'market.deal_reject': 'Geschäft abgelehnt',
  'market.deal_withdraw': 'Angebot zurückgezogen', 'market.deal_handover': 'Übergabe festgelegt', 'market.deal_advance': 'Geschäftsstatus geändert', 'market.deal_cancel': 'Geschäft storniert',
  'market.deal_message': 'Nachricht im Geschäft', 'market.deal_assign': 'Geschäft zugewiesen',
  'lookup.created': 'Listeneintrag erstellt', 'lookup.updated': 'Listeneintrag bearbeitet', 'lookup.deleted': 'Listeneintrag gelöscht', 'lookup.reordered': 'Liste sortiert',
  'permission.created': 'Eigenes Recht erstellt', 'permission.updated': 'Eigenes Recht bearbeitet', 'permission.deleted': 'Eigenes Recht gelöscht',
  'system.backup_created': 'Datensicherung erstellt', 'warehouse.created': 'Lager angelegt', 'warehouse.updated': 'Lager bearbeitet', 'warehouse.deleted': 'Lager gelöscht', 'warehouse.stock_in': 'Eingelagert', 'warehouse.stock_out': 'Ausgelagert', 'warehouse.stock_set': 'Bestand korrigiert', 'warehouse.stock_transfer': 'Umgelagert', 'warehouse.item_created': 'Artikel angelegt', 'warehouse.item_updated': 'Artikel bearbeitet', 'warehouse.item_deleted': 'Artikel gelöscht', 'credit.requested': 'Kredit angefragt', 'credit.counter': 'Kredit: Gegenvorschlag', 'credit.accept': 'Kredit angenommen', 'credit.reject': 'Kredit abgelehnt', 'credit.withdraw': 'Kreditanfrage zurückgezogen', 'credit.cancel': 'Kredit storniert', 'credit.message': 'Kredit: Nachricht', 'credit.disburse': 'Kredit ausgezahlt', 'credit.payment': 'Kreditrate erfasst', 'credit.report': 'Ratenzahlung gemeldet', 'credit.default': 'Kredit ausgefallen', 'credit.limit_set': 'Kreditrahmen geändert', 'tab.company_deleted': 'Deckel-Firma gelöscht', 'tab.statement_deleted': 'Deckel-Abrechnung gelöscht', 'tab.company_created': 'Deckel-Firma angelegt', 'tab.company_updated': 'Deckel-Firma bearbeitet', 'tab.company_link_reset': 'Firmen-Portal-Link erneuert', 'tab.statement_submitted': 'Firma reicht Abrechnung ein', 'tab.statement_review': 'Abrechnung in Prüfung', 'tab.statement_confirm': 'Abrechnung bestätigt', 'tab.statement_reject': 'Abrechnung abgelehnt', 'tab.statement_prepare': 'Zahlung vorbereitet', 'tab.statement_invoice': 'Rechnungsdaten erfasst', 'tab.statement_invoice_file': 'Rechnungsdatei hochgeladen', 'tab.statement_pay': 'Abrechnung bezahlt', 'tab.statement_note': 'Notiz zur Abrechnung', 'vehicle.created': 'Fahrzeug angelegt', 'vehicle.updated': 'Fahrzeug bearbeitet', 'vehicle.deleted': 'Fahrzeug gelöscht', 'map.point_created': 'Waypoint gesetzt', 'map.point_updated': 'Waypoint geändert', 'map.point_deleted': 'Waypoint gelöscht', 'chat.channel_created': 'Chat-Kanal erstellt', 'chat.channel_updated': 'Chat-Kanal bearbeitet', 'chat.channel_deleted': 'Chat-Kanal gelöscht', 'chat.message_deleted': 'Chat-Nachricht moderiert (gelöscht)', 'branding.updated': 'Logo/Hintergrund geändert', 'branding.reset': 'Logo/Hintergrund zurückgesetzt', 'auth.sessions_revoked': 'Andere Sitzungen beendet', 'credit.deleted': 'Kredit gelöscht', 'market.deal_deleted': 'Börsen-Geschäft gelöscht', 'partner.document_uploaded': 'Dokument zu externem Zugang hochgeladen', 'account.avatar_set': 'Eigenes Profilbild geändert', 'account.avatar_removed': 'Eigenes Profilbild entfernt', 'user.avatar_set': 'Profilbild eines Mitglieds geändert', 'user.avatar_removed': 'Profilbild eines Mitglieds entfernt', 'finance.entry_created': 'Manuelle Buchung angelegt', 'finance.entry_settled': 'Buchung verbucht', 'finance.entry_cancelled': 'Buchung storniert', 'finance.entry_deleted': 'Journal-Eintrag gelöscht', 'finance.exported': 'Journal exportiert (CSV)', 'system.factory_reset': 'Panel auf null zurückgesetzt',
  'board.acknowledged': 'Schwarzes Brett bestätigt (gelesen)', 'board.created': 'Aushang erstellt', 'board.updated': 'Aushang geändert', 'board.deleted': 'Aushang gelöscht',
  'changelog.acknowledged': 'Changelog bestätigt (gelesen)', 'changelog.created': 'Changelog-Eintrag erstellt', 'changelog.updated': 'Changelog-Eintrag geändert', 'changelog.deleted': 'Changelog-Eintrag gelöscht',
  'schedule.event_created': 'Termin angelegt', 'schedule.event_updated': 'Termin geändert', 'schedule.event_cancelled': 'Termin abgesagt', 'schedule.event_deleted': 'Termin gelöscht', 'schedule.event_rsvp': 'Zu-/Absage zu Termin',
  'schedule.task_created': 'Auftrag vergeben', 'schedule.task_updated': 'Auftrag geändert', 'schedule.task_state': 'Auftragsstatus geändert', 'schedule.task_deleted': 'Auftrag gelöscht',
  'map.zone_created': 'Kartenzone eingezeichnet', 'map.zone_updated': 'Kartenzone geändert', 'map.zone_deleted': 'Kartenzone gelöscht',
  'activity.absence_added': 'Abmeldung eingetragen', 'activity.absence_ended': 'Abmeldung beendet', 'onboarding.step': 'Einarbeitungs-Schritt bestätigt', 'onboarding.started': 'Einarbeitung gestartet', 'onboarding.finished': 'Einarbeitung beendet', 'onboarding.removed': 'Einarbeitung entfernt',
  'onboarding.step_created': 'Einarbeitungs-Schritt angelegt', 'onboarding.step_updated': 'Einarbeitungs-Schritt geändert', 'onboarding.step_deleted': 'Einarbeitungs-Schritt gelöscht', 'partner.rated': 'Partner bewertet',
  'watchlist.added': 'Auf die Watchlist gesetzt', 'watchlist.updated': 'Watchlist-Eintrag geändert', 'watchlist.removed': 'Von der Watchlist genommen',
  'role.created': 'Rolle erstellt', 'role.updated': 'Rolle bearbeitet', 'role.deleted': 'Rolle gelöscht',
};
export const actionLabel = (a) => LABELS[a] ?? a;
const tone = (a) => (/failed|blocked|rejected|deleted/.test(a) ? 'b-err' : /approved|created|unblocked|setup/.test(a) ? 'b-ok' : /changed|updated|reset/.test(a) ? 'b-warn' : 'b-info');
const pretty = (v) => (v == null ? '—' : JSON.stringify(v, null, 2));
const PAGE = 25;

function showEntry(r) {
  const dl = h('dl', { class: 'details-dl' },
    h('dt', null, 'Zeitpunkt'), h('dd', null, fmtDateTime(r.ts)),
    h('dt', null, 'Benutzer'), h('dd', null, r.username ?? 'System'),
    h('dt', null, 'Aktion'), h('dd', null, `${actionLabel(r.action)} `, h('span', { class: 'muted mono' }, r.action)),
    h('dt', null, 'Modul'), h('dd', null, r.module),
    h('dt', null, 'Datensatz'), h('dd', null, r.targetLabel ? `${r.targetLabel} (${r.targetType} #${r.targetId ?? '–'})` : '–'),
    h('dt', null, 'IP-Adresse'), h('dd', { class: 'mono' }, r.ip ?? '–'));
  openModal({
    title: 'Audit-Eintrag', wide: true,
    body: h('div', null, dl, (r.before != null || r.after != null) && [h('div', { class: 'sep' }),
      h('div', { class: 'diff-grid' },
        h('div', null, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Vorher'), h('pre', { class: 'diff' }, pretty(r.before))),
        h('div', null, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Nachher'), h('pre', { class: 'diff' }, pretty(r.after))))]),
  });
}

export default async function render(container, ctx) {
  const f = { q: '', module: '', user: '', from: '', to: '', page: 0 };
  const search = h('input', { class: 'input', placeholder: 'Suche nach Benutzer, Aktion oder Datensatz …', 'aria-label': 'Suche' });
  const moduleSel = h('select', { class: 'select', style: { width: '180px' }, 'aria-label': 'Modul' });
  const list = h('div');
  const userIn = h('input', { class: 'input', placeholder: 'Benutzer', style: { width: '150px' }, 'aria-label': 'Benutzer' });
  const fromIn = h('input', { class: 'input', type: 'date', style: { width: '150px' }, title: 'Von', 'aria-label': 'Von' });
  const toIn = h('input', { class: 'input', type: 'date', style: { width: '150px' }, title: 'Bis', 'aria-label': 'Bis' });
  const query = () => {
    const p = new URLSearchParams();
    for (const k of ['q', 'module', 'user', 'from', 'to']) if (f[k]) p.set(k, f[k]);
    return p;
  };
  const exportCsv = async () => {
    try {
      const res = await fetch('/api/audit/export?' + query(), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Export nicht möglich.');
      const url = URL.createObjectURL(await res.blob());
      const a = h('a', { href: url, download: `audit-${new Date().toISOString().slice(0, 10)}.csv` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(e.message, 'err'); }
  };
  const toolbar = h('div', { class: 'toolbar' }, h('div', { class: 'input-icon' }, icon('search'), search), moduleSel, userIn, fromIn, toIn, h('div', { class: 'grow' }),
    can('audit.export') && button('CSV-Export', { icon: 'download', size: 'sm', onClick: exportCsv }));
  mount(container, toolbar, list);

  async function load(silent = false) {
    if (!silent) mount(list, skeletons(5, 48));
    const p = query();
    p.set('limit', PAGE); p.set('offset', f.page * PAGE);
    let data;
    try { data = await api.get('/api/audit?' + p); } catch (e) { toast(e.message, 'err'); return mount(list, empty('Fehler beim Laden', e.message, 'alert')); }
    mount(moduleSel, [h('option', { value: '' }, 'Alle Module'), data.modules.map((m) => h('option', { value: m, selected: m === f.module }, m))]);
    const pages = Math.max(1, Math.ceil(data.total / PAGE));
    const tbl = table([
      { label: 'Zeitpunkt', render: (r) => h('span', { class: 'muted', style: { whiteSpace: 'nowrap' } }, fmtDateTime(r.ts)) },
      { label: 'Benutzer', render: (r) => r.username ?? h('span', { class: 'muted' }, 'System') },
      { label: 'Aktion', render: (r) => badge(actionLabel(r.action), tone(r.action)) },
      { label: 'Modul', render: (r) => h('span', { class: 'mono muted' }, r.module) },
      { label: 'Datensatz', render: (r) => r.targetLabel ?? '–' },
      { label: '', style: { width: '48px' }, render: (r) => ((r.before != null || r.after != null) ? button('', { size: 'sm', variant: 'ghost', icon: 'eye', title: 'Details', onClick: () => showEntry(r) }) : '') },
    ], data.rows, { onRowClick: showEntry, empty: empty('Keine Einträge gefunden', 'Passe Suche oder Filter an.', 'audit') });
    tbl.append(h('div', { class: 'pager' }, h('span', null, `${data.total} Einträge · Seite ${f.page + 1} von ${pages}`),
      h('div', { class: 'row' },
        button('', { size: 'sm', icon: 'chevronL', title: 'Zurück', disabled: f.page === 0, onClick: () => { f.page--; load(); } }),
        button('', { size: 'sm', icon: 'chevronR', title: 'Weiter', disabled: f.page + 1 >= pages, onClick: () => { f.page++; load(); } }))));
    mount(list, tbl);
  }
  search.addEventListener('input', debounce(() => { f.q = search.value.trim(); f.page = 0; load(); }));
  moduleSel.addEventListener('change', () => { f.module = moduleSel.value; f.page = 0; load(); });
  userIn.addEventListener('input', debounce(() => { f.user = userIn.value.trim(); f.page = 0; load(); }));
  fromIn.addEventListener('change', () => { f.from = fromIn.value; f.page = 0; load(); });
  toIn.addEventListener('change', () => { f.to = toIn.value; f.page = 0; load(); });
  ctx.live(['audit'], () => load(true));
  await load();
}
