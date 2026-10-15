import { h, mount, fmtDate } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { button, busy, field, input, select, formError, openModal, confirmDialog, toast, empty } from './ui/kit.js';
import { api } from './api.js';
import { subscribe } from './realtime.js';

/**
 * Changelog direkt auf dem Desktop (links, nur Mitarbeiter): die letzten Updates kompakt, einklappbar; „Weitere Updates“ öffnet
 * alle älteren Einträge in einem Fenster. Mit „changelog.manage“ lassen sich Einträge anlegen, bearbeiten und löschen.
 */
const KIND = { new: ['Neu', '#10b981'], changed: ['Geändert', '#5b8def'], fixed: ['Behoben', '#f59e0b'], removed: ['Entfernt', '#ef4444'], security: ['Sicherheit', '#a78bfa'] };
const KEY = 'mdt.changelog.collapsed';
const read = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const write = (v) => { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* egal */ } };
const SHOW = 3, PER_ITEMS = 3;

const kindChip = (k) => h('span', { class: 'cl-kind', style: { '--c': KIND[k][1] } }, KIND[k][0]);
const entryTitle = (e) => h('div', { class: 'cl-head' }, e.version && h('span', { class: 'cl-ver' }, e.version), h('span', { class: 'cl-date' }, fmtDate(e.releasedAt)));

function editDialog(entry, onDone) {
  const err = h('div'), version = input({ maxLength: 20, value: entry?.version ?? '', placeholder: 'z. B. 1.4.0 (optional)' });
  const title = input({ maxLength: 80, value: entry?.title ?? '', placeholder: 'Kurzer Titel des Updates' });
  const date = input({ type: 'date', value: entry?.releasedAt ?? new Date().toISOString().slice(0, 10) });
  const list = h('div', { class: 'cl-edit-items' });
  let rows = (entry?.items?.length ? entry.items : [{ kind: 'new', text: '' }]).map((i) => ({ ...i }));
  const draw = () => mount(list, rows.map((r, i) => {
    const sel = select(Object.entries(KIND).map(([value, [label]]) => ({ value, label })), r.kind, { style: { width: '130px', flex: 'none' } });
    const txt = input({ value: r.text, maxLength: 240, placeholder: 'Was hat sich geändert?' });
    sel.addEventListener('change', () => { r.kind = sel.value; }); txt.addEventListener('input', () => { r.text = txt.value; });
    return h('div', { class: 'row', style: { flexWrap: 'nowrap', marginBottom: '6px' } }, sel, txt, button('', { size: 'sm', variant: 'ghost', icon: 'x', title: 'Punkt entfernen', disabled: rows.length === 1, onClick: () => { rows.splice(i, 1); draw(); } }));
  }));
  draw();
  const m = openModal({ title: entry ? 'Update bearbeiten' : 'Neues Update', wide: true,
    body: h('div', null, err, h('div', { class: 'form-row' }, field('Version', version), field('Datum', date)), field('Titel', title), h('div', { class: 'label', style: { margin: '10px 0 6px' } }, 'Änderungen'), list,
      button('Punkt hinzufügen', { size: 'sm', icon: 'plus', onClick: () => { rows.push({ kind: rows.at(-1)?.kind ?? 'new', text: '' }); draw(); } })),
    footer: [button('Abbrechen', { onClick: () => m.close() }), button(entry ? 'Speichern' : 'Veröffentlichen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      const payload = { version: version.value, title: title.value, releasedAt: date.value, items: rows.filter((r) => r.text.trim()).map((r) => ({ kind: r.kind, text: r.text })) };
      try { if (entry) await api.patch(`/api/changelog/${entry.id}`, payload); else await api.post('/api/changelog', payload); m.close(); toast(entry ? 'Gespeichert.' : 'Update veröffentlicht.'); onDone?.(); }
      catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) })] });
  title.focus();
}

