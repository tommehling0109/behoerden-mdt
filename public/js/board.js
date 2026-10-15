import { h, mount, timeAgo, fmtDateTime } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { button, busy, field, input, select, toggle, formError, openModal, confirmDialog, toast } from './ui/kit.js';
import { api } from './api.js';
import { subscribe } from './realtime.js';

/**
 * Schwarzes Brett direkt auf dem Desktop (nur Mitarbeiter): Ankündigungen mit Hervorhebung, angepinnte zuerst.
 * Mit Recht „board.manage“ lassen sich Ankündigungen anlegen, bearbeiten, anpinnen und entfernen.
 */
const LEVELS = { info: ['Info', '#5b8def'], important: ['Wichtig', '#f59e0b'], urgent: ['Dringend', '#ef4444'], success: ['Neuigkeit', '#10b981'] };
const KEY = 'mdt.board.collapsed';
const read = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const write = (v) => { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* egal */ } };

function editDialog(post, onDone) {
  const err = h('div'), title = input({ maxLength: 80, value: post?.title ?? '', placeholder: 'Überschrift' });
  const body = h('textarea', { class: 'textarea', rows: 6, maxLength: 1500, placeholder: 'Text der Ankündigung (optional)' }); body.value = post?.body ?? '';
  const level = select(Object.entries(LEVELS).map(([value, [label]]) => ({ value, label })), post?.level ?? 'info');
  const pinned = toggle('Oben anpinnen', post?.pinned ?? false);
  const toLocal = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  const tickerT = toggle('Als Ticker über den Bildschirm laufen lassen', post?.ticker ?? false, null, 'Ein Farbband zwischen Kopfleiste und Desktop – in der Farbe der Hervorhebung.');
  const aud = select([{ value: 'all', label: 'Alle (Mitglieder und Externe)' }, { value: 'internal', label: 'Nur Mitglieder (intern)' }, { value: 'external', label: 'Nur Externe' }], post?.tickerAudience ?? 'all');
  const until = input({ type: 'datetime-local', value: toLocal(post?.tickerUntil) });
  const tickerBox = h('div', { class: 'ticker-opts', hidden: !tickerT.input.checked }, field('Wer sieht den Ticker?', aud), field('Läuft bis (optional)', until, { help: 'Leer = läuft, bis du den Ticker hier wieder abschaltest oder den Eintrag entfernst.' }));
  tickerT.input.addEventListener('change', () => { tickerBox.hidden = !tickerT.input.checked; });
  const m = openModal({ title: post ? 'Ankündigung bearbeiten' : 'Neue Ankündigung',
    body: h('div', null, err, field('Überschrift', title), field('Text', body), field('Hervorhebung', level), pinned, h('div', { class: 'sep' }), tickerT, tickerBox),
    footer: [button('Abbrechen', { onClick: () => m.close() }), button(post ? 'Speichern' : 'Veröffentlichen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      const payload = { title: title.value, body: body.value, level: level.value, pinned: pinned.input.checked, ticker: tickerT.input.checked, tickerAudience: aud.value, tickerUntil: until.value ? new Date(until.value).toISOString() : null };
      try { if (post) await api.patch(`/api/board/${post.id}`, payload); else await api.post('/api/board', payload); m.close(); toast(post ? 'Gespeichert.' : 'Ankündigung veröffentlicht.'); onDone?.(); }
      catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) })] });
  title.focus();
}

/** Baut das Brett; liefert { el, destroy }. */
export function createBoard() {
  let posts = [], canManage = false, collapsed = read();
  const el = h('aside', { class: 'board', 'aria-label': 'Schwarzes Brett' });
  const act = (fn) => async () => { try { await fn(); await load(); } catch (e) { toast(e.message, 'err'); } };

  function draw() {
    el.hidden = !posts.length && !canManage;
    el.classList.toggle('collapsed', collapsed);
    const hot = posts.filter((p) => p.level === 'urgent').length;
    const head = h('div', { class: 'board-head' },
      h('button', { class: 'board-title', type: 'button', title: collapsed ? 'Aufklappen' : 'Zuklappen', onclick: () => { collapsed = !collapsed; write(collapsed); draw(); } },
        icon('flag'), h('span', null, 'Schwarzes Brett'), posts.length > 0 && h('span', { class: `board-count ${hot ? 'hot' : ''}` }, posts.length), icon(collapsed ? 'chevronD' : 'chevronU')),
      canManage && button('', { size: 'sm', variant: 'ghost', icon: 'plus', title: 'Neue Ankündigung', onClick: () => editDialog(null, load) }));
    const list = h('div', { class: 'board-list' }, posts.length ? posts.map((p) => {
      const [label, color] = LEVELS[p.level];
      return h('article', { class: `board-post lvl-${p.level}${p.pinned ? ' pinned' : ''}`, style: { '--c': color } },
        h('div', { class: 'bp-top' }, h('span', { class: 'bp-lvl' }, p.pinned && icon('pin'), label, p.ticker && h('span', { class: 'bp-ticker', title: `Läuft als Ticker (${{ all: 'alle', internal: 'nur Mitglieder', external: 'nur Externe' }[p.tickerAudience]})${p.tickerUntil ? ' bis ' + new Date(p.tickerUntil).toLocaleString('de-DE') : ''}` }, icon('activity'), 'Ticker')), h('span', { class: 'bp-time', title: fmtDateTime(p.createdAt) }, timeAgo(p.createdAt))),
        h('div', { class: 'bp-title' }, p.title), p.body && h('div', { class: 'bp-body' }, p.body),
        h('div', { class: 'bp-foot' }, h('span', { class: 'muted' }, p.author ?? ''),
          canManage && h('span', { class: 'bp-tools' },
            button('', { size: 'sm', variant: 'ghost', icon: 'pin', title: p.pinned ? 'Lösen' : 'Anpinnen', onClick: act(() => api.patch(`/api/board/${p.id}`, { pinned: !p.pinned })) }),
            button('', { size: 'sm', variant: 'ghost', icon: 'edit', title: 'Bearbeiten', onClick: () => editDialog(p, load) }),
            button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Entfernen', onClick: async () => {
              if (!await confirmDialog({ title: 'Ankündigung entfernen?', message: `„${p.title}“ wird vom Schwarzen Brett genommen.`, confirmLabel: 'Entfernen' })) return;
              act(() => api.del(`/api/board/${p.id}`))();
            } }))));
    }) : h('div', { class: 'board-empty' }, 'Keine Ankündigungen. Mit „+“ legst du die erste an.'));
    mount(el, head, !collapsed && list);
  }
  async function load() {
    try { const r = await api.get('/api/board'); posts = r.posts; canManage = r.canManage; draw(); } catch { /* ohne Brett */ }
  }
  load();
  const off = subscribe(['board'], load, { wait: 150 });
  return { el, destroy: off };
}
