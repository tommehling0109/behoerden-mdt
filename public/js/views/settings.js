import { h } from '../ui/dom.js';
import { button, field, select, toggle, openModal } from '../ui/kit.js';
import { TONES, getSetting, setSetting, playSound, playAnnounce } from '../notifier.js';

/** Persönliche Einstellungen dieses Geräts (Ton, Lautstärke, Hinweise) – für Mitarbeiter und externe Zugänge gleich. Gespeichert im Browser. */
export function openSettingsDialog() {
  const vol = h('input', { type: 'range', min: 0, max: 100, step: 1, value: getSetting('volume'), class: 'range', 'aria-label': 'Lautstärke' });
  const volLabel = h('span', { class: 'range-val' }, `${getSetting('volume')} %`);
  const tone = select(TONES.map(([value, label]) => ({ value, label })), getSetting('tone'));
  const icons = select([{ value: 'default', label: 'Wie voreingestellt (Administrator)' }, { value: 'on', label: 'Immer anzeigen' }, { value: 'off', label: 'Ausblenden' }], getSetting('icons'));
  icons.addEventListener('change', () => setSetting('icons', icons.value));
  const preview = () => playSound(true, { tone: tone.value, volume: Number(vol.value) });
  vol.addEventListener('input', () => { volLabel.textContent = `${vol.value} %`; });
  vol.addEventListener('change', () => { setSetting('volume', Number(vol.value)); preview(); });
  tone.addEventListener('change', () => { setSetting('tone', tone.value); preview(); });
  const m = openModal({
    title: 'Einstellungen',
    body: h('div', null,
      h('p', { class: 'muted' }, 'Diese Einstellungen gelten nur für dieses Gerät und diesen Browser.'),
      h('div', { class: 'sep' }), h('h4', null, 'Benachrichtigungen'),
      toggle('Ton bei neuer Benachrichtigung', getSetting('sound'), (v) => setSetting('sound', v)),
      toggle('Hinweise als Pop-up im System', getSetting('popup'), (v) => setSetting('popup', v)),
      h('div', { style: { height: '10px' } }),
      field('Lautstärke', h('div', { class: 'row', style: { flexWrap: 'nowrap', alignItems: 'center' } }, vol, volLabel), { help: '0 % = stumm. Beim Loslassen hörst du eine Vorschau.' }),
      field('Benachrichtigungston', tone, { help: 'Beim Auswählen wird der Ton vorgespielt.' }),
      h('div', { class: 'row' }, button('Ton testen', { icon: 'bell', onClick: preview }), button('Neuigkeiten-Ton testen', { icon: 'flag', onClick: () => playAnnounce(true) })),
      h('div', { class: 'help', style: { margin: '6px 0 0' } }, 'Neuigkeiten (Changelog, Schwarzes Brett) haben einen eigenen, festen Ton, damit du sie von Nachrichten unterscheiden kannst.'),
      h('div', { class: 'sep' }), h('h4', null, 'Desktop'),
      field('Symbole auf dem Desktop', icons, { help: 'Zeigt die Apps zusätzlich zum Dock als Symbole auf dem Desktop. „Wie voreingestellt“ folgt der Einstellung des Administrators. Symbole lassen sich frei verschieben und weichen dem Schwarzen Brett und dem Changelog aus.' })),
    footer: [button('Fertig', { variant: 'primary', onClick: () => m.close() })],
  });
}
