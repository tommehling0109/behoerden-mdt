import { all, get, run, tx, now, DB_PATH } from '../core/db.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { bad, conflict, notFound, str, HttpError } from '../core/http.js';
import { audit } from '../core/audit.js';
import { rateLimit } from '../core/auth.js';
import { getConfig } from '../core/config.js';
import { allocateNumber } from '../core/numbers.js';
import { labelForUser } from '../core/identity.js';
import { notify, staffWith } from '../core/notifications.js';
import { expectTabStatement, settleTabStatement, cancelTabStatement } from '../core/ledger.js';
import { periodInfo, recentPeriods } from '../core/periods.js';
import { decodeDocument, DOC_MIME } from '../core/images.js';
import { purgeCompany, purgeStatement } from '../core/purge.js';
import { registerWidget } from './dashboard.js';
import { openStream } from '../core/realtime.js';

/**
 * Deckel-System für EXTERNE FIRMEN: Eine Firma (Firmenname, Firmensitz, Kontonummer) bekommt einen persönlichen Portal-Link.
 * Darüber reicht sie je Woche/Monat ihren fälligen Betrag ein (optional mit Kommentar). Wir geben keine Summen ein und gleichen nichts ab:
 * Das Team prüft die Abrechnung, bestätigt sie – dabei steht sofort, auf WELCHES Konto (Kontonummer der Firma) WIE VIEL überwiesen wird –
 * wickelt die Zahlung ab (Überweisung oder Rechnung der Firma) und archiviert. Alles läuft im Finanz-Journal mit.
 * Firmen sehen nie Daten anderer Firmen und nie interne Informationen.
 */
const STATUS = {
  submitted: { label: 'Eingereicht', color: '#fbbf24' }, review: { label: 'In Prüfung', color: '#60a5fa' }, confirmed: { label: 'Bestätigt', color: '#34d399' },
  payment_pending: { label: 'Zahlung ausstehend', color: '#fb923c' }, paid: { label: 'Bezahlt', color: '#22c55e' }, rejected: { label: 'Abgelehnt', color: '#f87171' },
};
const OPEN_STATUSES = ['submitted', 'review', 'confirmed', 'payment_pending'];
const INTERVALS = { weekly: 'Wöchentlich', monthly: 'Monatlich' };
const CENTS_MAX = 100_000_000_00;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_RE = /^[A-Z0-9-]{3,20}$/;
const invDir = () => join(dirname(DB_PATH), 'tab-invoices');
const cents = (v, name, { min = 1 } = {}) => { if (!Number.isInteger(v) || v < min || v > CENTS_MAX) throw bad(`${name}: gültiger Betrag erforderlich.`); return v; };
const currency = () => getConfig('market.currency') ?? '$';
const fmtC = (c) => `${(c / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency()}`;

// ── Firmen ──
const newToken = () => randomBytes(24).toString('base64url');
const portalPath = (t) => `/deckel/firma/${t}`;
const sumWhere = (companyId, cond) => get(`SELECT COALESCE(SUM(COALESCE(approved_cents, submitted_cents)),0) s FROM tab_statements WHERE company_id = ? AND ${cond}`, companyId).s;
const openAmount = (id) => sumWhere(id, `status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(',')})`);
const paidAmount = (id) => sumWhere(id, "status = 'paid'");

function companyDto(c, user) {
  return {
    id: c.id, number: c.company_number, name: c.name, seat: c.seat, accountNumber: c.account_number, contactName: c.contact_name, contactInfo: c.contact_info,
    interval: c.billing_interval, intervalLabel: INTERVALS[c.billing_interval], status: c.status, notes: c.notes,
    openCents: openAmount(c.id), paidCents: paidAmount(c.id), statementCount: get('SELECT COUNT(*) c FROM tab_statements WHERE company_id = ?', c.id).c, createdAt: c.created_at,
    linkPath: user.perms.has('tab.manage_companies') ? portalPath(c.link_token) : undefined,
  };
}
const loadCompany = (id) => get('SELECT * FROM tab_companies WHERE id = ?', id);

