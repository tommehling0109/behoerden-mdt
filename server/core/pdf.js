/**
 * Minimaler PDF-Schreiber ohne Abhängigkeiten (Helvetica, A4): Titelseite, Überschriften, Absätze, Aufzählungen, nummerierte Schritte und Hinweiskästen
 * mit Zeilenumbruch und Seitenzahlen. Texte werden nach Windows-1252 (WinAnsi) kodiert, damit Umlaute stimmen.
 * Blöcke: { t: 'h1'|'h2'|'h3'|'p'|'li'|'step'|'note', text, n?, label? }
 */
const W = 595.28, H = 841.89, M = 56;
const BASE = { 32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191, 40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278, 58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556, 64: 1015,
  65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778, 72: 722, 73: 278, 74: 500, 75: 667, 76: 556, 77: 833, 78: 722, 79: 778, 80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944, 88: 667, 89: 667, 90: 611,
  91: 278, 92: 278, 93: 278, 94: 469, 95: 556, 96: 333, 97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278, 103: 556, 104: 556, 105: 222, 106: 222, 107: 500, 108: 222, 109: 833, 110: 556, 111: 556, 112: 556, 113: 556, 114: 333, 115: 500, 116: 278, 117: 556, 118: 500, 119: 722, 120: 500, 121: 500, 122: 500, 123: 334, 124: 260, 125: 334, 126: 584 };
for (let c = 48; c <= 57; c++) BASE[c] = 556;
const WIN = { 0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x201e: 0x84, 0x2022: 0x95, 0x2026: 0x85, 0x20ac: 0x80 };
const REPL = { '→': '->', '←': '<-', '✓': 'OK', '×': 'x', ' ': ' ' };

/** Text → Windows-1252-Bytes (nicht darstellbare Zeichen werden zu „?“). */
function enc(s) {
  const out = [];
  for (const ch of String(s).replace(/[→←✓× ]/g, (m) => REPL[m])) {
    const c = ch.codePointAt(0);
    if (c === 9) out.push(32);
    else if (c >= 32 && c < 127) out.push(c);
    else if (WIN[c]) out.push(WIN[c]);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else if (c !== 10 && c !== 13) out.push(63);
  }
  return out;
}
const widthOf = (bytes, size, bold) => bytes.reduce((a, c) => a + (BASE[c] ?? 556), 0) * size / 1000 * (bold ? 1.06 : 1);
const esc = (bytes) => { const o = []; for (const c of bytes) { if (c === 40 || c === 41 || c === 92) o.push(92); o.push(c); } return Buffer.from(o); };
const strip = (t) => String(t).replace(/\*\*(.+?)\*\*/g, '$1');

function wrap(text, size, maxW, bold) {
  const lines = [];
  for (const para of strip(text).split('\n')) {
    let cur = [];
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const w = enc(word), tryLine = cur.length ? [...cur, 32, ...w] : w;
      if (cur.length && widthOf(tryLine, size, bold) > maxW) { lines.push(cur); cur = w; } else cur = tryLine;
      while (widthOf(cur, size, bold) > maxW && cur.length > 1) { // sehr lange Wörter hart trennen
        let i = cur.length - 1; while (i > 1 && widthOf(cur.slice(0, i), size, bold) > maxW) i--;
        lines.push(cur.slice(0, i)); cur = cur.slice(i);
      }
    }
    lines.push(cur);
  }
  return lines;
}

