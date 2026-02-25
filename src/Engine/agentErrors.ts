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

  // Stage 8: Character-level string value escaping fix
  // Handles unescaped special chars INSIDE JSON string values (common for HTML/code content)
  {
    try {
      const fixed = escapeStringValues(s);
      const result = JSON.parse(fixed);
      logger.log(`[JSON] Recovered after string-value escaping for ${toolName}`);
      return result;
    } catch {}
  }

  // Stage 9: Tool-specific extraction for create_file / edit_file with large content
  {
    const extracted = tryExtractToolArgs(s, toolName);
    if (extracted) {
      logger.log(`[JSON] Recovered via tool-specific extraction for ${toolName}`);
      return extracted;
    }
  }

  // Stage 10: Truncated JSON — close open strings/objects/arrays
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

  // Stage 11: Combined escaping + truncation close
  if (s.length > 500) {
    try {
      let fixed = escapeStringValues(s);

      let braces = 0, brackets = 0, inStr = false, esc = false;
      for (let i = 0; i < fixed.length; i++) {
        const ch = fixed[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') braces++;
        else if (ch === '}') braces--;
        else if (ch === '[') brackets++;
        else if (ch === ']') brackets--;
      }
      if (inStr) fixed += '"';
      fixed = fixed.replace(/[,:]\s*$/, '');
      for (let i = 0; i < brackets; i++) fixed += ']';
      for (let i = 0; i < braces; i++) fixed += '}';

      const result = JSON.parse(fixed);
      logger.log(`[JSON] Recovered after combined escape+truncation for ${toolName}`);
      return result;
    } catch {}
  }

  return null;
}

/**
 * Escape unescaped special characters inside JSON string values.
 * Walks the string character-by-character, tracking in-string state,
 * and fixes raw control characters (newlines, tabs, backspaces) that
 * the model forgot to escape.
 */
function escapeStringValues(input: string): string {
  const out: string[] = [];
  let inString = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (!inString) {
      if (ch === '"') { inString = true; }
      out.push(ch);
      i++;
      continue;
    }

    // Inside a string value
    if (ch === '\\') {
      // Already escaped — pass through escape + next char
      out.push(ch);
      if (i + 1 < input.length) {
        out.push(input[i + 1]);
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (ch === '"') {
      // End of string (or unescaped quote inside value)
      // Heuristic: if next non-whitespace char is : , } ] then it's a real closing quote
      let afterQuote = i + 1;
      while (afterQuote < input.length && (input[afterQuote] === ' ' || input[afterQuote] === '\t')) afterQuote++;
      const nextCh = input[afterQuote];
      if (nextCh === ':' || nextCh === ',' || nextCh === '}' || nextCh === ']' || nextCh === undefined) {
        inString = false;
        out.push(ch);
      } else {
        // Unescaped quote inside value — escape it
        out.push('\\', '"');
      }
      i++;
      continue;
    }

    // Control character fixes
    if (ch === '\n') { out.push('\\', 'n'); i++; continue; }
    if (ch === '\r') { out.push('\\', 'r'); i++; continue; }
    if (ch === '\t') { out.push('\\', 't'); i++; continue; }
    if (ch === '\b') { out.push('\\', 'b'); i++; continue; }
    if (ch === '\f') { out.push('\\', 'f'); i++; continue; }

    out.push(ch);
    i++;
  }
  return out.join('');
}

/**
 * Tool-specific argument extraction for create_file / edit_file.
 * When standard JSON parsing fails, extracts known fields by pattern matching.
 */
function tryExtractToolArgs(raw: string, toolName: string): any | null {
  if (toolName === 'create_file') {
    // Pattern: {"file_path": "...", "content": "..."}
    const pathMatch = raw.match(/"file_path"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (!pathMatch) return null;

    const filePath = JSON.parse(`"${pathMatch[1]}"`);

    // Find the start of "content" value
    const contentKeyIdx = raw.indexOf('"content"');
    if (contentKeyIdx === -1) return null;

    const colonIdx = raw.indexOf(':', contentKeyIdx + 9);
    if (colonIdx === -1) return null;

    let valueStart = colonIdx + 1;
    while (valueStart < raw.length && raw[valueStart] === ' ') valueStart++;
    if (raw[valueStart] !== '"') return null;

    // Extract content value: scan from opening quote to the last valid closing quote
    const contentRaw = extractLargeStringValue(raw, valueStart);
    if (contentRaw === null) return null;

    logger.log(`[JSON] Extracted create_file args: file_path="${filePath}", content length=${contentRaw.length}`);
    return { file_path: filePath, content: contentRaw };
  }

  if (toolName === 'edit_file') {
    // Pattern: {"file_path": "...", "old_string": "...", "new_string": "..."}
    const pathMatch = raw.match(/"file_path"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (!pathMatch) return null;

    const filePath = JSON.parse(`"${pathMatch[1]}"`);
    const args: any = { file_path: filePath };

    // Extract old_string
    const oldIdx = raw.indexOf('"old_string"');
    if (oldIdx !== -1) {
      const oldColonIdx = raw.indexOf(':', oldIdx + 12);
      if (oldColonIdx !== -1) {
        let vs = oldColonIdx + 1;
        while (vs < raw.length && raw[vs] === ' ') vs++;
        if (raw[vs] === '"') {
          const val = extractLargeStringValue(raw, vs);
          if (val !== null) args.old_string = val;
        }
      }
    }

    // Extract new_string
    const newIdx = raw.indexOf('"new_string"');
    if (newIdx !== -1) {
      const newColonIdx = raw.indexOf(':', newIdx + 12);
      if (newColonIdx !== -1) {
        let vs = newColonIdx + 1;
        while (vs < raw.length && raw[vs] === ' ') vs++;
        if (raw[vs] === '"') {
          const val = extractLargeStringValue(raw, vs);
          if (val !== null) args.new_string = val;
        }
      }
    }

    // Extract optional start_line
    const slMatch = raw.match(/"start_line"\s*:\s*(\d+)/);
    if (slMatch) args.start_line = parseInt(slMatch[1], 10);

    if (args.old_string !== undefined && args.new_string !== undefined) {
      logger.log(`[JSON] Extracted edit_file args: file_path="${filePath}"`);
      return args;
    }
  }

  return null;
}

/**
 * Extract a JSON string value starting at the opening quote position.
 * Handles unescaped characters inside the value gracefully.
 * Returns the decoded string value or null on failure.
 */
function extractLargeStringValue(raw: string, quoteStart: number): string | null {
  if (raw[quoteStart] !== '"') return null;

  // Walk forward to find the end of the string, handling escapes
  let i = quoteStart + 1;
  const chars: string[] = [];
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      switch (next) {
        case '"': chars.push('"'); break;
        case '\\': chars.push('\\'); break;
        case '/': chars.push('/'); break;
        case 'n': chars.push('\n'); break;
        case 'r': chars.push('\r'); break;
        case 't': chars.push('\t'); break;
        case 'b': chars.push('\b'); break;
        case 'f': chars.push('\f'); break;
        case 'u': {
          const hex = raw.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            chars.push(String.fromCharCode(parseInt(hex, 16)));
            i += 6;
            continue;
          }
          chars.push('\\', next);
          break;
        }
        default:
          // Unknown escape — just include both chars
          chars.push('\\', next);
      }
      i += 2;
      continue;
    }

    if (ch === '"') {
      // End of string
      return chars.join('');
    }

    // Raw control characters — include as-is (model forgot to escape)
    chars.push(ch);
    i++;
  }

  // Reached end without closing quote — return what we have (truncated)
  return chars.length > 0 ? chars.join('') : null;
}
