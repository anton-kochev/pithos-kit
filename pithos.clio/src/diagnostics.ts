import { redactSensitive } from './context.ts';
import { isExcludedEvidencePath } from './evidence.ts';

// Diagnostics are excerpts, not a complete secret classifier. Drop terminal
// sequences/format controls before heuristic matching, and redact before limits.
function diagnosticText(text: string): string {
  const plain = text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
  const excerpt = plain.replace(/(?:\b(?:request|response)[ _-]?(?:body|payload)\s*[:=]|\{|\[\s*[{"]|<\s*(?:html|!doctype))[\s\S]*/i, '[OMITTED PAYLOAD]');
  const withoutUrls = excerpt.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[REDACTED URL]');
  const withoutHeaders = withoutUrls.split('\n').map(line => /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:|\b(?:x-amz-signature|sig(?:nature)?)\s*=/i.test(line) ? '[REDACTED SENSITIVE LINE]' : line).join('\n');
  return redactSensitive(withoutHeaders)
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function bounded(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let result = '';
  let size = 0;
  for (const character of text) {
    const next = Buffer.byteLength(character);
    if (size + next > bytes - 3) break;
    result += character;
    size += next;
  }
  return result + '...';
}
function diagnosticPath(path: string): string {
  if (path.length > 160 || isExcludedEvidencePath(path) ||
    (path !== '.' && (!/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(path) || path.split('/').some(p => !p || p.startsWith('.'))))) return '[OMITTED PATH]';
  return path;
}
export function workerDiagnostic(category: string, model: string, turn: number, reason?: string, evidence?: {action: string; path: string}): string {
  const explanation = bounded(diagnosticText(reason ?? '') || 'No failure reason available', 500);
  const call = evidence ? `; action=${evidence.action === 'read' || evidence.action === 'list' ? evidence.action : '[OMITTED]'}; path=${diagnosticPath(evidence.path)}` : '';
  return bounded(`${category}; model=${bounded(diagnosticText(model), 160)}; turn=${turn}${call}: ${explanation}`, 900);
}

// Only package-authored reasons or known system codes, never raw tool payloads
// or filesystem messages (which can include absolute paths).
const evidenceReasons = new Set([
  'Clio: evidence outside observed scope', 'Clio: evidence baseline changed',
  'Clio: evidence budget exceeded', 'Clio: evidence response budget exceeded',
  'Clio: path normalization refused', 'Clio: excluded directory',
  'Clio: unsafe directory', 'Clio: canonical directory changed',
  'Clio: generated or sensitive content refused', 'Clio: file budget exceeded',
  'Clio: symlink refused', 'Clio: canonical path changed',
  'Clio: growing file exceeds budget',
]);
export function evidenceFailureReason(error: unknown): string | undefined {
  if (error instanceof Error) {
    if (evidenceReasons.has(error.message)) return error.message;
    if (error.message.startsWith('Clio: excluded path ')) return 'Clio: excluded path';
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^(?:ENOENT|EACCES|EPERM|ENOTDIR|EISDIR|ELOOP|EMFILE|ENFILE|EIO|ENAMETOOLONG|ERR_ENCODING_INVALID_ENCODED_DATA)$/.test(code)) return `Evidence read/list failed (${code})`;
  return undefined;
}
