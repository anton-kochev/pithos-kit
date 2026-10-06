// Pi 1.0.3 edit strips the leading BOM, normalizes CRLF/CR to LF, inserts
// replacement text literally, then restores the BOM and first line ending.
// Require an exact normalized match: never predict Pi's fuzzy fallback.
export function expectedEdit(text: string, oldText: string, newText: string): string {
  const bom = text.startsWith('\ufeff') ? '\ufeff' : '';
  const content = text.slice(bom.length);
  const normalize = (value: string) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const base = normalize(content);
  const old = normalize(oldText);
  if (!old || base.split(old).length !== 2) throw new Error('Clio: patch needs a unique exact normalized match');
  const expected = base.replace(old, () => normalize(newText));
  const crlf = content.indexOf('\r\n');
  const ending = crlf !== -1 && crlf < content.indexOf('\n') ? '\r\n' : '\n';
  return bom + (ending === '\r\n' ? expected.replace(/\n/g, '\r\n') : expected);
}
