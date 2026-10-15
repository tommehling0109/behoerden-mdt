/**
 * (Kopie von server/core/credit-calc.js – bitte beide gleich halten.)
 * Kreditberechnung – einfache Zinsen auf die ursprüngliche Kreditsumme (transparent und nachrechenbar):
 *   Laufzeit in Tagen = Anzahl Raten × (wöchentlich 7 | monatlich 30)
 *   Zinsen gesamt     = Summe × Zinssatz × (Laufzeit in Tagen ÷ Tage je Zins-Einheit)   (Tag = 1, Woche = 7, Monat = 30)
 * Die Raten sind gleich hoch; Rundungsreste landen in der letzten Rate. Beträge in Cent, Zinssatz in Basispunkten (250 = 2,5 %).
 * Diese Datei existiert identisch im Frontend (public/js/credit-calc.js).
 */
export const FREQ_DAYS = { weekly: 7, monthly: 30 };
export const UNIT_DAYS = { day: 1, week: 7, month: 30 };

export function calcLoan({ principal, count, frequency, type = 'none', rateBp = 0, ratePeriod = 'week' }) {
  const days = count * (FREQ_DAYS[frequency] ?? 30);
  const interest = type === 'flat' ? Math.round(principal * (rateBp / 10000) * (days / (UNIT_DAYS[ratePeriod] ?? 7))) : 0;
  const total = principal + interest;
  return { days, interest, total, installment: Math.round(total / count) };
}

/** Beträge je Rate: [{ principal, interest, amount }] – Summe stimmt exakt mit Kreditsumme/Zinsen überein. */
export function splitInstallments({ principal, interest, count }) {
  const bp = Math.floor(principal / count), bi = Math.floor(interest / count);
  return Array.from({ length: count }, (_, i) => {
    const last = i === count - 1;
    const p = last ? principal - bp * (count - 1) : bp, n = last ? interest - bi * (count - 1) : bi;
    return { principal: p, interest: n, amount: p + n };
  });
}

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Fälligkeitsdaten (YYYY-MM-DD): wöchentlich = +7 Tage je Rate, monatlich = gleicher Tag im Folgemonat (am Monatsende gekürzt). */
export function dueDates(startDate, count, frequency) {
  const [y, m, d] = startDate.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    if (frequency === 'weekly') return fmt(new Date(y, m - 1, d + 7 * (i + 1)));
    const first = new Date(y, m - 1 + (i + 1), 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return fmt(new Date(first.getFullYear(), first.getMonth(), Math.min(d, last)));
  });
}

export const RATE_PERIODS = { day: 'Tag', week: 'Woche', month: 'Monat' };
export const rateText = (type, rateBp, ratePeriod) => (type === 'flat' ? `${(rateBp / 100).toLocaleString('de-DE', { maximumFractionDigits: 2 })} % pro ${RATE_PERIODS[ratePeriod] ?? 'Woche'}` : 'Zinsfrei');
