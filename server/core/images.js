/** Bild-Upload-Hilfen: Typ wird anhand der Dateikopfdaten geprüft (nie anhand von Dateiname/Typ-Angabe). Kein SVG (Skript-Risiko). */
export const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export function sniffImage(b) {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

/** Base64/Data-URL → { buf, ext } oder wirft mit verständlicher Meldung. */
export function decodeImage(data, maxBytes, fail) {
  if (typeof data !== 'string') throw fail('Keine Bilddaten übergeben.');
  const buf = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) throw fail('Die Datei ist leer.');
  if (buf.length > maxBytes) throw fail(`Die Datei ist zu groß (maximal ${(maxBytes / 1024 / 1024).toFixed(1)} MB).`);
  const ext = sniffImage(buf);
  if (!ext) throw fail('Nur PNG-, JPEG- oder WebP-Bilder sind erlaubt.');
  return { buf, ext };
}

/** Dokumente (Ausweis, Waffenschein, Rechnung): PDF oder Bild – geprüft anhand der Dateikopfdaten. */
export function decodeDocument(data, maxBytes, fail) {
  if (typeof data !== 'string') throw fail('Keine Datei übergeben.');
  const buf = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
  if (buf.length < 8) throw fail('Die Datei ist leer.');
  if (buf.length > maxBytes) throw fail(`Die Datei ist zu groß (maximal ${(maxBytes / 1024 / 1024).toFixed(0)} MB).`);
  if (buf.subarray(0, 5).toString() === '%PDF-') return { buf, ext: 'pdf' };
  const img = sniffImage(buf);
  if (img) return { buf, ext: img };
  throw fail('Erlaubt sind PDF, PNG, JPEG und WebP.');
}
export const DOC_MIME = { ...IMAGE_MIME, pdf: 'application/pdf' };
