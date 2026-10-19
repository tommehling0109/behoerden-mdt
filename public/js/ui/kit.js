// UI-Kit: alle wiederverwendbaren Bausteine (Buttons, Badges, Felder, Tabs, Modals, Toasts …)
import { h, mount } from './dom.js';
import { icon } from './icons.js';

export function button(label, { variant = '', icon: ic, onClick, size = '', type = 'button', title, disabled } = {}) {
  const b = h('button', {
    class: `btn ${variant ? 'btn-' + variant : ''} ${size ? 'btn-' + size : ''} ${!label ? 'icon-btn' : ''}`.replace(/\s+/g, ' ').trim(),
    type, title, disabled, 'aria-label': !label ? title : undefined,
  }, ic && icon(ic), label);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** Führt einen asynchronen Klick-Handler mit Lade-Zustand aus. */
export async function busy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  const spinner = h('span', { class: 'spin' });
  btn.prepend(spinner);
  try { return await fn(); } finally { spinner.remove(); btn.disabled = false; }
}

export const STATUS = {
  pending: { label: 'Ausstehend', cls: 'b-warn' },
  active: { label: 'Aktiv', cls: 'b-ok' },
  blocked: { label: 'Gesperrt', cls: 'b-err' },
  rejected: { label: 'Abgelehnt', cls: 'b-mute' },
};
export const statusBadge = (s) => h('span', { class: `badge ${STATUS[s]?.cls ?? 'b-mute'}` }, STATUS[s]?.label ?? s);
/** Level-Anzeige eines Partners: Symbol + „Lvl 3“ (level = { n, name, icon } oder null → nichts). */
export const levelBadge = (level, { label = true } = {}) => (level ? h('span', { class: `lvl-badge lvl-${level.n}`, title: `Level ${level.n} · ${level.name}` }, icon(level.icon), label && `Lvl ${level.n}`) : null);
export const badge = (text, cls = 'b-info', dot = true) => h('span', { class: `badge ${cls} ${dot ? '' : 'no-dot'}` }, text);
export const rankBadge = (r) => (r ? h('span', { class: 'badge no-dot rank', style: { '--c': r.color } }, r.name) : null);
export const deptBadge = (d) => (d ? h('span', { class: 'badge dept', style: { '--c': d.color } }, d.name) : null);
/** Dienstnummer – prominent als Kennung (big = große Darstellung in Profilen). */
export const memberNo = (n, big = false) => h('span', { class: `member-no ${big ? 'big' : ''} ${n ? '' : 'none'}` }, n ?? 'noch keine');
export const roleChip = (r) => h('span', { class: 'badge no-dot', style: { '--c': r.color } }, r.name);

const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const initials = (name) => (/\d/.test(name) ? name.replace(/\D/g, '').slice(-3) : name.trim().slice(0, 2).toUpperCase());
/** Profilbild des Mitglieds (Bild, sonst Initialen/Nummer). user: { avatarUrl, displayName } */
export const userAvatar = (user, cls = '', fallbackName) => (user?.avatarUrl
  ? h('img', { class: `avatar ${cls}`, src: user.avatarUrl, alt: '', loading: 'lazy', decoding: 'async' })
  : avatar(fallbackName ?? user?.displayName ?? user?.label ?? '?', cls));
export const avatar = (name, cls = '') => h('div', { class: `avatar ${cls}`, style: { '--h': hue(name) } }, initials(name));

