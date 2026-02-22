import { logger } from '../logger';

/**
 * Parse API error into a human-readable Russian message.
 * Extracts HTTP status from Error message format "... (STATUS): ..."
 * Returns { summary, details } where details is the raw error for expandable UI.
 */
export function parseApiError(err: any): { summary: string; details: string } {
  const msg = err?.message || String(err);

  const statusMatch = msg.match(/\((\d{3})\)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

  let innerMsg = '';
  let jsonBody = '';
  const jsonStart = msg.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(msg.slice(jsonStart));
      innerMsg = parsed?.error?.message || parsed?.message || parsed?.error || '';
      jsonBody = JSON.stringify(parsed, null, 2);
    } catch {}
  }

  let summary: string;
  switch (status) {
    case 429:
      summary = '⏳ Превышен лимит запросов. Подождите 30-60 секунд.';
      break;
    case 400:
      summary = `Ошибка 400: ${innerMsg || 'Некорректные данные'}`;
      break;
    case 401:
      summary = 'Ошибка 401: неверный API-ключ';
      break;
    case 403:
      summary = 'Ошибка 403: нет доступа к модели';
      break;
    case 404:
      summary = 'Ошибка 404: модель не найдена';
      break;
    case 500:
    case 502:
    case 503:
      summary = `Ошибка ${status}: сервер провайдера недоступен`;
      break;
    case 0:
      if (msg.includes('fetch') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('network')) {
        summary = 'Нет подключения к серверу';
        break;
      }
      if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
        summary = 'Таймаут запроса';
        break;
      }
      summary = `Ошибка: ${msg.slice(0, 150)}`;
      break;
    default:
      summary = `Ошибка ${status}: ${innerMsg || msg.slice(0, 150)}`;
      break;
  }

  const details = jsonBody || msg;
  return { summary, details };
}

/**
 * Multi-stage JSON recovery for malformed tool call arguments.
 * Handles: trailing commas, unquoted keys, single quotes,
 * unescaped newlines, truncated JSON, markdown fences.
 * Returns parsed object or null if unrecoverable.
 */
export function tryRecoverJSON(raw: string, toolName: string, finishReason: string | undefined): any | null {
  let s = raw.trim();

  // Stage 1: Strip markdown code fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  s = s.trim();

  // Stage 2: Parse after fence strip
  try { return JSON.parse(s); } catch {}

  // Stage 3: Fix unescaped newlines/tabs
  {
    const fixed = s
      .replace(/\r\n/g, '\\n')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\n')
      .replace(/\t/g, '\\t');
    try {
      const result = JSON.parse(fixed);
      logger.log(`[JSON] Recovered after newline/tab fix for ${toolName}`);
      return result;
    } catch {}
  }

  // Stage 4: Fix trailing commas
  {
    const fixed = s.replace(/,\s*([}\]])/g, '$1');
    try {
      const result = JSON.parse(fixed);
      logger.log(`[JSON] Recovered after trailing comma fix for ${toolName}`);
      return result;
    } catch {}
  }

  // Stage 5: Replace single quotes with double quotes
  {
    if (!s.includes('"') && s.includes("'")) {
      const fixed = s.replace(/'/g, '"');
      try {
        const result = JSON.parse(fixed);
        logger.log(`[JSON] Recovered after single→double quote fix for ${toolName}`);
        return result;
      } catch {}
    }
  }

  // Stage 6: Quote unquoted keys
  {
    const fixed = s.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
    try {
      const result = JSON.parse(fixed);
      logger.log(`[JSON] Recovered after key quoting fix for ${toolName}`);
      return result;
    } catch {}
  }

  // Stage 7: Combined fixes
  {
    let fixed = s;
    fixed = fixed.replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/\r/g, '\\n').replace(/\t/g, '\\t');
    fixed = fixed.replace(/,\s*([}\]])/g, '$1');
    fixed = fixed.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
    try {
      const result = JSON.parse(fixed);
      logger.log(`[JSON] Recovered after combined fixes for ${toolName}`);
      return result;
    } catch {}
  }

  // Stage 8: Truncated JSON — close open strings/objects/arrays
  if (finishReason === 'length' || s.length > 1000) {
    let fixed = s;
    fixed = fixed.replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/\r/g, '\\n').replace(/\t/g, '\\t');

    let braces = 0, brackets = 0, inString = false, escaped = false;
    for (let i = 0; i < fixed.length; i++) {
      const ch = fixed[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') braces++;
      else if (ch === '}') braces--;
      else if (ch === '[') brackets++;
      else if (ch === ']') brackets--;
    }

    if (inString) fixed += '"';
    fixed = fixed.replace(/[,:]\s*$/, '');
    for (let i = 0; i < brackets; i++) fixed += ']';
    for (let i = 0; i < braces; i++) fixed += '}';

    try {
      const result = JSON.parse(fixed);
      logger.log(`[JSON] Recovered truncated JSON for ${toolName} (closed ${braces} braces, ${brackets} brackets, inString=${inString})`);
      return result;
    } catch {}
  }

  return null;
}
