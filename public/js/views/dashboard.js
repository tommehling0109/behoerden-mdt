import { h, mount, timeAgo, fmtDateTime } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { card, roleChip, avatar, button, skeletons, empty, badge, toast, openModal } from '../ui/kit.js';
import { api } from '../api.js';
import { state, canAny } from '../state.js';
import { actionLabel } from './admin/audit.js';
import { openApp } from '../shell.js';
import { NAV } from '../modules.js';
import { everySecond, timeParts, dateLong } from '../clock.js';

/**
 * Widget-Renderer. Spätere Module registrieren hier ihre Widgets (Schlüssel = Widget-ID vom Server).
 * Unbekannte Widget-IDs werden ignoriert; ein fehlerhaftes Widget zeigt nur sich selbst als Fehlerkarte – nie das ganze Dashboard.
 */
const hour = () => new Date().getHours();
const greeting = () => (hour() < 5 ? 'Gute Nacht' : hour() < 11 ? 'Guten Morgen' : hour() < 18 ? 'Guten Tag' : 'Guten Abend');
const nf = (n) => Number(n ?? 0).toLocaleString('de-DE');
const money = (n) => `${Number(n ?? 0).toLocaleString('de-DE', { minimumFractionDigits: Number.isInteger(Number(n ?? 0)) ? 0 : 2, maximumFractionDigits: 2 })} ${state.config['market.currency'] || '$'}`;

/** Kennzahl-Kachel mit Symbol; tone = ok | warn | err | info */
const tile = (value, label, { ic, tone = '', onClick } = {}) => {
  const el = h('div', { class: `tile ${tone ? 't-' + tone : ''} ${onClick ? 'clickable' : ''}` },
    ic && h('div', { class: 'tile-ic' }, icon(ic)), h('div', { class: 'tile-body' }, h('div', { class: 'tile-value' }, value ?? 0), h('div', { class: 'tile-label' }, label)));
  if (onClick) el.addEventListener('click', onClick);
  return el;
};
/** Waagerechte Fortschrittsleiste (0–100 %) */
const meter = (pct, color) => h('div', { class: 'meter' }, h('i', { style: { width: `${Math.max(0, Math.min(100, pct))}%`, '--c': color ?? 'var(--accent)' } }));
/** Gestapelter Balken aus Segmenten [{count,color,label}] samt Legende */
function stack(segments, total) {
  const sum = total ?? segments.reduce((a, s) => a + s.count, 0);
  return h('div', null,
    h('div', { class: 'stackbar' }, sum ? segments.filter((s) => s.count > 0).map((s) => h('i', { title: `${s.label}: ${s.count}`, style: { flex: s.count, background: s.color } })) : h('i', { style: { flex: 1, background: 'var(--bg-4)' } })),
    h('div', { class: 'legend' }, segments.map((s) => h('span', { class: `lg ${s.count ? '' : 'zero'}` }, h('i', { style: { background: s.color } }), s.label, h('b', null, s.count)))));
}

