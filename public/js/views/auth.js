import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, field, input, formError, avatar } from '../ui/kit.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { showLock, brandBlock } from '../shell.js';

/** Baut ein Formular mit Fehleranzeige und Submit-Handler. */
function form(fields, submitLabel, onSubmit, extra) {
  const err = h('div');
  const submit = button(submitLabel, { variant: 'primary', type: 'submit', size: 'block' });
  submit.classList.add('btn-block');
  const f = h('form', { novalidate: true }, err, fields, submit, extra);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.replaceChildren();
    await busy(submit, async () => {
      try { await onSubmit(); } catch (ex) { err.replaceChildren(formError(ex.message)); }
    });
  });
  return f;
}
const val = (el) => el.value.trim();

export function showLogin({ onAuthed, goRegister }) {
  const u = input({ name: 'username', autocomplete: 'username', placeholder: 'Benutzername', autofocus: true });
  const p = input({ name: 'password', type: 'password', autocomplete: 'current-password', placeholder: '••••••••' });
  const f = form([field('Benutzername', u), field('Passwort', p)], 'Anmelden', async () => {
    const { user } = await api.post('/api/auth/login', { username: val(u), password: p.value });
    onAuthed(user);
  });
  showLock(h('div', { class: 'lock-card' }, brandBlock(),
    h('h2', null, 'Anmelden'), h('p', { class: 'lead' }, 'Melde dich mit deinem Zugang an, um das Terminal zu verwenden.'), f,
    state.config['auth.registration_enabled'] && h('div', { class: 'lock-links' }, 'Noch kein Zugang?', h('button', { class: 'link-btn', onclick: goRegister }, 'Zugang beantragen'))));
  u.focus();
}

export function showRegister({ onAuthed, goLogin }) {
  const dn = input({ name: 'displayName', placeholder: 'Wie sollen wir dich nennen?', maxLength: 60 });
  const u = input({ name: 'username', autocomplete: 'username', placeholder: 'Benutzername', maxLength: 32 });
  const p = input({ name: 'password', type: 'password', autocomplete: 'new-password', placeholder: 'Mindestens 8 Zeichen' });
  const f = form([field('Anzeigename', dn), field('Benutzername', u, { help: 'Buchstaben, Zahlen sowie . _ -' }), field('Passwort', p)], 'Zugang beantragen', async () => {
    const { user } = await api.post('/api/auth/register', { displayName: val(dn), username: val(u), password: p.value });
    onAuthed(user);
  });
  showLock(h('div', { class: 'lock-card' }, brandBlock(),
    h('h2', null, 'Zugang beantragen'), h('p', { class: 'lead' }, 'Nach dem Absenden prüft ein Administrator deinen Antrag und schaltet dich frei.'), f,
    h('div', { class: 'lock-links' }, 'Bereits freigeschaltet?', h('button', { class: 'link-btn', onclick: goLogin }, 'Anmelden'))));
  dn.focus();
}

/** Erst-Einrichtung (nur solange noch kein Benutzer existiert). */
export function showSetup({ onAuthed }) {
  const sn = input({ name: 'systemName', placeholder: 'z. B. Einsatz-Terminal', maxLength: 40 });
  const dn = input({ name: 'displayName', placeholder: 'Anzeigename', maxLength: 60 });
  const u = input({ name: 'username', autocomplete: 'username', placeholder: 'Benutzername', maxLength: 32 });
  const p = input({ name: 'password', type: 'password', autocomplete: 'new-password', placeholder: 'Mindestens 8 Zeichen' });
  const f = form([
    field('Systemname', sn, { help: 'Später jederzeit in der Konfiguration änderbar.' }),
    h('div', { class: 'form-row' }, field('Anzeigename', dn), field('Benutzername', u)),
    field('Passwort', p),
  ], 'System einrichten', async () => {
    const { user } = await api.post('/api/setup', {
      systemName: val(sn), displayName: val(dn), username: val(u), password: p.value,
    });
    onAuthed(user, true);
  });
  showLock(h('div', { class: 'lock-card' }, brandBlock(),
    h('h2', null, 'Willkommen – Ersteinrichtung'),
    h('p', { class: 'lead' }, 'Lege den Superadmin an – die feste Rolle mit vollem Zugriff. Alles Weitere (Rollen, Rechte, Darstellung) konfigurierst du danach im Admin-Bereich.'), f));
  sn.focus();
}

/** Status „Zugriff ausstehend“ – Benutzer ist angemeldet, hat aber noch keinen Zugriff. */
export function showPending({ user, onRefresh, onLogout }) {
  const spinner = h('div', { class: 'dot-icon', style: { width: '56px', height: '56px', borderRadius: '18px', margin: '0 auto 14px', background: 'rgba(251,191,36,.14)', color: 'var(--warn)' } }, icon('hourglass'));
  spinner.firstChild.style.cssText = 'width:26px;height:26px';
  showLock(h('div', { class: 'lock-card', style: { textAlign: 'center' } }, brandBlock(), spinner,
    h('h2', null, 'Zugriff ausstehend'),
    h('p', { class: 'lead' }, `Hallo ${user.displayName}, dein Zugang wurde angelegt, muss aber noch von einem Administrator freigeschaltet werden.`),
    h('div', { class: 'row', style: { justifyContent: 'center' } },
      button('Status prüfen', { variant: 'primary', icon: 'refresh', onClick: (e) => busy(e.currentTarget, onRefresh) }),
      button('Abmelden', { icon: 'logout', onClick: onLogout }))));
}
