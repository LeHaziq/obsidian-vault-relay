/**
 * Error messages are persisted to data.json and rendered in settings, so any
 * credential that reaches one must be scrubbed first.
 *
 * The previous pattern used `1/[\w-]+`, which never matched a Google refresh
 * token: those are formatted `1//0g...` and `/` is not in `[\w-]`, so the
 * alternative failed at the second character.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /1\/\/[A-Za-z0-9._~+/-]+=*/g,
  /ya29\.[A-Za-z0-9._~+/-]+=*/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\brefresh_token["'\s:=]+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\baccess_token["'\s:=]+[A-Za-z0-9._~+/-]{8,}=*/gi,
  // JWT-shaped triples, which Google also issues as id_tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

export function redactTokens(message: string): string {
  return TOKEN_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted]"), message);
}