function companyFields(b, partial) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('name')) out.name = str(b.name, 'Firmenname', { min: 2, max: 80 });
  if (has('seat')) out.seat = str(b.seat, 'Firmensitz', { min: 3, max: 120 });
  if (has('accountNumber')) {
    const a = String(b.accountNumber ?? '').trim().toUpperCase();
    if (!ACCOUNT_RE.test(a)) throw bad('Kontonummer: 3–20 Zeichen (Buchstaben/Ziffern), z. B. LS28180705.');
    out.account_number = a;
  }
  if (b.contactName !== undefined || !partial) out.contact_name = str(b.contactName, 'Ansprechpartner', { max: 80, required: false });
  if (b.contactInfo !== undefined || !partial) out.contact_info = str(b.contactInfo, 'Kontakt', { max: 300, required: false });
  if (has('interval')) { if (!INTERVALS[b.interval]) throw bad('Abrechnungsintervall: wöchentlich oder monatlich.'); out.billing_interval = b.interval; }
  if (b.status !== undefined) { if (!['active', 'disabled'].includes(b.status)) throw bad('Ungültiger Status.'); out.status = b.status; }
  if (b.notes !== undefined) out.notes = str(b.notes, 'Notizen', { max: 1000, required: false });
  return out;
}

// ── Abrechnungen ──
const STMT_SQL = `SELECT s.*, c.name company_name, c.company_number, c.billing_interval, c.seat company_seat, c.account_number company_account FROM tab_statements s JOIN tab_companies c ON c.id = s.company_id`;
function statementDto(s, viewer) {
  const amount = s.approved_cents ?? s.submitted_cents;
  return {
    id: s.id, number: s.statement_number, company: { id: s.company_id, name: s.company_name, number: s.company_number, interval: s.billing_interval, seat: s.company_seat, accountNumber: s.company_account },
    period: periodInfo(s.period_key), submittedCents: s.submitted_cents, approvedCents: s.approved_cents, amountCents: amount, comment: s.comment,
    status: s.status, statusLabel: STATUS[s.status].label, statusColor: STATUS[s.status].color, diffNote: s.diff_note, rejectReason: s.reject_reason,
    payMethod: s.pay_method, paidAt: s.paid_at, payReference: s.pay_reference,
    invoice: { received: !!s.invoice_received, number: s.invoice_number, amountCents: s.invoice_amount_cents, date: s.invoice_date, hasFile: !!s.invoice_file_ext },
    submittedAt: s.submitted_at, updatedAt: s.updated_at, reviewer: s.reviewed_by ? labelForUser(s.reviewed_by, viewer?.id ?? null) : null,
  };
}
const slog = (id, text, { userId = null, company = false } = {}) => run('INSERT INTO tab_statement_log (statement_id,ts,user_id,by_company,text) VALUES (?,?,?,?,?)', id, now(), userId, company ? 1 : 0, text);

registerWidget({ id: 'tab-overview', title: 'Deckel', size: 'medium', permission: 'tab.view', data: () => summary() });

function summary() {
  const by = Object.fromEntries(all('SELECT status, COUNT(*) c FROM tab_statements GROUP BY status').map((r) => [r.status, r.c]));
  const companies = all("SELECT id FROM tab_companies WHERE status = 'active'");
  const recent = all(`${STMT_SQL} ORDER BY s.id DESC LIMIT 8`).map((s) => ({ id: s.id, company: s.company_name, interval: INTERVALS[s.billing_interval], period: periodInfo(s.period_key)?.label, amountCents: s.approved_cents ?? s.submitted_cents, status: s.status, statusLabel: STATUS[s.status].label, statusColor: STATUS[s.status].color }));
  return {
    currency: currency(), companies: companies.length, openCompanies: all(`SELECT DISTINCT company_id FROM tab_statements WHERE status IN (${OPEN_STATUSES.map((x) => `'${x}'`).join(',')})`).length,
    submitted: by.submitted ?? 0, review: by.review ?? 0, confirmed: by.confirmed ?? 0, paymentPending: by.payment_pending ?? 0, paid: by.paid ?? 0, rejected: by.rejected ?? 0,
    openCents: get(`SELECT COALESCE(SUM(COALESCE(approved_cents, submitted_cents)),0) s FROM tab_statements WHERE status IN (${OPEN_STATUSES.map((x) => `'${x}'`).join(',')})`).s,
    paidCents: get("SELECT COALESCE(SUM(COALESCE(approved_cents, submitted_cents)),0) s FROM tab_statements WHERE status = 'paid'").s, recent,
  };
}