export function buildPdf({ title, subtitle = '', blocks }) {
  const pages = []; // je Seite: Array von Buffer-Teilen
  let cur = null, y = 0, pageNo = 0;
  const newPage = (cover = false) => {
    cur = []; pages.push(cur); pageNo = pages.length; y = H - M;
    if (!cover) {
      put(`BT /F1 8 Tf 0.5 0.5 0.55 rg ${M} ${H - 30} Td (`, enc(title), ') Tj ET\n');
      put(`BT /F1 8 Tf 0.5 0.5 0.55 rg ${W - M - 40} 28 Td (Seite ${pageNo}) Tj ET\n`);
      put(`0.85 0.86 0.9 RG 0.5 w ${M} ${H - 36} m ${W - M} ${H - 36} l S\n`);
      y = H - M - 12;
    }
  };
  const put = (...parts) => { for (const p of parts) cur.push(typeof p === 'string' ? Buffer.from(p, 'latin1') : esc(p)); };
  const text = (bytes, x, yy, size, bold, rgb = '0.1 0.1 0.15') => put(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb} rg ${x.toFixed(2)} ${yy.toFixed(2)} Td (`, bytes, ') Tj ET\n');
  const ensure = (h) => { if (y - h < M + 14) newPage(); };

  // Titelseite
  newPage(true);
  put(`0.2 0.4 0.85 rg ${M} ${H - 250} 6 90 re f\n`);
  for (const [i, l] of wrap(title, 30, W - 2 * M - 24, true).entries()) text(l, M + 20, H - 190 - i * 36, 30, true);
  for (const [i, l] of wrap(subtitle, 13, W - 2 * M - 24, false).entries()) text(l, M + 20, H - 250 - i * 18, 13, false, '0.35 0.37 0.45');
  text(enc(`Stand: ${new Date().toLocaleDateString('de-DE')}`), M + 20, H - 330, 10, false, '0.5 0.5 0.55');
  newPage();

  for (const b of blocks) {
    const bold = b.t === 'h1' || b.t === 'h2' || b.t === 'h3';
    if (b.t === 'h1') { if (y < H - M - 40) newPage(); ensure(60); text(enc(strip(b.text)), M, y - 20, 22, true, '0.12 0.27 0.65'); y -= 40; put(`0.2 0.4 0.85 RG 1.2 w ${M} ${y + 8} m ${M + 60} ${y + 8} l S\n`); y -= 10; continue; }
    if (b.t === 'h2') { ensure(60); y -= 8; for (const l of wrap(b.text, 16, W - 2 * M, true)) { text(l, M, y - 14, 16, true); y -= 20; } y -= 4; continue; }
    if (b.t === 'h3') { ensure(40); y -= 6; for (const l of wrap(b.text, 12, W - 2 * M, true)) { text(l, M, y - 11, 12, true, '0.2 0.25 0.4'); y -= 16; } y -= 2; continue; }
    const size = 10.5, lead = 15;
    const indent = b.t === 'li' || b.t === 'step' ? 20 : b.t === 'note' ? 14 : 0;
    const lines = wrap(b.t === 'note' ? b.text : b.text, size, W - 2 * M - indent - (b.t === 'note' ? 14 : 0), bold);
    if (b.t === 'note') {
      const h = lines.length * lead + 12 + 14; ensure(Math.min(h, 120));
      let i = 0;
      while (i < lines.length) {
        const room = Math.max(1, Math.floor((y - (M + 14) - 26) / lead)), chunk = lines.slice(i, i + room), hh = chunk.length * lead + 12 + (i === 0 ? 14 : 0);
        put(`0.93 0.95 1 rg ${M} ${(y - hh).toFixed(2)} ${W - 2 * M} ${hh.toFixed(2)} re f 0.2 0.4 0.85 rg ${M} ${(y - hh).toFixed(2)} 3 ${hh.toFixed(2)} re f\n`);
        let yy = y - 8;
        if (i === 0) { text(enc(b.label ?? 'Hinweis'), M + 12, yy - 9, 9, true, '0.12 0.27 0.65'); yy -= 14; }
        for (const l of chunk) { text(l, M + 12, yy - 10, size, false); yy -= lead; }
        y -= hh + 8; i += chunk.length;
        if (i < lines.length) newPage();
      }
      continue;
    }
    for (const [i, l] of lines.entries()) {
      ensure(lead);
      if (i === 0 && b.t === 'li') text(enc('•'), M + 6, y - 11, size, false);
      if (i === 0 && b.t === 'step') text(enc(`${b.n}.`), M + 4, y - 11, size, true, '0.12 0.27 0.65');
      text(l, M + indent, y - 11, size, false);
      y -= lead;
    }
    y -= b.t === 'p' ? 6 : 3;
  }

  // Objekte: 1 Katalog, 2 Seitenbaum, 3/4 Schriften, danach je Seite Inhalt + Seite
  const objs = [];
  const add = (buf) => { objs.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'latin1')); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${6 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  pages.forEach((parts, i) => {
    const body = Buffer.concat(parts);
    add(Buffer.concat([Buffer.from(`<< /Length ${body.length} >>\nstream\n`, 'latin1'), body, Buffer.from('\nendstream', 'latin1')]));
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
  });
  // Pro Seite zwei Objekte: Inhalt = 5+2i, Seite = 6+2i
  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')], offs = [];
  let pos = chunks[0].length;
  objs.forEach((o, i) => { offs.push(pos); const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]); chunks.push(b); pos += b.length; });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