const RENDERERS = {
  /** Regelwerk der Organisation: gut sichtbar ganz oben – öffnet das (live eingebettete) Dokument; ohne Link ein Platzhalter. */
  codex: (w) => {
    const c = w.data.codex;
    const read = () => {
      const m = openModal({ title: 'Codex', wide: true,
        body: h('iframe', { class: 'codex-frame', src: c.embedUrl, title: 'Codex', referrerpolicy: 'no-referrer', allow: 'clipboard-write' }),
        footer: [h('span', { class: 'grow' }), button('In Google öffnen', { icon: 'link', onClick: () => window.open(c.openUrl, '_blank', 'noopener') }), button('Schließen', { variant: 'primary', onClick: () => m.close() })] });
    };
    return h('section', { class: 'card codex-hero' },
      h('div', { class: 'codex-ic' }, icon('scale')),
      h('div', { class: 'codex-text' },
        h('div', { class: 'hero-kicker' }, 'Pflichtlektüre'),
        h('h2', null, 'Der Codex'),
        h('p', null, c ? 'Die verbindlichen Regeln der Organisation.' : 'Das Regelwerk wurde noch nicht hinterlegt. Er folgt in einem späteren Update.')),
      c ? button('Codex lesen', { variant: 'primary', icon: 'book', onClick: read })
        : (w.data.canManage ? button('Link hinterlegen', { icon: 'edit', onClick: () => openApp('config') }) : null));
  },

  welcome: (w) => {
    const time = h('span', { class: 'hero-hm' }), sec = h('span', { class: 'hero-s' }), date = h('div', { class: 'hero-date' });
    const el = h('section', { class: 'card hero' },
      h('div', { class: 'hero-text' },
        h('div', { class: 'hero-kicker' }, state.config['system.name'] || 'MDT'),
        h('h2', null, `${greeting()}, ${state.user.displayName}`),
        h('p', null, 'Hier ist deine aktuelle Lage auf einen Blick.'),
        h('div', { class: 'chips' }, w.data.roles.length ? w.data.roles.map(roleChip) : badge('Keine Rolle zugewiesen', 'b-mute', false))),
      h('div', { class: 'hero-clock' }, h('div', { class: 'hero-time' }, time, sec), date));
    everySecond(el, () => { const t = timeParts(); time.textContent = t.hm; sec.textContent = `:${t.s}`; date.textContent = dateLong(new Date(), true); });
    return el;
  },

  'quick-links': (w) => {
    const items = NAV.flatMap((s) => s.items).filter((i) => i.id !== 'dashboard' && (!i.perm || canAny(i.perm)));
    const body = items.length
      ? h('div', { class: 'quick-grid' }, items.map((i) => {
        const b = h('button', { type: 'button', class: 'quick' }, h('div', { class: 'q-ic' }, icon(i.icon)), h('div', { class: 'q-l' }, i.label));
        b.addEventListener('click', () => openApp(i.id));
        return b;
      }))
      : empty('Keine Apps freigegeben', 'Frag einen Administrator nach Rechten.', 'lock');
    return card(w.title, body, { icon: 'dashboard' });
  },

  'user-stats': (w) => {
    const c = w.data.counts;
    return card(w.title, h('div', { class: 'tile-row' },
      tile(c.active, 'Aktiv', { ic: 'userCheck', tone: 'ok', onClick: () => openApp('users') }),
      tile(c.pending, 'Ausstehend', { ic: 'hourglass', tone: c.pending ? 'warn' : '', onClick: () => openApp('users') }),
      tile(c.blocked, 'Gesperrt', { ic: 'lockClosed', tone: c.blocked ? 'err' : '', onClick: () => openApp('users') })), { icon: 'users' });
  },

  'pending-access': (w) => {
    const list = w.data.users;
    const body = list.length
      ? list.map((u) => h('div', { class: 'list-row' }, avatar(u.displayName),
        h('div', { class: 'grow' }, h('div', { class: 't' }, u.displayName), h('div', { class: 's' }, `Beantragt ${timeAgo(u.createdAt)}`)),
        button('Prüfen', { size: 'sm', variant: 'info', onClick: () => openApp('users') })))
      : empty('Keine offenen Anträge', 'Alle Zugänge sind bearbeitet.', 'userCheck');
    return card(w.title, body, { icon: 'hourglass', flush: true });
  },

  'recent-activity': (w) => {
    const rows = w.data.rows;
    const body = rows.length
      ? rows.map((r) => h('div', { class: 'list-row' }, h('div', { class: 'dot-icon' }, icon('activity')),
        h('div', { class: 'grow' }, h('div', { class: 't' }, actionLabel(r.action)), h('div', { class: 's' }, `${r.username ?? 'System'}${r.targetLabel ? ' → ' + r.targetLabel : ''}`)),
        h('span', { class: 'muted', style: { fontSize: '12px' }, title: fmtDateTime(r.ts) }, timeAgo(r.ts))))
      : empty('Noch keine Aktivitäten', null, 'activity');
    return card(w.title, body, { icon: 'activity', flush: true });
  },

  'market-open': (w) => {
    const d = w.data;
    const latest = d.latest.map((x) => h('div', { class: 'list-row', style: { padding: '9px 0', cursor: 'pointer' }, onclick: () => openApp('market') },
      h('div', { class: 'grow' }, h('div', { class: 't' }, `${x.partner.number} · ${x.item.name}`), h('div', { class: 's' }, `${nf(x.quantity)} × ${nf(x.unitPrice)}`)),
      h('b', null, money(x.total))));
    const segs = (d.statuses ?? []).map((s) => ({ count: s.count, color: s.color, label: s.label })).filter((s) => s.count > 0);
    return card(w.title, h('div', { class: 'stack-v' },
      h('div', { class: 'tile-row' }, tile(d.awaitingStaff, 'Warten auf uns', { ic: 'alert', tone: d.awaitingStaff ? 'warn' : '', onClick: () => openApp('market') }),
        tile(d.active, 'Laufend', { ic: 'refresh', tone: 'info', onClick: () => openApp('market') }), tile(d.openWanted, 'Gesuche', { ic: 'search', onClick: () => openApp('market') })),
      segs.length > 0 && stack(segs),
      latest.length > 0 && h('div', null, h('div', { class: 'sub-title' }, 'Wartet auf uns'), latest)), { icon: 'tag' });
  },

  'vehicles-overview': (w) => {
    const d = w.data;
    return card(w.title, h('div', { class: 'stack-v' },
      h('div', { class: 'tile-row' }, tile(d.total, 'Fahrzeuge', { ic: 'car', tone: 'info', onClick: () => openApp('vehicles') }),
        tile(d.lowFuel, 'Tank/Akku < 20 %', { ic: 'fuel', tone: d.lowFuel ? 'warn' : '', onClick: () => openApp('vehicles') }),
        tile(d.inspectionOverdue, 'HU überfällig', { ic: 'wrench', tone: d.inspectionOverdue ? 'err' : '', onClick: () => openApp('vehicles') })),
      stack(d.conditions.map((c) => ({ count: c.count, color: c.color, label: c.label })), d.total),
      d.mine > 0 && h('div', { class: 'muted', style: { fontSize: '12.5px' } }, `${d.mine} Fahrzeug${d.mine === 1 ? '' : 'e'} sind dir zugewiesen.`)), { icon: 'car' });
  },

  'warehouse-overview': (w) => {
    const d = w.data;
    const rows = d.warehouses.map((x) => {
      const pct = x.capacity ? Math.round((x.used / x.capacity) * 100) : null;
      return h('div', { class: 'wh-row', onclick: () => openApp('warehouse') },
        h('div', { class: 'wh-top' }, h('b', null, x.name), h('span', { class: 'muted' }, pct != null ? `${pct} %` : `${nf(x.used)} belegt`)),
        pct != null && meter(pct, pct >= 90 ? 'var(--err)' : pct >= 70 ? 'var(--warn)' : 'var(--ok, #34d399)'));
    });
    return card(w.title, h('div', { class: 'stack-v' },
      h('div', { class: 'tile-row' }, tile(d.count, 'Lagerstandorte', { ic: 'storage', tone: 'info', onClick: () => openApp('warehouse') }), tile(nf(d.kinds), 'Artikelsorten', { ic: 'tag' }), tile(nf(d.units), 'Einheiten gesamt', { ic: 'list' })),
      rows.length ? h('div', null, h('div', { class: 'sub-title' }, 'Auslastung'), rows) : null,
      d.low.length > 0 && h('div', null, h('div', { class: 'sub-title warn' }, 'Bestand niedrig'),
        d.low.map((i) => h('div', { class: 'list-row', style: { padding: '8px 0' } }, h('div', { class: 'grow t' }, i.name), h('span', { class: 'muted' }, `${nf(i.stock)} / ${nf(i.target)} ${i.unit}`))))), { icon: 'storage' });
  },

  'tab-overview': (w) => {
    const d = w.data;
    const cents = (c) => money(c / 100);
    return card(w.title, h('div', { class: 'stack-v' },
      h('div', { class: 'tile-row' }, tile(d.companies, 'Aktive Firmen', { ic: 'dollar', tone: 'info', onClick: () => openApp('tab') }),
        tile(d.submitted + d.review, 'Neu / in Prüfung', { ic: 'search', tone: d.submitted ? 'warn' : '', onClick: () => openApp('tab') }), tile(d.confirmed + d.paymentPending, 'Zahlung ausstehend', { ic: 'alert', tone: d.confirmed + d.paymentPending ? 'warn' : '', onClick: () => openApp('tab') }), tile(d.paid, 'Bezahlt', { ic: 'check', tone: 'ok', onClick: () => openApp('tab') })),
      h('div', { class: 'fin-balance neg' }, h('div', { class: 'fb-l' }, 'Noch zu zahlen'), h('div', { class: 'fb-v' }, cents(d.openCents))),
      d.recent.length > 0 && h('div', null, h('div', { class: 'sub-title' }, 'Aktuelle Abrechnungen'), d.recent.slice(0, 4).map((x) => h('div', { class: 'list-row', style: { padding: '8px 0', cursor: 'pointer' }, onclick: () => openApp('tab') },
        h('div', { class: 'grow' }, h('div', { class: 't' }, x.company), h('div', { class: 's' }, x.period)), h('b', null, cents(x.amountCents)), h('span', { class: 'badge', style: { '--c': x.statusColor } }, x.statusLabel))))), { icon: 'dollar' });
  },

  'tickets-open': (w) => {
    const d = w.data;
    return card(w.title, h('div', { class: 'tile-row' }, tile(d.open, 'Offen', { ic: 'bug', tone: d.open ? 'warn' : '', onClick: () => openApp('tickets') }), tile(d.inProgress, 'In Arbeit', { ic: 'activity', tone: 'info', onClick: () => openApp('tickets') }), tile(d.high, 'Hohe Priorität', { ic: 'alert', tone: d.high ? 'err' : '', onClick: () => openApp('tickets') })), { icon: 'bug' });
  },

  'credit-overview': (w) => {
    const d = w.data;
    const cents = (c) => money(c / 100);
    return card(w.title, h('div', { class: 'stack-v' },
      h('div', { class: 'tile-row' }, tile(d.awaitingStaff, 'Anfragen offen', { ic: 'alert', tone: d.awaitingStaff ? 'warn' : '', onClick: () => openApp('credit') }), tile(d.active, 'Laufend', { ic: 'refresh', tone: 'info', onClick: () => openApp('credit') }),
        tile(d.overdueCount, 'Überfällig', { ic: 'hourglass', tone: d.overdueCount ? 'err' : '', onClick: () => openApp('credit') })),
      h('div', { class: 'fin-balance pos' }, h('div', { class: 'fb-l' }, 'Verliehen (noch offen)'), h('div', { class: 'fb-v' }, cents(d.outstandingCents))),
      h('div', { class: 'fin-line' }, h('span', { class: 'muted' }, 'Erwartete Zinsen'), h('b', null, cents(d.expectedInterestCents)))), { icon: 'dollar' });
  },

  'finance-flow': (w) => {
    const d = w.data;
    const line = (label, v, cls) => h('div', { class: 'fin-line' }, h('span', { class: 'muted' }, label), h('b', { class: cls }, money(v)));
    return card(w.title, h('div', { class: 'stack-v' },
      h('div', { class: `fin-balance ${d.balanceExpected >= 0 ? 'pos' : 'neg'}` }, h('div', { class: 'fb-l' }, 'Erwartete Bilanz'), h('div', { class: 'fb-v' }, `${d.balanceExpected >= 0 ? '+' : '−'}${money(Math.abs(d.balanceExpected))}`)),
      h('div', null, line('Erwarteter Eingang', d.expectedIn, 'pos'), line('Erwartete Ausgabe', d.expectedOut, 'neg'), line('Bereits eingegangen', d.settledIn, 'pos'), line('Bereits gezahlt', d.settledOut, 'neg'))), { icon: 'dollar' });
  },

  'system-status': (w) => {
    const up = w.data.uptimeSeconds;
    const upTxt = up > 86400 ? `${Math.floor(up / 86400)} Tg. ${Math.floor((up % 86400) / 3600)} Std.` : up > 3600 ? `${Math.floor(up / 3600)} Std. ${Math.floor((up % 3600) / 60)} Min.` : `${Math.floor(up / 60)} Min.`;
    const row = (l, v) => h('div', { class: 'list-row', style: { padding: '9px 0' } }, h('div', { class: 'grow muted' }, l), v);
    const srv = h('b', null);
    const offset = new Date(w.data.serverTime).getTime() - Date.now();
    const el = h('div', null,
      row('Datenbank', badge(w.data.database === 'ok' ? 'Online' : 'Fehler', w.data.database === 'ok' ? 'b-ok' : 'b-err')),
      row('Laufzeit', h('b', null, upTxt)),
      row('Serverzeit', srv));
    everySecond(el, () => { const t = timeParts(new Date(Date.now() + offset)); srv.textContent = `${t.hm}:${t.s}`; });
    return card(w.title, el, { icon: 'server' });
  },
};
const SPAN = { small: 'span-4', medium: 'span-8', wide: 'span-12' };

