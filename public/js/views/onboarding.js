import { h, mount, timeAgo, fmtDateTime } from '../ui/dom.js';
import { button, busy, field, input, select, tabs, rankBadge, formError, openModal, confirmDialog, toast, empty, badge, note, skeletons } from '../ui/kit.js';
import { api } from '../api.js';

/**
 * Einarbeitung (Führung): Fortschritt der neuen Mitglieder an der Checkliste – Schritte bestätigen, Einarbeitung starten oder beenden – und
 * (mit „onboarding.manage“) die Schritte der Checkliste selbst anlegen, ändern und ordnen.
 */
export default async function render(container, ctx) {
  let data = null, tab = 'running';
  const tabHost = h('div', { style: { marginBottom: '12px' } }), host = h('div');
  mount(container, tabHost, host); mount(host, skeletons(3, 100));

  const load = async () => { data = await api.get('/api/onboarding'); if (ctx.isCurrent()) draw(); };
  const act = (fn) => async () => { try { await fn(); await load(); } catch (e) { toast(e.message, 'err'); } };

  function drawTabs() {
    const running = data.rows.filter((r) => !r.completedAt).length, done = data.rows.length - running;
    mount(tabHost, tabs([{ id: 'running', label: 'Laufend', count: running }, { id: 'done', label: 'Abgeschlossen', count: done },
      ...(data.canManage ? [{ id: 'steps', label: 'Schritte', count: data.steps.length }] : [])], tab, (id) => { tab = id; draw(); }));
  }

  function memberCard(r) {
    const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
    return h('section', { class: 'card ob-card' },
      h('div', { class: 'card-head' }, h('span', { class: 'member-no' }, r.label), r.rank && rankBadge(r.rank), r.completedAt ? badge(r.skipped ? 'Beendet' : 'Abgeschlossen', 'b-ok') : badge('Läuft', 'b-info'),
        h('span', { class: 'grow' }), h('span', { class: 'muted', style: { fontSize: '12px' } }, `gestartet ${timeAgo(r.startedAt)}`)),
      h('div', { class: 'card-body' },
        h('div', { class: 'ob-bar' }, h('i', { style: { width: pct + '%' } })), h('div', { class: 'muted', style: { fontSize: '12px', margin: '6px 0 8px' } }, `${r.done} von ${r.total} Schritten erledigt`),
        r.steps.map((s) => h('label', { class: `ob-step ${s.done ? 'done' : ''}` },
          h('input', { type: 'checkbox', checked: s.done, disabled: !!r.completedAt && r.skipped, onchange: async (e) => { try { await api.post(`/api/onboarding/${r.userId}/steps/${s.id}`, { done: e.target.checked }); await load(); } catch (ex) { toast(ex.message, 'err'); e.target.checked = s.done; } } }),
          h('div', { class: 'grow' }, h('div', { class: 't' }, s.title, ' ', badge(s.confirmBy === 'self' ? 'Mitglied' : 'Führung', s.confirmBy === 'self' ? 'b-mute' : 'b-info', false)), s.description && h('div', { class: 's' }, s.description),
            s.done && h('div', { class: 's' }, `Erledigt ${fmtDateTime(s.doneAt)}${s.doneBy ? ` · ${s.doneBy}` : ''}`)))),
        data.canCheck && h('div', { class: 'row', style: { marginTop: '10px', gap: '8px' } },
          !r.completedAt && button('Einarbeitung beenden', { size: 'sm', icon: 'check', onClick: act(async () => { if (await confirmDialog({ title: 'Einarbeitung beenden?', message: `Die Einarbeitung von ${r.label} gilt als abgeschlossen, auch wenn Schritte offen sind.`, confirmLabel: 'Beenden', variant: 'primary' })) await api.post(`/api/onboarding/${r.userId}/finish`); }) }),
          button('Entfernen', { size: 'sm', variant: 'ghost', icon: 'trash', onClick: act(async () => { if (await confirmDialog({ title: 'Aus der Einarbeitung nehmen?', message: `Der Fortschritt von ${r.label} wird gelöscht.`, confirmLabel: 'Entfernen' })) await api.del(`/api/onboarding/${r.userId}`); }) }))));
  }

  function stepDialog(s) {
    const err = h('div'), title = input({ maxLength: 120, value: s?.title ?? '', placeholder: 'z. B. Probeauftrag erledigt' }), desc = h('textarea', { class: 'textarea', rows: 3, maxLength: 400, placeholder: 'Was ist zu tun? (optional)' }, s?.description ?? '');
    const by = select([{ value: 'leader', label: 'Führung bestätigt' }, { value: 'self', label: 'Das Mitglied hakt selbst ab' }], s?.confirmBy ?? 'leader');
    const save = button(s ? 'Speichern' : 'Anlegen', { variant: 'primary', icon: 'check', onClick: () => busy(save, async () => {
      err.replaceChildren();
      try { const body = { title: title.value, description: desc.value, confirmBy: by.value }; if (s) await api.patch(`/api/onboarding/steps/${s.id}`, body); else await api.post('/api/onboarding/steps', body); m.close(); toast('Gespeichert.'); await load(); }
      catch (e) { err.replaceChildren(formError(e.message)); }
    }) });
    const m = openModal({ title: s ? 'Schritt bearbeiten' : 'Neuer Schritt', body: h('div', { class: 'stack' }, err, field('Titel *', title), field('Beschreibung', desc), field('Wer bestätigt?', by, { help: 'Schritte der Führung kann das Mitglied nicht selbst abhaken – und die Führung nicht für sich selbst.' })), footer: [button('Abbrechen', { onClick: () => m.close() }), save] });
  }
  function stepsView() {
    ctx.setActions(button('Schritt hinzufügen', { variant: 'primary', icon: 'plus', onClick: () => stepDialog(null) }));
    mount(host, note('Diese Checkliste bekommt jedes neu freigeschaltete Mitglied automatisch. Änderungen gelten sofort auch für laufende Einarbeitungen. Schritte lassen sich auch ausblenden, ohne sie zu löschen.', 'info'), h('div', { style: { height: '12px' } }),
      h('div', { class: 'card' }, h('div', { class: 'card-body flush' }, data.steps.length ? data.steps.map((s, i) => h('div', { class: `list-row ${s.isActive ? '' : 'ob-off'}` },
        h('span', { class: 'member-no' }, i + 1), h('div', { class: 'grow' }, h('div', { class: 't' }, s.title, ' ', badge(s.confirmLabel, s.confirmBy === 'self' ? 'b-mute' : 'b-info', false), !s.isActive && badge('ausgeblendet', 'b-warn', false)), s.description && h('div', { class: 's' }, s.description)),
        h('div', { class: 'actions' },
          button('', { size: 'sm', icon: 'chevronU', title: 'Nach oben', disabled: i === 0, onClick: act(() => api.post(`/api/onboarding/steps/${s.id}/move`, { dir: 'up' })) }),
          button('', { size: 'sm', icon: 'chevronD', title: 'Nach unten', disabled: i === data.steps.length - 1, onClick: act(() => api.post(`/api/onboarding/steps/${s.id}/move`, { dir: 'down' })) }),
          button(s.isActive ? 'Ausblenden' : 'Einblenden', { size: 'sm', onClick: act(() => api.patch(`/api/onboarding/steps/${s.id}`, { isActive: !s.isActive })) }),
          button('Bearbeiten', { size: 'sm', icon: 'edit', onClick: () => stepDialog(s) }),
          button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Löschen', onClick: act(async () => { if (await confirmDialog({ title: 'Schritt löschen?', message: `„${s.title}“ wird aus der Checkliste und allen Fortschritten entfernt.`, confirmLabel: 'Löschen' })) await api.del(`/api/onboarding/steps/${s.id}`); }) })))) : empty('Noch keine Schritte', 'Lege die Schritte der Checkliste an.', 'list'))));
  }

  function addMember() {
    const sel = select([{ value: '', label: '— Mitglied wählen —' }, ...data.candidates.map((c) => ({ value: c.id, label: c.label }))], '');
    const m = openModal({ title: 'Mitglied in die Einarbeitung aufnehmen', body: h('div', { class: 'stack' }, note('Neue Mitglieder starten automatisch. Hier nimmst du ein bestehendes Mitglied nachträglich auf.', 'info'), field('Mitglied', sel)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Starten', { variant: 'primary', onClick: async () => { if (!sel.value) return; try { await api.post(`/api/onboarding/${sel.value}/start`); m.close(); tab = 'running'; await load(); } catch (e) { toast(e.message, 'err'); } } })] });
  }

  function draw() {
    drawTabs();
    if (tab === 'steps') return stepsView();
    ctx.setActions(data.canCheck ? button('Mitglied aufnehmen', { icon: 'userPlus', onClick: addMember }) : null);
    const rows = data.rows.filter((r) => (tab === 'running') === !r.completedAt);
    mount(host, !data.enabled && note('Die Einarbeitung neuer Mitglieder ist in der Konfiguration ausgeschaltet – neue Mitglieder starten nicht automatisch.', 'alert'),
      rows.length ? h('div', { class: 'stack-v' }, rows.map(memberCard)) : empty(tab === 'running' ? 'Niemand in der Einarbeitung' : 'Noch keine abgeschlossenen Einarbeitungen', tab === 'running' ? 'Neu freigeschaltete Mitglieder erscheinen hier automatisch.' : null, 'userCheck'));
  }
  ctx.live(['onboarding', 'users'], () => load().catch(() => {}), { wait: 800 });
  try { await load(); } catch (e) { mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
}