export function field(label, control, { help, error } = {}) {
  return h('div', { class: 'field' }, h('label', null, label), control, help && h('div', { class: 'help' }, help), error);
}
export const input = (o = {}) => h('input', { class: 'input', ...o });
export function select(options, value, attrs = {}) {
  const s = h('select', { class: 'select', ...attrs }, options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
  return s;
}
export function toggle(label, checked, onChange, desc) {
  const i = h('input', { type: 'checkbox', checked: !!checked });
  if (onChange) i.addEventListener('change', () => onChange(i.checked));
  const el = h('label', { class: 'switch' }, i, h('span', { class: 'track' }), h('span', null, label, desc && h('div', { class: 'help' }, desc)));
  el.input = i;
  return el;
}
export function checkbox(labelNode, checked, { desc, locked } = {}) {
  const i = h('input', { type: 'checkbox', checked: !!checked, disabled: locked });
  const el = h('label', { class: `check ${locked ? 'is-locked' : ''}` }, i, h('span', { class: 'check-text' }, labelNode, desc && h('div', { class: 'check-desc' }, desc)));
  el.input = i;
  return el;
}
export const formError = (msg) => h('div', { class: 'form-error', role: 'alert' }, icon('alert'), h('span', null, msg));

export function tabs(items, active, onChange) {
  const el = h('div', { class: 'tabs', role: 'tablist' });
  const render = (cur) => mount(el, items.map((t) => {
    const b = h('button', { class: `tab ${t.id === cur ? 'active' : ''}`, role: 'tab', 'aria-selected': t.id === cur, type: 'button' },
      t.label, t.count != null && h('span', { class: 'count' }, t.count));
    b.addEventListener('click', () => { render(t.id); onChange(t.id); });
    return b;
  }));
  render(active);
  return el;
}

export const empty = (title, text, ic = 'info') => h('div', { class: 'empty' }, icon(ic), h('div', { class: 't' }, title), text && h('div', null, text));
export const skeletons = (n = 3, height = 64) => h('div', { class: 'stack' }, Array.from({ length: n }, () => h('div', { class: 'skeleton', style: { height: `${height}px` } })));
export const note = (text, ic = 'info') => h('div', { class: 'note' }, icon(ic), h('div', null, text));

export function card(title, body, { icon: ic, actions, flush, cls = '' } = {}) {
  return h('section', { class: `card ${cls}` },
    title && h('div', { class: 'card-head' }, ic && icon(ic), h('h3', null, title), actions),
    h('div', { class: `card-body ${flush ? 'flush' : ''}` }, body));
}

export function table(columns, rows, { onRowClick, empty: emptyNode } = {}) {
  if (!rows.length) return h('div', { class: 'table-wrap' }, emptyNode ?? empty('Keine Einträge', null));
  return h('div', { class: 'table-wrap' }, h('div', { class: 'table-scroll' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, columns.map((c) => h('th', { style: c.style }, c.label)))),
    h('tbody', null, rows.map((r) => {
      const tr = h('tr', { class: onRowClick ? 'clickable' : '' }, columns.map((c) => h('td', { style: c.style }, c.render(r))));
      if (onRowClick) tr.addEventListener('click', (e) => { if (!e.target.closest('button,a,input,select')) onRowClick(r); });
      return tr;
    })))));
}

// ── Toasts ─────────────────────────────────────────────
let toastRoot;
export function toast(message, type = 'ok', { title, onClick, duration } = {}) {
  const screen = document.getElementById('screen');
  if (!toastRoot || !toastRoot.isConnected) { toastRoot = h('div', { class: 'toasts', 'aria-live': 'polite' }); screen.append(toastRoot); }
  const el = h('div', { class: `toast ${type}`, role: 'status' }, icon(type === 'ok' ? 'check' : type === 'warn' ? 'alert' : type === 'err' ? 'alert' : 'info'), h('div', { class: 'toast-text' }, title && h('div', { class: 'toast-title' }, title), message));
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  if (onClick) { el.classList.add('clickable'); el.addEventListener('click', () => { onClick(); dismiss(); }); }
  toastRoot.append(el);
  while (toastRoot.children.length > 5) toastRoot.firstChild.remove();
  setTimeout(dismiss, duration ?? (type === 'err' ? 6000 : 3500));
}

// ── Modals ─────────────────────────────────────────────
/** openModal({title, body, footer, wide}) → { close, el }. ESC und Klick auf den Hintergrund schließen. */
export function openModal({ title, body, footer, wide = false, onClose, locked = false }) {
  const prevFocus = document.activeElement;
  const root = h('div', { class: 'modal-root' });
  const close = () => {
    document.removeEventListener('keydown', onKey);
    root.remove();
    prevFocus?.focus?.();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (!locked) close(); } };
  const modal = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h3', null, title), !locked && button('', { variant: 'ghost', size: 'sm', icon: 'x', title: 'Schließen', onClick: close })),
    h('div', { class: 'modal-body' }, body),
    footer && h('div', { class: 'modal-foot' }, footer));
  root.append(modal);
  root.addEventListener('mousedown', (e) => { if (e.target === root && !locked) close(); });
  document.addEventListener('keydown', onKey);
  document.getElementById('screen').append(root);
  modal.querySelector('input,select,textarea,.modal-body button')?.focus();
  return { close, el: modal, root };
}

export function confirmDialog({ title, message, confirmLabel = 'Bestätigen', variant = 'danger', withReason = false }) {
  return new Promise((resolve) => {
    const reason = withReason ? h('textarea', { class: 'textarea', placeholder: 'Begründung (optional)', maxLength: 300 }) : null;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = openModal({
      title,
      body: h('div', { class: 'stack' }, h('p', { style: { color: 'var(--text-2)' } }, message), reason),
      footer: [
        button('Abbrechen', { onClick: () => { finish(null); m.close(); } }),
        button(confirmLabel, { variant, onClick: () => { finish({ reason: reason?.value.trim() ?? '' }); m.close(); } }),
      ],
      onClose: () => finish(null),
    });
  });
}