export default {
  name: 'tab',
  permissions: [
    ['tab.view', 'Deckel: Firmen und Abrechnungen ansehen'],
    ['tab.manage_companies', 'Deckel: Firmen anlegen/bearbeiten und Portal-Links verwalten'],
    ['tab.statements', 'Deckel: Abrechnungen prüfen, bestätigen und Zahlungen abwickeln (Finanz)'],
    ['tab.delete', 'Deckel: Firmen und Abrechnungen endgültig löschen'],
  ],
  config: [
    { key: 'tab.statement_prefix', group: 'Deckel', label: 'Präfix der Abrechnungsnummer', type: 'string', default: 'MDT-DA-', max: 12 },
    { key: 'tab.statement_start', group: 'Deckel', label: 'Startnummer der Abrechnungen', type: 'number', default: 1001, min: 1, max: 99999999 },
    { key: 'tab.company_prefix', group: 'Deckel', label: 'Präfix der Firmennummer', type: 'string', default: 'MDT-F-', max: 12 },
    { key: 'tab.company_start', group: 'Deckel', label: 'Startnummer der Firmen', type: 'number', default: 1001, min: 1, max: 99999999 },
    { key: 'tab.allow_current_period', group: 'Deckel', label: 'Firmen dürfen den laufenden Zeitraum schon abrechnen', help: 'Standard: nur abgeschlossene Wochen/Monate.', type: 'bool', default: false },
  ],
  routes(r) {
    // ══ Mitarbeiter ══
    r.get('/api/tab/options', { perm: ['tab.view', 'tab.statements', 'tab.manage_companies'] }, (ctx) => ({
      currency: currency(), canView: ctx.user.perms.has('tab.view'), canCompanies: ctx.user.perms.has('tab.manage_companies'), canStatements: ctx.user.perms.has('tab.statements'), canDelete: ctx.user.perms.has('tab.delete'),
      statuses: Object.entries(STATUS).map(([key, v]) => ({ key, ...v })),
    }));

    r.get('/api/tab/companies', { perm: ['tab.view', 'tab.manage_companies', 'tab.statements'] }, (ctx) => ({ companies: all('SELECT * FROM tab_companies ORDER BY status, name').map((c) => companyDto(c, ctx.user)) }));
    r.get('/api/tab/companies/:id', { perm: ['tab.view', 'tab.manage_companies', 'tab.statements'] }, (ctx) => {
      const c = loadCompany(Number(ctx.params.id));
      if (!c) throw notFound('Firma nicht gefunden.');
      return { company: companyDto(c, ctx.user), statements: all(`${STMT_SQL} WHERE s.company_id = ? ORDER BY s.submitted_at DESC`, c.id).map((s) => statementDto(s, ctx.user)) };
    });
    r.post('/api/tab/companies', { perm: 'tab.manage_companies' }, (ctx) => {
      const f = companyFields(ctx.body, false);
      if (get('SELECT 1 x FROM tab_companies WHERE name = ?', f.name)) throw conflict('Eine Firma mit diesem Namen existiert bereits.');
      const id = tx(() => {
        const t = now();
        const cols = { company_number: allocateNumber('tab_company', 'tab.company_prefix', 'tab.company_start'), status: 'active', ...f, link_token: newToken(), created_by: ctx.user.id, created_at: t, updated_at: t };
        return Number(run(`INSERT INTO tab_companies (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols).map(() => '?').join(',')})`, ...Object.values(cols)).lastInsertRowid);
      });
      const c = loadCompany(id);
      audit(ctx, { action: 'tab.company_created', module: 'tab', targetType: 'tab_company', targetId: id, targetLabel: `${c.company_number} · ${c.name}`, after: { interval: c.billing_interval, seat: c.seat, account: c.account_number } });
      ctx.status = 201;
      return { company: companyDto(c, ctx.user) };
    });
    r.patch('/api/tab/companies/:id', { perm: 'tab.manage_companies' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = loadCompany(id);
      if (!cur) throw notFound('Firma nicht gefunden.');
      const f = companyFields(ctx.body, true);
      if (f.name && get('SELECT 1 x FROM tab_companies WHERE name = ? AND id != ?', f.name, id)) throw conflict('Eine Firma mit diesem Namen existiert bereits.');
      if (f.billing_interval && f.billing_interval !== cur.billing_interval && get('SELECT 1 x FROM tab_statements WHERE company_id = ?', id)) throw conflict('Das Abrechnungsintervall lässt sich nach der ersten Abrechnung nicht mehr ändern.');
      const cols = Object.keys(f);
      if (cols.length) run(`UPDATE tab_companies SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => f[c]), now(), id);
      const c = loadCompany(id);
      audit(ctx, { action: 'tab.company_updated', module: 'tab', targetType: 'tab_company', targetId: id, targetLabel: `${c.company_number} · ${c.name}`, before: { status: cur.status, interval: cur.billing_interval, account: cur.account_number }, after: { status: c.status, interval: c.billing_interval, account: c.account_number } });
      return { company: companyDto(c, ctx.user) };
    });
    r.post('/api/tab/companies/:id/reset-link', { perm: 'tab.manage_companies' }, (ctx) => {
      const id = Number(ctx.params.id);
      const c = loadCompany(id);
      if (!c) throw notFound('Firma nicht gefunden.');
      run('UPDATE tab_companies SET link_token = ?, updated_at = ? WHERE id = ?', newToken(), now(), id);
      audit(ctx, { action: 'tab.company_link_reset', module: 'tab', targetType: 'tab_company', targetId: id, targetLabel: `${c.company_number} · ${c.name}` });
      return { company: companyDto(loadCompany(id), ctx.user) };
    });
    r.delete('/api/tab/companies/:id', { perm: ['tab.manage_companies', 'tab.delete'] }, (ctx) => {
      const id = Number(ctx.params.id);
      const c = loadCompany(id);
      if (!c) throw notFound('Firma nicht gefunden.');
      const n = get('SELECT COUNT(*) c FROM tab_statements WHERE company_id = ?', id).c;
      if (n > 0 && !ctx.user.perms.has('tab.delete')) throw bad(`Die Firma hat ${n} Abrechnung(en). Zum Löschen samt Abrechnungen fehlt dir das Recht „tab.delete“ – oder deaktiviere die Firma.`);
      tx(() => purgeCompany(id));
      audit(ctx, { action: 'tab.company_deleted', module: 'tab', targetType: 'tab_company', targetId: id, targetLabel: `${c.company_number} · ${c.name}`, before: { statements: n } });
      return { ok: true };
    });

    // ── Abrechnungen ──
    r.get('/api/tab/summary', { perm: ['tab.view', 'tab.statements'] }, () => ({ summary: summary() }));
    r.get('/api/tab/statements', { perm: ['tab.view', 'tab.statements'] }, (ctx) => {
      const where = [], p = [];
      if (STATUS[ctx.query.status]) { where.push('s.status = ?'); p.push(ctx.query.status); }
      if (ctx.query.company) { where.push('s.company_id = ?'); p.push(Number(ctx.query.company)); }
      const rows = all(`${STMT_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (s.status IN ('submitted','review','confirmed','payment_pending')) DESC, s.submitted_at DESC LIMIT 300`, ...p);
      return { statements: rows.map((s) => statementDto(s, ctx.user)) };
    });
    r.get('/api/tab/statements/:id', { perm: ['tab.view', 'tab.statements'] }, (ctx) => {
      const s = get(`${STMT_SQL} WHERE s.id = ?`, Number(ctx.params.id));
      if (!s) throw notFound('Abrechnung nicht gefunden.');
      const log = all('SELECT * FROM tab_statement_log WHERE statement_id = ? ORDER BY id', s.id).map((l) => ({ id: l.id, ts: l.ts, actor: l.by_company ? `Firma ${s.company_name}` : l.user_id ? labelForUser(l.user_id, ctx.user.id) : 'System', text: l.text }));
      return { statement: statementDto(s, ctx.user), log, canManage: ctx.user.perms.has('tab.statements'), canDelete: ctx.user.perms.has('tab.delete') };
    });

    r.post('/api/tab/statements/:id/invoice-file', { perm: 'tab.statements', bodyLimit: 8 * 1024 * 1024 }, (ctx) => {
      const id = Number(ctx.params.id);
      const s = get('SELECT * FROM tab_statements WHERE id = ?', id);
      if (!s) throw notFound('Abrechnung nicht gefunden.');
      const { buf, ext } = decodeDocument(ctx.body.data, 5 * 1024 * 1024, bad);
      mkdirSync(invDir(), { recursive: true });
      writeFileSync(join(invDir(), `${id}.${ext}`), buf);
      run('UPDATE tab_statements SET invoice_file_ext = ?, updated_at = ? WHERE id = ?', ext, now(), id);
      slog(id, 'Rechnungsdatei hochgeladen', { userId: ctx.user.id });
      audit(ctx, { action: 'tab.statement_invoice_file', module: 'tab', targetType: 'tab_statement', targetId: id, targetLabel: s.statement_number });
      return { ok: true };
    });
    r.get('/api/tab/statements/:id/invoice-file', { perm: ['tab.statements', 'tab.view'] }, (ctx) => {
      const s = get('SELECT * FROM tab_statements WHERE id = ?', Number(ctx.params.id));
      const file = s?.invoice_file_ext && join(invDir(), `${s.id}.${s.invoice_file_ext}`);
      if (!file || !existsSync(file)) throw notFound('Keine Rechnungsdatei vorhanden.');
      ctx.raw = { contentType: DOC_MIME[s.invoice_file_ext], body: readFileSync(file), filename: `Rechnung-${s.statement_number}.${s.invoice_file_ext}`, inline: true };
    });
    r.delete('/api/tab/statements/:id', { perm: 'tab.delete' }, (ctx) => {
      const id = Number(ctx.params.id);
      const s = get(`${STMT_SQL} WHERE s.id = ?`, id);
      if (!s) throw notFound('Abrechnung nicht gefunden.');
      tx(() => purgeStatement(id));
      audit(ctx, { action: 'tab.statement_deleted', module: 'tab', targetType: 'tab_company', targetId: s.company_id, targetLabel: `${s.statement_number} · ${s.company_name} · ${periodInfo(s.period_key)?.label}`, before: { status: s.status, amount: fmtC(s.approved_cents ?? s.submitted_cents) } });
      return { ok: true };
    });

    r.post('/api/tab/statements/:id/:action', { perm: 'tab.statements' }, (ctx) => {
      const id = Number(ctx.params.id);
      const s = get(`${STMT_SQL} WHERE s.id = ?`, id);
      if (!s) throw notFound('Abrechnung nicht gefunden.');
      const b = ctx.body, action = ctx.params.action;
      const touch = (fields) => { const cols = Object.keys(fields); run(`UPDATE tab_statements SET ${[...cols.map((c) => `${c} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`, ...cols.map((c) => fields[c]), now(), id); };
      const need = (...ok) => { if (!ok.includes(s.status)) throw conflict(`Das geht im Status „${STATUS[s.status].label}“ nicht.`); };
      let text;
      tx(() => {
        switch (action) {
          case 'review': need('submitted'); touch({ status: 'review', reviewed_by: ctx.user.id }); text = 'Prüfung gestartet'; break;
          case 'confirm': {
            need('submitted', 'review');
            const approved = b.approvedCents === undefined ? s.submitted_cents : cents(b.approvedCents, 'Freigegebener Betrag', { min: 0 });
            const note = str(b.note, 'Notiz', { max: 300, required: false });
            if (approved !== s.submitted_cents && !note) throw bad('Bitte begründe den abweichend freigegebenen Betrag in einer Notiz.');
            touch({ status: 'confirmed', approved_cents: approved, diff_note: note, reviewed_by: ctx.user.id });
            expectTabStatement({ ...s, approved_cents: approved });
            text = `Bestätigt: ${fmtC(approved)} auf Konto ${s.company_account} (${s.company_name})${note ? ` – ${note}` : ''}`;
            break;
          }
          case 'reject': need('submitted', 'review', 'confirmed', 'payment_pending'); touch({ status: 'rejected', reject_reason: str(b.reason, 'Begründung', { min: 3, max: 300 }), reviewed_by: ctx.user.id }); cancelTabStatement(id); text = `Abgelehnt: ${b.reason}`; break;
          case 'prepare': {
            need('confirmed', 'payment_pending');
            if (!['transfer', 'invoice'].includes(b.method)) throw bad('Zahlungsart: Überweisung oder Rechnung.');
            touch({ status: 'payment_pending', pay_method: b.method }); text = `Zahlung vorbereitet (${b.method === 'transfer' ? `Überweisung an Konto ${s.company_account}` : 'Rechnung der Firma'})`; break;
          }
          case 'invoice': {
            need('confirmed', 'payment_pending');
            const f = {};
            if (b.received !== undefined) f.invoice_received = b.received ? 1 : 0;
            if (b.number !== undefined) f.invoice_number = str(b.number, 'Rechnungsnummer', { max: 60, required: false });
            if (b.amountCents !== undefined) f.invoice_amount_cents = b.amountCents == null || b.amountCents === '' ? null : cents(b.amountCents, 'Rechnungsbetrag', { min: 0 });
            if (b.date !== undefined) { if (b.date && !DATE_RE.test(b.date)) throw bad('Ungültiges Rechnungsdatum.'); f.invoice_date = b.date || null; }
            if (Object.keys(f).length) touch(f);
            text = 'Rechnungsdaten aktualisiert'; break;
          }
          case 'pay': {
            need('payment_pending');
            const approved = s.approved_cents ?? s.submitted_cents;
            if (s.pay_method === 'transfer') {
              const date = b.paidAt || now().slice(0, 10);
              if (!DATE_RE.test(date)) throw bad('Ungültiges Zahlungsdatum.');
              touch({ status: 'paid', paid_at: new Date(`${date}T12:00:00`).toISOString(), pay_reference: str(b.reference, 'Transaktions-/Buchungsnummer', { max: 80, required: false }), paid_by: ctx.user.id });
              text = `Überweisung über ${fmtC(approved)} an Konto ${s.company_account} am ${date} durchgeführt${b.reference ? ` (Ref. ${b.reference})` : ''}`;
            } else {
              if (!s.invoice_received) throw conflict('Bitte zuerst „Rechnung erhalten“ mit Rechnungsnummer erfassen.');
              if (!s.invoice_number) throw bad('Die Rechnungsnummer fehlt.');
              if (s.invoice_amount_cents !== approved && b.acceptDifference !== true) throw conflict(`Rechnungsbetrag (${fmtC(s.invoice_amount_cents ?? 0)}) weicht vom freigegebenen Betrag (${fmtC(approved)}) ab. Bitte prüfen oder die Differenz ausdrücklich freigeben.`);
              touch({ status: 'paid', paid_at: now(), paid_by: ctx.user.id });
              text = `Rechnung ${s.invoice_number} über ${fmtC(s.invoice_amount_cents ?? approved)} beglichen`;
            }
            settleTabStatement(id);
            break;
          }
          case 'note': text = `Notiz: ${str(b.text, 'Notiz', { min: 1, max: 300 })}`; touch({}); break;
          default: throw bad('Unbekannte Aktion.');
        }
        slog(id, text, { userId: ctx.user.id });
        if (action === 'confirm') notify(staffWith('tab.statements', ctx.user.id), { key: `tab:${id}:confirm`, title: 'Zahlung abwickeln', body: `${s.company_name} · ${periodInfo(s.period_key).label}: ${fmtC(get('SELECT COALESCE(approved_cents, submitted_cents) a FROM tab_statements WHERE id = ?', id).a)} auf Konto ${s.company_account} – bitte Zahlung vorbereiten.`, target: { app: 'tab', statementId: id } });
      });
      audit(ctx, { action: `tab.statement_${action}`, module: 'tab', targetType: 'tab_statement', targetId: id, targetLabel: `${s.statement_number} · ${s.company_name} · ${periodInfo(s.period_key).label}`, after: { text } });
      return { statement: statementDto(get(`${STMT_SQL} WHERE s.id = ?`, id), ctx.user) };
    });

    // ══ Firmenportal (persönlicher Link, kein Login; sieht nur die eigenen Abrechnungen) ══
    const byToken = (ctx) => {
      if (!rateLimit(`co|${ctx.ip}`, 120, 10 * 60_000)) throw new HttpError(429, 'Zu viele Anfragen. Bitte warte einige Minuten.', 'rate_limited');
      const t = String(ctx.params.token ?? '');
      const c = t.length >= 20 ? get("SELECT * FROM tab_companies WHERE link_token = ? AND status = 'active'", t) : null;
      if (!c) throw notFound('Dieser Link ist ungültig oder wurde deaktiviert.');
      return c;
    };
    const portalPeriods = (c) => {
      const used = new Set(all("SELECT period_key k FROM tab_statements WHERE company_id = ? AND status != 'rejected'", c.id).map((x) => x.k));
      return recentPeriods(c.billing_interval, { count: 12, includeCurrent: getConfig('tab.allow_current_period') === true }).filter((p) => !used.has(p.key));
    };
    const portalState = (c) => ({
      company: { name: c.name, interval: c.billing_interval, intervalLabel: INTERVALS[c.billing_interval] }, currency: currency(), periods: portalPeriods(c),
      statements: all(`${STMT_SQL} WHERE s.company_id = ? ORDER BY s.submitted_at DESC LIMIT 100`, c.id).map((s) => ({
        number: s.statement_number, period: periodInfo(s.period_key), submittedCents: s.submitted_cents, status: s.status, statusLabel: STATUS[s.status].label, statusColor: STATUS[s.status].color,
        submittedAt: s.submitted_at, paidAt: s.paid_at, rejectReason: s.status === 'rejected' ? s.reject_reason : '',
      })),
    });
    r.get('/api/c/:token', { auth: false }, (ctx) => portalState(byToken(ctx)));
    /** Live-Verbindung des Firmenportals: Statuswechsel erscheinen ohne Neuladen. */
    r.get('/api/c/:token/events', { auth: false }, (ctx) => { const c = byToken(ctx); return openStream(ctx, { kind: 'company', companyId: c.id, token: c.link_token }); });
    r.post('/api/c/:token/statements', { auth: false }, (ctx) => {
      const c = byToken(ctx);
      if (!rateLimit(`cosub|${c.id}`, 20, 10 * 60_000)) throw new HttpError(429, 'Zu viele Versuche. Bitte warte einige Minuten.', 'rate_limited');
      const period = portalPeriods(c).find((p) => p.key === ctx.body.periodKey);
      if (!period) throw bad('Für diesen Zeitraum kann keine Abrechnung (mehr) eingereicht werden.');
      const amount = cents(ctx.body.amountCents, 'Fälliger Betrag', { min: 0 });
      const comment = str(ctx.body.comment, 'Kommentar', { max: 500, required: false });
      const id = tx(() => {
        const t = now();
        const res = run(`INSERT INTO tab_statements (statement_number,company_id,period_key,submitted_cents,our_cents,comment,status,submitted_at,updated_at) VALUES (?,?,?,?,0,?,'submitted',?,?)`,
          allocateNumber('tab_statement', 'tab.statement_prefix', 'tab.statement_start'), c.id, period.key, amount, comment, t, t);
        const sid = Number(res.lastInsertRowid);
        slog(sid, `Firma reicht Abrechnung über ${fmtC(amount)} ein${comment ? ` – „${comment}“` : ''}`, { company: true });
        notify(staffWith('tab.statements'), { key: `tab:${sid}:new`, title: 'Neue Deckel-Abrechnung',
          body: `Firma: ${c.name} · Zeitraum: ${period.label} · Betrag: ${fmtC(amount)} · Konto: ${c.account_number} · eingereicht ${new Date(t).toLocaleDateString('de-DE')}`, target: { app: 'tab', statementId: sid } });
        return sid;
      });
      audit({ ip: ctx.ip, actorName: `Firma: ${c.name}` }, { action: 'tab.statement_submitted', module: 'tab', targetType: 'tab_statement', targetId: id, targetLabel: `${c.name} · ${period.label}`, after: { amount: fmtC(amount) } });
      ctx.status = 201;
      return { ok: true, message: 'Ihre Abrechnung wurde erfolgreich übermittelt und wird nun von uns geprüft.', ...portalState(c) };
    });
  },
};
