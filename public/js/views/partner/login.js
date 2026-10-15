import { h } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, busy, field, input, formError } from '../../ui/kit.js';
import { api } from '../../api.js';
import { showLock, brandBlock } from '../../shell.js';

/** Zugangsbildschirm für externe Partner: Link öffnen → Code eingeben. */
export function showPartnerLogin({ token, onAuthed }) {
  const err = h('div');
  const code = input({ class: 'input code-input', inputmode: 'text', autocomplete: 'one-time-code', maxLength: 12, placeholder: '••••••', 'aria-label': 'Zugangscode', autofocus: true });
  const submit = button('Zugang öffnen', { variant: 'primary', type: 'submit', icon: 'unlock' });
  submit.classList.add('btn-block');
  const form = h('form', { novalidate: true }, err, field('Zugangscode', code, { help: 'Den Code hast du zusammen mit diesem Link erhalten.' }), submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.replaceChildren();
    await busy(submit, async () => {
      try {
        const { partner } = await api.post(`/api/p/${encodeURIComponent(token)}/login`, { code: code.value.trim() });
        onAuthed(partner);
      } catch (ex) { err.replaceChildren(formError(ex.message)); code.select(); }
    });
  });
  showLock(h('div', { class: 'lock-card' }, brandBlock(), h('h2', null, 'Gesicherter Zugang'),
    h('p', { class: 'lead' }, 'Gib deinen persönlichen Code ein, um fortzufahren.'), form));
  code.focus();
}

export function showInvalidLink() {
  showLock(h('div', { class: 'lock-card', style: { textAlign: 'center' } }, brandBlock(),
    h('div', { class: 'dot-icon', style: { width: '56px', height: '56px', borderRadius: '18px', margin: '0 auto 14px', background: 'rgba(248,113,113,.14)', color: 'var(--err)' } }, icon('lock')),
    h('h2', null, 'Link ungültig'), h('p', { class: 'lead' }, 'Dieser Link ist ungültig oder wurde deaktiviert. Bitte wende dich an die Person, die ihn dir gegeben hat.')));
}
