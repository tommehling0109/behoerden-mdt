import { h, mount, fmtDateTime } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, busy, field, input, formError, openModal, confirmDialog, toast } from '../../ui/kit.js';
import { api } from '../../api.js';
import { readFile } from './partners.js';

/**
 * Weitere Dateien (eigene Dokumente mit Name und Beschreibung) zu Mitgliedern und externen Zugängen.
 *  - extraFilesBox: Liste an einem bestehenden Eintrag (ansehen, umbenennen, entfernen, hinzufügen)
 *  - extraFilesPicker: Sammelstelle in „Anlegen“-Dialogen; die Dateien werden nach dem Anlegen hochgeladen
 */
const ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp';
const sizeText = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** Dialog „Datei hinzufügen“ bzw. „Datei bearbeiten“ (ohne Dateiauswahl). */
function fileDialog({ title, name = '', description = '', withFile = true, onSubmit }) {
  const err = h('div'), n = input({ value: name, maxLength: 80, placeholder: 'z. B. Mietvertrag, Vollmacht, Zeugenaussage' }), d = h('textarea', { class: 'textarea', maxLength: 300, placeholder: 'Worum geht es? (optional)' }, description);
  const f = h('input', { type: 'file', accept: ACCEPT });
  const m = openModal({
    title, body: h('div', null, err, field('Name *', n), field('Beschreibung', d), withFile && field('Datei *', f, { help: 'PDF, PNG, JPG oder WebP, max. 5 MB.' })),
    footer: [h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }), button('Speichern', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      try {
        if (n.value.trim().length < 2) throw new Error('Bitte einen Namen angeben.');
        if (withFile && !f.files[0]) throw new Error('Bitte eine Datei auswählen.');
        await onSubmit({ name: n.value.trim(), description: d.value.trim(), file: f.files[0] ?? null });
        m.close();
      } catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) })],
  });
}

export function extraFilesBox({ type, id }) {
  const host = h('div');
  let state = { files: [], canEdit: false };
  const draw = () => mount(host,
    h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' } }, h('div', { class: 'label' }, 'Weitere Dateien'),
      state.canEdit && button('Datei hinzufügen', { size: 'sm', icon: 'plus', onClick: () => fileDialog({ title: 'Datei hinzufügen', onSubmit: async ({ name, description, file }) => { await api.post(`/api/extra-files/${type}/${id}`, { name, description, data: await readFile(file, 5) }); toast('Datei gespeichert.'); await load(); } }) })),
    state.files.length ? state.files.map((f) => h('div', { class: 'list-row' },
      h('div', { class: 'dot-icon' }, icon('list')),
      h('div', { class: 'grow' }, h('div', { class: 't', style: { whiteSpace: 'normal' } }, f.name), h('div', { class: 's' }, [f.description, `${f.ext.toUpperCase()} · ${sizeText(f.size)} · ${fmtDateTime(f.createdAt)}`].filter(Boolean).join(' · '))),
      h('a', { class: 'btn btn-sm', href: `/api/extra-file/${f.id}`, target: '_blank', rel: 'noopener' }, icon('search'), 'Ansehen'),
      state.canEdit && button('', { size: 'sm', variant: 'ghost', icon: 'edit', title: 'Name/Beschreibung ändern', onClick: () => fileDialog({ title: 'Datei bearbeiten', name: f.name, description: f.description, withFile: false, onSubmit: async ({ name, description }) => { await api.patch(`/api/extra-file/${f.id}`, { name, description }); await load(); } }) }),
      state.canEdit && button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Datei entfernen', onClick: async () => {
        if (!await confirmDialog({ title: 'Datei entfernen?', message: `„${f.name}“ wird gelöscht.`, confirmLabel: 'Entfernen' })) return;
        try { await api.del(`/api/extra-file/${f.id}`); await load(); } catch (ex) { toast(ex.message, 'err'); }
      } }))) : h('div', { class: 'muted', style: { fontSize: '13px' } }, 'Noch keine weiteren Dateien.'));
  async function load() { try { state = await api.get(`/api/extra-files/${type}/${id}`); draw(); } catch (ex) { mount(host, h('div', { class: 'muted' }, ex.message)); } }
  mount(host, h('div', { class: 'muted' }, 'Lade …'));
  load();
  return host;
}

export function extraFilesPicker() {
  const queue = [], host = h('div');
  const draw = () => mount(host,
    h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' } }, h('div', { class: 'label' }, 'Weitere Dateien (optional)'),
      button('Datei hinzufügen', { size: 'sm', icon: 'plus', onClick: () => fileDialog({ title: 'Datei hinzufügen', onSubmit: async (v) => { queue.push(v); draw(); } }) })),
    queue.length ? queue.map((q, i) => h('div', { class: 'list-row' }, h('div', { class: 'dot-icon' }, icon('list')),
      h('div', { class: 'grow' }, h('div', { class: 't' }, q.name), h('div', { class: 's' }, [q.description, q.file.name].filter(Boolean).join(' · '))),
      button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Entfernen', onClick: () => { queue.splice(i, 1); draw(); } })))
      : h('div', { class: 'muted', style: { fontSize: '13px' } }, 'Eigene Dokumente mit Name und Beschreibung, z. B. Vollmacht oder Vertrag.'));
  draw();
  return {
    el: host, count: () => queue.length,
    /** Lädt die gesammelten Dateien zum frisch angelegten Eintrag hoch; liefert die Namen der fehlgeschlagenen. */
    async upload(type, id) {
      const failed = [];
      for (const q of queue) { try { await api.post(`/api/extra-files/${type}/${id}`, { name: q.name, description: q.description, data: await readFile(q.file, 5) }); } catch { failed.push(q.name); } }
      return failed;
    },
  };
}
