import { get, run, tx } from '../core/db.js';
import { bad, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { levelDetail, levelOfXp, levelThreshold, addXp, validLevels, DEFAULT_LEVELS } from '../core/levels.js';

/**
 * Level-System der externen Partner (Konfiguration, Anzeige, Admin-Korrektur). Die Vergabe der XP hängt an den abgeschlossenen Geschäften
 * (Börse, Kredit) – siehe core/levels.js. Aktivierung pro Partner im externen Zugang (Recht partners.manage), XP/Level ändern: partners.levels.
 */
const MODES = [{ value: 'auto', label: 'Automatisch (aus der Geschäftsgröße)' }, { value: 'fixed', label: 'Manuell (fester Wert)' }, { value: 'off', label: 'Keine XP' }];

export default {
  name: 'levels',
  permissions: [['partners.levels', 'Partner-Level: XP vergeben/abziehen, Level setzen oder entziehen (Admins)']],
  config: [
    { key: 'level.mode.buy', group: 'Level', label: 'XP: Börse – Partner liefert an uns', help: 'Automatisch = Basis + Anteil am Geschäftswert (siehe unten). Manuell = fester Wert (je Artikel überschreibbar im Katalog).', type: 'select', default: 'auto', options: MODES },
    { key: 'level.mode.sell', group: 'Level', label: 'XP: Börse – Partner kauft von uns', type: 'select', default: 'auto', options: MODES },
    { key: 'level.mode.credit', group: 'Level', label: 'XP: Kredit (vollständig zurückgezahlt)', type: 'select', default: 'auto', options: MODES },
    { key: 'level.auto_base', group: 'Level', label: 'Automatisch: Basis-XP je Geschäft', type: 'number', default: 10, min: 0, max: 100000 },
    { key: 'level.auto_per', group: 'Level', label: 'Automatisch: Geschäftswert je 1 XP', help: 'Je so viel Geschäftswert (in Währung) gibt es 1 zusätzliches XP. Höher = langsamerer Aufstieg.', type: 'number', default: 1000, min: 1, max: 100000000 },
    { key: 'level.auto_min', group: 'Level', label: 'Automatisch: Minimum XP je Geschäft', type: 'number', default: 5, min: 0, max: 100000 },
    { key: 'level.auto_max', group: 'Level', label: 'Automatisch: Maximum XP je Geschäft', type: 'number', default: 500, min: 0, max: 1000000 },
    { key: 'level.fixed.buy', group: 'Level', label: 'Manuell: XP – Partner liefert an uns', type: 'number', default: 25, min: 0, max: 1000000 },
    { key: 'level.fixed.sell', group: 'Level', label: 'Manuell: XP – Partner kauft von uns', type: 'number', default: 25, min: 0, max: 1000000 },
    { key: 'level.fixed.credit', group: 'Level', label: 'Manuell: XP – Kredit', type: 'number', default: 50, min: 0, max: 1000000 },
    { key: 'level.levels', group: 'Level', label: 'Level-Stufen', type: 'json', default: DEFAULT_LEVELS, hidden: true, validate: validLevels },
  ],
  routes(r) {
    r.get('/api/partners/:id/level', { perm: 'partners.view' }, (ctx) => {
      const id = Number(ctx.params.id);
      if (!get('SELECT 1 x FROM partners WHERE id = ?', id)) throw notFound('Zugang nicht gefunden.');
      return { level: levelDetail(id, { history: 100 }), canAdjust: ctx.user.perms.has('partners.levels') };
    });

    r.post('/api/partners/:id/level/adjust', { perm: 'partners.levels' }, (ctx) => {
      const id = Number(ctx.params.id), b = ctx.body;
      const p = get('SELECT id, partner_number, name, level_enabled, level_xp FROM partners WHERE id = ?', id);
      if (!p) throw notFound('Zugang nicht gefunden.');
      if (!p.level_enabled) throw bad('Das Level-System ist für diesen Zugang nicht aktiviert.');
      const reason = str(b.reason, 'Begründung', { min: 3, max: 200 });
      let delta;
      if (b.action === 'add') { if (!Number.isInteger(b.amount) || b.amount === 0 || Math.abs(b.amount) > 10_000_000) throw bad('Menge: ganze Zahl ungleich 0 (negativ zum Abziehen).'); delta = b.amount; }
      else if (b.action === 'set_level') { if (!Number.isInteger(b.level) || b.level < 1 || b.level > 10) throw bad('Level: 1 bis 10.'); delta = levelThreshold(b.level) - p.level_xp; }
      else if (b.action === 'reset') delta = -p.level_xp;
      else throw bad('Unbekannte Aktion.');
      const res = tx(() => addXp(id, delta, { kind: 'admin', note: reason, userId: ctx.user.id }));
      audit(ctx, { action: 'partner.level_adjusted', module: 'partners', targetType: 'partner', targetId: id, targetLabel: `${p.partner_number} · ${p.name}`,
        before: { xp: p.level_xp, level: levelOfXp(p.level_xp).n }, after: { xp: get('SELECT level_xp x FROM partners WHERE id = ?', id).x, reason, action: b.action } });
      return { level: levelDetail(id, { history: 100 }), changed: !!res };
    });

    // Partner: nur das eigene Level
    r.get('/api/p/level', { auth: 'partner' }, (ctx) => ({ level: levelDetail(ctx.partner.id, { history: 30 }) }));
  },
};
