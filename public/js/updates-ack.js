import { h } from './ui/dom.js';
import { button, busy, openModal, toast } from './ui/kit.js';
import { api } from './api.js';
import { can } from './state.js';
import { playAnnounce } from './notifier.js';
import { ackEntryEl } from './changelog.js';

/**
 * Pflicht-Hinweis auf Neuigkeiten: neue oder geänderte Changelog-Einträge UND Aushänge des Schwarzen Bretts erscheinen gemeinsam in einem
 * Fenster (beim Anmelden, Neuladen, Zurückkehren auf die Seite und live) und müssen einmal bestätigt werden – je Person und Stand.
 * Das Fenster lässt sich nicht ohne Bestätigung schließen; die Bestätigung steht im Audit-Log und im Benutzerprofil.
 */
const LEVELS = { info: ['Info', '#5b8def'], important: ['Wichtig', '#f59e0b'], urgent: ['Dringend', '#ef4444'], success: ['Neuigkeit', '#10b981'] };
const postEl = (p) => h('article', { class: 'cl-full', style: { borderLeft: `3px solid ${LEVELS[p.level]?.[1] ?? 'var(--accent)'}` } },
  h('div', { class: 'cl-full-top' }, h('span', { class: 'cl-kind', style: { '--c': LEVELS[p.level]?.[1] ?? '#5b8def' } }, LEVELS[p.level]?.[0] ?? 'Info'), h('b', null, p.title), p.changed && h('span', { class: 'cl-kind', style: { '--c': '#f59e0b' } }, 'Geändert')),
  p.body && h('div', { class: 'lc-text', style: { marginTop: '6px' } }, p.body));

let ackOpen = false;
export async function checkUpdatesAck() {
  if (ackOpen) return;
  const [cl, bd] = await Promise.all([
    can('changelog.view') ? api.get('/api/changelog/unread').catch(() => null) : null,
    can('board.view') ? api.get('/api/board/unread').catch(() => null) : null,
  ]);
  const entries = cl?.entries ?? [], posts = bd?.posts ?? [];
  if (!entries.length && !posts.length) return;
  ackOpen = true;
  playAnnounce(); // eigener Klang, damit man Neuigkeiten von Nachrichten unterscheiden kann
  const max = (list) => list.reduce((a, e) => (e.updatedAt > a ? e.updatedAt : a), '');
  const title = posts.length && entries.length ? 'Neuigkeiten' : posts.length ? (posts.length === 1 ? 'Neuer Aushang' : 'Neue Aushänge') : (entries.length === 1 ? 'Neues Update' : 'Neue Updates');
  const more = (n, what) => n > 0 && h('div', { class: 'muted', style: { textAlign: 'center', margin: '6px 0' } }, `Dazu ${n} ältere${n === 1 ? 's' : ''} ${what} (nach der Bestätigung nachzulesen).`);
  const m = openModal({
    title, wide: true, locked: true,
    body: h('div', { class: 'cl-all' },
      h('p', { class: 'muted', style: { margin: '0 0 10px' } }, 'Bitte lies die folgenden Neuigkeiten und bestätige sie. Neue und geänderte Einträge werden dir so lange angezeigt, bis du bestätigt hast.'),
      posts.length > 0 && [h('div', { class: 'label', style: { margin: '4px 0 6px' } }, 'Schwarzes Brett'), posts.map(postEl), more(bd.more, 'Aushang')],
      entries.length > 0 && [h('div', { class: 'label', style: { margin: '14px 0 6px' } }, 'Changelog'), entries.map(ackEntryEl), more(cl.more, 'Update')]),
    footer: [h('span', { class: 'grow' }), button('Gelesen und verstanden', { variant: 'primary', icon: 'check', onClick: (ev) => busy(ev.currentTarget, async () => {
      try {
        if (entries.length) await api.post('/api/changelog/ack', { upTo: max(entries) });
        if (posts.length) await api.post('/api/board/ack', { upTo: max(posts) });
        m.close(); ackOpen = false; checkUpdatesAck();
      } catch (ex) { toast(ex.message, 'err'); }
    }) })],
  });
}