const errorCard = (w, e) => card(w.title ?? w.id, h('div', { class: 'muted' }, `Dieses Widget konnte nicht geladen werden (${e?.message ?? 'Fehler'}).`), { icon: 'alert' });

export default async function render(container, ctx) {
  mount(container, skeletons(4, 120));
  const load = async () => {
    const { widgets } = await api.get('/api/dashboard');
    if (!ctx.isCurrent()) return;
    const grid = h('div', { class: 'grid dash' });
    let i = 0;
    for (const w of widgets) {
      const r = RENDERERS[w.id];
      if (!r) continue;
      let el;
      try { el = r(w); } catch (e) { el = errorCard(w, e); }
      el.style.flex = '1';
      grid.append(h('div', { class: `${SPAN[w.size] ?? 'span-6'} dash-cell`, style: { display: 'flex', flexDirection: 'column', '--i': i++ } }, el));
    }
    mount(container, grid.childElementCount ? grid : card(null, empty('Keine Widgets aktiv', 'Aktivierte Widgets erscheinen hier – verwaltet unter Konfiguration → Dashboard-Widgets.', 'dashboard')));
  };
  ctx.setActions(button('Aktualisieren', { icon: 'refresh', size: 'sm', onClick: () => load().catch((e) => toast(e.message, 'err')) }));
  ctx.live(['*'], () => load().catch(() => {})); // jede Änderung im System aktualisiert das Dashboard sofort
  await load();
}
