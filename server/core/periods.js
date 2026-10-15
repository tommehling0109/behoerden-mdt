/**
 * Abrechnungszeiträume für das Deckel-System.
 *   wöchentlich → ISO-Kalenderwoche, Schlüssel „2026-W41“, Beschriftung „KW 41 / 2026“
 *   monatlich   → Kalendermonat,     Schlüssel „2026-10“,  Beschriftung „Oktober 2026“
 * Gerechnet wird in der Zeitzone des Servers (Umgebungsvariable TZ).
 */
const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  return { year, week: Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7) };
}
const weekStart = (year, week) => {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday1 = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86400000);
  return new Date(monday1.getTime() + (week - 1) * 7 * 86400000);
};

export function periodKey(date, interval) {
  if (interval === 'weekly') { const { year, week } = isoWeek(date); return `${year}-W${pad(week)}`; }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

/** { key, label, from, to } (from/to als YYYY-MM-DD, inklusive) oder null bei ungültigem Schlüssel */
export function periodInfo(key) {
  let m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (m) {
    const year = Number(m[1]), week = Number(m[2]);
    if (week < 1 || week > 53) return null;
    const start = weekStart(year, week);
    return { key, label: `KW ${week} / ${year}`, from: isoDay(start), to: isoDay(new Date(start.getTime() + 6 * 86400000)), interval: 'weekly' };
  }
  m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) {
    const year = Number(m[1]), month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { key, label: `${MONTHS[month - 1]} ${year}`, from: `${year}-${pad(month)}-01`, to: isoDay(new Date(Date.UTC(year, month, 0))), interval: 'monthly' };
  }
  return null;
}

/** Die letzten `count` Zeiträume (neuester zuerst); der laufende nur mit includeCurrent. */
export function recentPeriods(interval, { count = 12, includeCurrent = false, now = new Date() } = {}) {
  const out = [];
  const cur = periodKey(now, interval);
  let d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let guard = 0;
  while (out.length < count + 1 && guard++ < 400) {
    const k = periodKey(d, interval);
    if (!out.includes(k)) out.push(k);
    d = interval === 'weekly' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7) : new Date(d.getFullYear(), d.getMonth() - 1, 1);
  }
  return out.filter((k) => includeCurrent || k !== cur).slice(0, count).map(periodInfo);
}
