// Heuristics, not a complete secret classifier. Lines are kept so line numbers stay stable.

// "bearer tokens are ..." is prose, not a credential; a header, assignment or quote still wins.
function hasBearerValue(line: string): boolean {
  for (const match of line.matchAll(/\bBearer\s+(\S+)/gi)) {
    const before = line.slice(0, match.index);
    const after = line.slice(match.index + match[0].length);
    const nounProse = match[0].startsWith('bearer') && match[1] === 'tokens' && /^[\t ]+(?:are\b|and[\t ]+private[\t ]+keys\b)/.test(after);
    if (!nounProse || /\b(?:authorization|proxy-authorization)\s*[:=]|[:="'`][\t ]*$/i.test(before)) return true;
  }
  return false;
}

const SENSITIVE_LINE = /(?:password|passwd|secret(?:\s+phrase)?|credential|api[_ -]?key|(?:access[_ -]?)?token)\s*["']?\s*(?::|=|\bis\b)|\b(?:sk-[a-zA-Z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9]{8,}|AKIA[A-Z0-9]{16})/i;

export function redactSensitive(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .split('\n')
    .map(line => SENSITIVE_LINE.test(line) || hasBearerValue(line) ? '[REDACTED SENSITIVE LINE]' : line)
    .join('\n');
}

/** Drops harness-injected context blocks and redacts credentials from session prose. */
export function cleanProse(text: string): string {
  return redactSensitive(text.replace(/<(environment_details|environment_context|system-reminder)>[\s\S]*?(?:<\/\1>|$)/gi, '')).trim();
}