/** Fenster mit allen Updates (nachladbar). */
async function openAll(canManage, onChange) {
  const body = h('div', { class: 'cl-all' }); let entries = [], total = 0, off;
  const m = openModal({ title: 'Alle Updates', wide: true, body, footer: [button('Schließen', { onClick: () => m.close() })], onClose: () => off?.() });
  const draw = () => mount(body, entries.length ? entries.map((e) => h('article', { class: 'cl-full' },
    h('div', { class: 'cl-full-top' }, e.version && h('span', { class: 'cl-ver' }, e.version), h('b', null, e.title), h('span', { class: 'cl-date' }, fmtDate(e.releasedAt)), h('span', { class: 'grow' }),
      canManage && h('span', { class: 'cl-tools' }, button('', { size: 'sm', variant: 'ghost', icon: 'edit', title: 'Bearbeiten', onClick: () => editDialog(e, reload) }),
        button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Löschen', onClick: async () => { if (!await confirmDialog({ title: 'Update löschen?', message: `„${e.title}“ wird aus dem Changelog entfernt.`, confirmLabel: 'Löschen' })) return; try { await api.del(`/api/changelog/${e.id}`); await reload(); onChange?.(); } catch (ex) { toast(ex.message, 'err'); } } }))),
    h('ul', { class: 'cl-list' }, e.items.map((i) => h('li', null, kindChip(i.kind), h('span', null, i.text)))),
    e.author && h('div', { class: 'muted', style: { fontSize: '11px' } }, e.author))) : empty('Noch keine Updates', null, 'flag'),
  entries.length < total && h('div', { style: { textAlign: 'center', margin: '10px 0' } }, button(`Ältere laden (${total - entries.length})`, { onClick: more })));
  async function load(offset, size) { const r = await api.get(`/api/changelog?limit=${size}&offset=${offset}`); total = r.total; return r.entries; }
  async function more() { try { entries = [...entries, ...await load(entries.length, 15)]; draw(); } catch (e) { toast(e.message, 'err'); } }
  async function reload() { try { entries = await load(0, Math.max(entries.length, 15)); draw(); } catch (e) { toast(e.message, 'err'); } }
  off = subscribe(['changelog'], reload, { wait: 200 });
  await reload();
}

/**
 * Pflicht-Hinweis: Neue oder geänderte Changelog-Einträge werden jedem Mitglied beim Anmelden, Neuladen und bei neuen Einträgen angezeigt
 * und müssen einmal bestätigt werden (je Eintrag und Änderungsstand). Das Fenster lässt sich nicht ohne Bestätigung schließen.
 */
/** Darstellung eines Changelog-Eintrags im Pflicht-Fenster (auch vom gemeinsamen Fenster mit dem Schwarzen Brett genutzt). */
export const ackEntryEl = (e) => h('article', { class: 'cl-full' },
  h('div', { class: 'cl-full-top' }, e.version && h('span', { class: 'cl-ver' }, e.version), h('b', null, e.title), e.changed && h('span', { class: 'cl-kind', style: { '--c': '#f59e0b' } }, 'Geändert'), h('span', { class: 'cl-date' }, fmtDate(e.releasedAt))),
  h('ul', { class: 'cl-list' }, e.items.map((i) => h('li', null, kindChip(i.kind), h('span', null, i.text)))));
// (Das eigentliche Pflicht-Fenster liegt jetzt in updates-ack.js und zeigt Changelog und Schwarzes Brett gemeinsam.)
export function createChangelog() {
  let entries = [], total = 0, canManage = false, collapsed = read();
  const el = h('aside', { class: 'board changelog', 'aria-label': 'Changelog' });
  function draw() {
    el.hidden = !total && !canManage;
    el.classList.toggle('collapsed', collapsed);
    const head = h('div', { class: 'board-head' },
      h('button', { class: 'board-title', type: 'button', title: collapsed ? 'Aufklappen' : 'Zuklappen', onclick: () => { collapsed = !collapsed; write(collapsed); draw(); } },
        icon('list'), h('span', null, 'Changelog'), entries[0]?.version && h('span', { class: 'cl-ver' }, entries[0].version), icon(collapsed ? 'chevronD' : 'chevronU')),
      canManage && button('', { size: 'sm', variant: 'ghost', icon: 'plus', title: 'Neues Update', onClick: () => editDialog(null, load) }));
    const list = h('div', { class: 'board-list' }, entries.length ? entries.map((e) => h('article', { class: 'cl-entry' },
      entryTitle(e), h('div', { class: 'cl-title' }, e.title),
      h('ul', { class: 'cl-list compact' }, e.items.slice(0, PER_ITEMS).map((i) => h('li', null, kindChip(i.kind), h('span', null, i.text))), e.items.length > PER_ITEMS && h('li', { class: 'cl-more' }, `… und ${e.items.length - PER_ITEMS} weitere`))))
      : h('div', { class: 'board-empty' }, 'Noch keine Updates. Mit „+“ legst du das erste an.'),
    total > 0 && h('button', { class: 'cl-all-btn', type: 'button', onclick: () => openAll(canManage, load) }, total > SHOW ? `Weitere Updates anzeigen (${total - SHOW})` : 'Alle Updates im Fenster öffnen'));
    mount(el, head, !collapsed && list);
  }
  async function load() { try { const r = await api.get(`/api/changelog?limit=${SHOW}`); entries = r.entries; total = r.total; canManage = r.canManage; draw(); } catch { /* ohne Changelog */ } }
  load();
  const off = subscribe(['changelog'], load, { wait: 150 });
  return { el, destroy: off };
}
