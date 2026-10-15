import { h } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, openModal, levelBadge, empty } from '../../ui/kit.js';
import { api } from '../../api.js';
import { fmtDateTime } from '../../ui/dom.js';

const KIND = { deal: 'Geschäft', loan: 'Kredit', admin: 'Anpassung durch das Team' };

/** Level-Fenster im Partner-Portal: eigenes Level, Fortschritt, alle Stufen und Verlauf (nur die eigenen Daten). */
export async function openLevelDialog() {
  let d;
  try { d = (await api.get('/api/p/level')).level; } catch (e) { return openModal({ title: 'Level', body: empty('Nicht verfügbar', e.message, 'alert'), footer: [] }); }
  if (!d.enabled) {
    const m = openModal({ title: 'Level', body: empty('Kein Level-System', 'Für deinen Zugang ist das Level-System nicht aktiviert.', 'star'), footer: [button('Schließen', { onClick: () => m.close() })] });
    return;
  }
  const bar = h('div', { class: 'lvl-bar' }, h('div', { class: 'lvl-bar-fill', style: { width: `${Math.round(d.progress * 100)}%` } }));
  const m = openModal({
    title: 'Dein Level',
    body: h('div', null,
      h('div', { class: 'lvl-hero' }, h('div', { class: 'lvl-hero-icon' }, icon(d.icon)), h('div', null, h('div', { class: 'lvl-hero-n' }, `Level ${d.n}`), h('div', { class: 'lvl-hero-name' }, d.name))),
      h('div', { class: 'lvl-xp' }, h('b', null, d.xp.toLocaleString('de-DE')), ' XP', d.next ? h('span', { class: 'muted' }, ` · noch ${d.next.remaining.toLocaleString('de-DE')} XP bis Level ${d.next.n} (${d.next.name})`) : h('span', { class: 'muted' }, ' · höchste Stufe erreicht')),
      bar,
      h('div', { class: 'label', style: { margin: '18px 0 6px' } }, 'Alle Stufen'),
      h('div', { class: 'lvl-list' }, d.levels.map((l) => h('div', { class: `lvl-row ${l.n === d.n ? 'on' : ''} ${l.n > d.n ? 'locked' : ''}` }, levelBadge({ n: l.n, name: l.name, icon: l.icon }), h('span', { class: 'grow' }, l.name), h('span', { class: 'muted' }, `ab ${l.xp.toLocaleString('de-DE')} XP`)))),
      h('div', { class: 'label', style: { margin: '18px 0 6px' } }, 'Verlauf'),
      d.history.length ? d.history.map((x) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', { class: 't', style: { whiteSpace: 'normal' } }, x.note || KIND[x.kind] || 'XP'), h('div', { class: 's' }, `${KIND[x.kind] ?? ''} · ${fmtDateTime(x.createdAt)}`)),
        h('b', { style: { color: x.delta > 0 ? 'var(--ok)' : 'var(--err)' } }, `${x.delta > 0 ? '+' : ''}${x.delta} XP`))) : h('div', { class: 'muted' }, 'Noch keine Erfahrungspunkte gesammelt.')),
    footer: [button('Schließen', { variant: 'primary', onClick: () => m.close() })],
  });
}
