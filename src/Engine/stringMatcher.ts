/**
 * String matching engine for edit_file v2
 * 
 * 7-strategy pipeline to find old_string in file content, handling:
 * - Exact match
 * - Whitespace-normalized (trailing spaces)
 * - Indentation-stripped (leading whitespace ignored for comparison)
 * - Line-by-line fuzzy (≥70% of lines match)
 * - Boundary anchoring (first/last lines match, middle flexible)
 * - Substring containment (old_string is containED in a region)
 * - Levenshtein-based (edit distance on lines)
 * 
 * Each strategy returns the actual matched region for precise replacement.
 */


// ============================================================================
// Types
// ============================================================================

export interface MatchResult {
  found: true;
  /** The normalized file content */
  normalizedContent: string;
  /** The actual text in the file that was matched */
  matchedOld: string;
  /** The new string to replace with (may be adjusted for indentation) */
  matchedNew: string;
  /** Which strategy succeeded */
  strategy: string;
  /** Byte position in content where match starts */
  position: number;
  /** How many matches were found (1 = unique) */
  matchCount: number;
  /** 1-based line number where match starts */
  matchLine: number;
}

export interface MatchError {
  found: false;
  error: string;
  details: {
    closest_match?: string;
    closest_line?: number;
    similarity?: number;
    actual_content: string;
    hint: string;
  };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Fix common escape sequence mistakes from models.
 * Models often double-escape in JSON: \" → "
 */
export function fixEscapeSequences(s: string): string {
  return s.replace(/\\"/g, '"');
}

/** Normalize line endings to LF */
function normLF(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

/** Trim trailing whitespace per line */
function trimTrailing(s: string): string {
  return s.split('\n').map(l => l.trimEnd()).join('\n');
}

/** Count occurrences of substring in string */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += 1;
  }
  return count;
}

/** Get 1-based line number from byte position */
function lineNumberAt(content: string, position: number): number {
  return content.slice(0, position).split('\n').length;
}

/** Levenshtein distance on arrays of strings (line-level, trimmed comparison) */
function lineEditDistance(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > Math.max(m, n) * 0.5) return Math.max(m, n);
  
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1].trim() === b[j - 1].trim() ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

/** Get position in string where a certain line index starts */
function contentLinePosition(content: string, lineIndex: number): number {
  const lines = content.split('\n');
  let pos = 0;
  for (let i = 0; i < lineIndex && i < lines.length; i++) {
    pos += lines[i].length + 1;
  }
  return pos;
}

// ============================================================================
// Main matching function
// ============================================================================

/**
 * Try to find oldString in content using 7 progressive strategies.
 * Returns MatchResult on success or MatchError with detailed diagnostics.
 * 
 * @param startLineHint Optional 1-based line hint to disambiguate multiple matches
 */
export function findStringWithStrategies(
  content: string,
  oldString: string,
  newString: string,
  startLineHint?: number
): MatchResult | MatchError {
  
  const norm = normLF(content);
  const oldNorm = normLF(fixEscapeSequences(oldString));
  const newNorm = normLF(fixEscapeSequences(newString));
  
  // Empty old_string = error
  if (!oldNorm.trim()) {
    return {
      found: false,
      error: 'old_string is empty. Provide the text you want to replace.',
      details: {
        actual_content: norm.split('\n').slice(0, 10).map((l, i) => 'L' + (i + 1) + ': ' + l).join('\n'),
        hint: 'Provide the exact text you want to find and replace.'
      }
    };
  }

  // --- Strategy 1: Exact match ---
  {
    const result = pickBestMatch(norm, oldNorm, newNorm, 'exact', startLineHint);
    if (result) {
      return result;
    }
  }

  // --- Strategy 2: Trailing-whitespace normalized ---
  {
    const trimmedContent = trimTrailing(norm);
    const trimmedOld = trimTrailing(oldNorm);
    const result = pickBestMatch(trimmedContent, trimmedOld, trimTrailing(newNorm), 'whitespace-normalized', startLineHint);
    if (result) {
      return result;
    }
  }

  // --- Strategy 3: Indentation-agnostic ---
  {
    const result = tryIndentationAgnostic(norm, oldNorm, newNorm, startLineHint);
    if (result) {

      return result;
    }
  }

  // --- Strategy 4: Line-by-line fuzzy (≥70% lines match) ---
  {
    const result = tryLineFuzzy(norm, oldNorm, newNorm, startLineHint);
    if (result) {
      return result;
    }
  }

  // --- Strategy 5: Boundary anchoring ---
  {
    const result = tryBoundaryMatch(norm, oldNorm, newNorm, startLineHint);
    if (result) {
      return result;
    }
  }

  // --- Strategy 6: Substring containment ---
  {
    const result = trySubstringContainment(norm, oldNorm, newNorm, startLineHint);
    if (result) {
      return result;
    }
  }

  // --- Strategy 7: Levenshtein-based ---
  {
    const result = tryLevenshteinMatch(norm, oldNorm, newNorm, startLineHint);
    if (result) {
      return result;
    }
  }

  // All strategies failed
  return buildDetailedError(norm, oldNorm);
}

// ============================================================================
// Helper: pick match closest to line hint when multiple matches
// ============================================================================

function pickBestMatch(
  content: string, needle: string, replacement: string,
  strategy: string, lineHint?: number
): MatchResult | null {
  const positions: number[] = [];
  let pos = 0;
  while ((pos = content.indexOf(needle, pos)) !== -1) {
    positions.push(pos);
    pos += 1;
  }
  if (positions.length === 0) return null;

  let bestPos: number;
  if (positions.length === 1) {
    bestPos = positions[0];
  } else if (lineHint) {
    bestPos = positions.reduce((closest, p) => {
      const line = lineNumberAt(content, p);
      const closestLine = lineNumberAt(content, closest);
      return Math.abs(line - lineHint) < Math.abs(closestLine - lineHint) ? p : closest;
    }, positions[0]);
  } else {
    bestPos = positions[0];
  }

  return {
    found: true,
    normalizedContent: content,
    matchedOld: needle,
    matchedNew: replacement,
    strategy,
    position: bestPos,
    matchCount: positions.length,
    matchLine: lineNumberAt(content, bestPos)
  };
}

// ============================================================================
// Strategy 3: Indentation-agnostic
// ============================================================================

function tryIndentationAgnostic(
  content: string, oldString: string, newString: string, lineHint?: number
): MatchResult | null {
  const contentLines = content.split('\n');
  const oldLines = oldString.split('\n');
  if (oldLines.length < 1) return null;
  
  const strippedOld = oldLines.map(l => l.trimStart());
  const matches: number[] = [];

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trimStart() !== strippedOld[j]) {
        match = false;
        break;
      }
    }
    if (match) matches.push(i);
  }
  
  if (matches.length === 0) return null;
  
  // Pick best match (closest to line hint)
  let bestIdx = matches[0];
  if (lineHint && matches.length > 1) {
    bestIdx = matches.reduce((closest, idx) => 
      Math.abs((idx + 1) - lineHint) < Math.abs((closest + 1) - lineHint) ? idx : closest
    , matches[0]);
  }
  
  const actualOld = contentLines.slice(bestIdx, bestIdx + oldLines.length).join('\n');
  const adjustedNew = adjustIndentation(oldLines, contentLines.slice(bestIdx, bestIdx + oldLines.length), newString);
  const position = contentLinePosition(content, bestIdx);

  return {
    found: true,
    normalizedContent: content,
    matchedOld: actualOld,
    matchedNew: adjustedNew,
    strategy: 'indentation-agnostic',
    position,
    matchCount: matches.length,
    matchLine: bestIdx + 1
  };
}

/** Adjust indentation of new_string to match how old_string actually appears in file */
function adjustIndentation(
  modelOldLines: string[], actualOldLines: string[], newString: string
): string {
  const newLines = newString.split('\n');
  if (modelOldLines.length === 0 || actualOldLines.length === 0) return newString;
  
  const modelIndent = getLeadingWhitespace(modelOldLines[0]);
  const actualIndent = getLeadingWhitespace(actualOldLines[0]);
  
  if (modelIndent === actualIndent) return newString;
  
  const modelSpaces = expandTabs(modelIndent).length;
  const actualSpaces = expandTabs(actualIndent).length;
  const diff = actualSpaces - modelSpaces;
  if (diff === 0) return newString;

  return newLines.map(line => {
    if (!line.trim()) return line;
    if (diff > 0) {
      return ' '.repeat(diff) + line;
    } else {
      const leading = getLeadingWhitespace(line);
      const leadingLen = expandTabs(leading).length;
      const newSpaces = Math.max(0, leadingLen + diff);
      return ' '.repeat(newSpaces) + line.trimStart();
    }
  }).join('\n');
}

function getLeadingWhitespace(line: string): string {
  const match = line.match(/^(\s*)/);
  return match ? match[1] : '';
}

function expandTabs(s: string): string {
  return s.replace(/\t/g, '    ');
}

// ============================================================================
// Strategy 4: Line-by-line fuzzy
// ============================================================================

function tryLineFuzzy(
  content: string, oldString: string, newString: string, lineHint?: number
): MatchResult | null {
  const contentLines = content.split('\n');
  const oldLines = oldString.split('\n');
  if (oldLines.length < 3) return null;
  
  const threshold = 0.7;
  let bestScore = 0;
  let bestIdx = -1;

  for (const sizeDelta of [0, 1, -1, 2, -2]) {
    const windowSize = oldLines.length + sizeDelta;
    if (windowSize < 2 || windowSize > contentLines.length) continue;
    
    for (let i = 0; i <= contentLines.length - windowSize; i++) {
      const window = contentLines.slice(i, i + windowSize);
      let matching = 0;
      
      for (const oldLine of oldLines) {
        const trimmedOld = oldLine.trim();
        if (!trimmedOld) { matching++; continue; }
        if (window.some(wl => wl.trim() === trimmedOld)) matching++;
      }
      
      let score = matching / oldLines.length;
      // Penalize distance from hint
      if (lineHint) {
        const distPenalty = Math.abs((i + 1) - lineHint) / contentLines.length * 0.1;
        score -= distPenalty;
      }
      
      if (score >= threshold && score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
  }
  
  if (bestIdx === -1) return null;
  
  const actualOld = contentLines.slice(bestIdx, bestIdx + oldLines.length).join('\n');
  const position = contentLinePosition(content, bestIdx);

  return {
    found: true,
    normalizedContent: content,
    matchedOld: actualOld,
    matchedNew: adjustIndentation(oldLines, actualOld.split('\n'), newString),
    strategy: 'line-fuzzy',
    position,
    matchCount: 1,
    matchLine: bestIdx + 1
  };
}

// ============================================================================
// Strategy 5: Boundary anchoring
// ============================================================================

function tryBoundaryMatch(
  content: string, oldString: string, newString: string, lineHint?: number
): MatchResult | null {
  const contentLines = content.split('\n');
  const oldLines = oldString.split('\n');
  if (oldLines.length < 3) return null;
  
  const firstAnchor = oldLines.find(l => l.trim())?.trim();
  const lastAnchor = [...oldLines].reverse().find(l => l.trim())?.trim();
  if (!firstAnchor || !lastAnchor) return null;

  const startCandidates: number[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() === firstAnchor) startCandidates.push(i);
  }
  if (startCandidates.length === 0) return null;

  for (const start of startCandidates) {
    const expectedEnd = start + oldLines.length - 1;
    const searchFrom = Math.max(start + 1, expectedEnd - 3);
    const searchTo = Math.min(contentLines.length - 1, expectedEnd + 3);
    
    for (let end = searchFrom; end <= searchTo; end++) {
      if (contentLines[end].trim() === lastAnchor) {
        const actualSize = end - start + 1;
        if (Math.abs(actualSize - oldLines.length) <= Math.max(3, oldLines.length * 0.2)) {
          const actualOld = contentLines.slice(start, end + 1).join('\n');
          const position = contentLinePosition(content, start);
          return {
            found: true,
            normalizedContent: content,
            matchedOld: actualOld,
            matchedNew: adjustIndentation(oldLines, contentLines.slice(start, end + 1), newString),
            strategy: 'boundary',
            position,
            matchCount: 1,
            matchLine: start + 1
          };
        }
      }
    }
  }
  return null;
}

// ============================================================================
// Strategy 6: Substring containment
// ============================================================================

function trySubstringContainment(
  content: string, oldString: string, newString: string, lineHint?: number
): MatchResult | null {
  const contentLines = content.split('\n');
  const oldLines = oldString.split('\n');
  const nonEmptyOld = oldLines.filter(l => l.trim());
  if (nonEmptyOld.length < 2) return null;
  
  // Find the most unique line (longest non-trivial)
  const anchorLine = nonEmptyOld.reduce((best, line) => 
    line.trim().length > best.trim().length ? line : best
  );
  const anchorTrimmed = anchorLine.trim();

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== anchorTrimmed) continue;
    
    const anchorIdxInOld = nonEmptyOld.findIndex(l => l.trim() === anchorTrimmed);
    const regionStart = Math.max(0, i - anchorIdxInOld);
    const regionEnd = Math.min(contentLines.length, regionStart + oldLines.length + 2);
    const region = contentLines.slice(regionStart, regionEnd);
    
    let matched = 0;
    for (const ol of nonEmptyOld) {
      if (region.some(rl => rl.trim() === ol.trim())) matched++;
    }
    
    if (matched >= nonEmptyOld.length * 0.7) {
      const actualOld = contentLines.slice(regionStart, regionStart + oldLines.length).join('\n');
      const position = contentLinePosition(content, regionStart);
      return {
        found: true,
        normalizedContent: content,
        matchedOld: actualOld,
        matchedNew: adjustIndentation(oldLines, actualOld.split('\n'), newString),
        strategy: 'substring',
        position,
        matchCount: 1,
        matchLine: regionStart + 1
      };
    }
  }
  return null;
}

// ============================================================================
// Strategy 7: Levenshtein-based
// ============================================================================

function tryLevenshteinMatch(
  content: string, oldString: string, newString: string, lineHint?: number
): MatchResult | null {
  const contentLines = content.split('\n');
  const oldLines = oldString.split('\n');
  if (oldLines.length < 2) return null;
  
  let bestDistance = Infinity;
  let bestIdx = -1;
  const maxDistance = Math.ceil(oldLines.length * 0.3);

  for (const sizeDelta of [0, 1, -1, 2, -2]) {
    const windowSize = oldLines.length + sizeDelta;
    if (windowSize < 2 || windowSize > contentLines.length) continue;
    
    for (let i = 0; i <= contentLines.length - windowSize; i++) {
      const window = contentLines.slice(i, i + windowSize);
      const dist = lineEditDistance(oldLines, window);
      
      if (dist < bestDistance && dist <= maxDistance) {
        bestDistance = dist;
        bestIdx = i;
      }
    }
  }
  
  if (bestIdx === -1) return null;

  const actualOld = contentLines.slice(bestIdx, bestIdx + oldLines.length).join('\n');
  const position = contentLinePosition(content, bestIdx);
  
  return {
    found: true,
    normalizedContent: content,
    matchedOld: actualOld,
    matchedNew: adjustIndentation(oldLines, actualOld.split('\n'), newString),
    strategy: 'levenshtein',
    position,
    matchCount: 1,
    matchLine: bestIdx + 1
  };
}

// ============================================================================
// Error builder
// ============================================================================

function buildDetailedError(content: string, oldString: string): MatchError {
  const contentLines = content.split('\n');
  const oldLines = oldString.split('\n');
  const firstOldLine = oldLines.find(l => l.trim())?.trim() || '';
  
  let closestLine = -1;
  let closestSimilarity = 0;
  let closestRegion = '';
  
  if (firstOldLine.length >= 5) {
    for (let i = 0; i < contentLines.length; i++) {
      const trimmed = contentLines[i].trim();
      if (!trimmed) continue;
      const sim = charSimilarity(trimmed, firstOldLine);
      if (sim > closestSimilarity && sim > 0.4) {
        closestSimilarity = sim;
        closestLine = i + 1;
        const start = Math.max(0, i - 2);
        const end = Math.min(contentLines.length, i + oldLines.length + 2);
        closestRegion = contentLines.slice(start, end).map((l, idx) => 'L' + (start + idx + 1) + ': ' + l).join('\n');
      }
    }
  }
  
  if (!closestRegion) {
    closestRegion = contentLines.slice(0, Math.min(20, contentLines.length))
      .map((l, i) => 'L' + (i + 1) + ': ' + l).join('\n');
  }
  
  let hint = 'Use read_file to see current file content, then copy the exact text you want to replace.';
  if (closestLine > 0 && closestSimilarity > 0.5) {
    hint = 'Found similar text near line ' + closestLine + ' (' + Math.round(closestSimilarity * 100) + '% similar). ' +
           'Use read_file with start_line=' + Math.max(1, closestLine - 5) + ' to see exact content.';
  }

  return {
    found: false,
    error: 'old_string not found in file (tried 7 matching strategies). The text may have changed since you last read the file.',
    details: {
      closest_match: closestRegion || undefined,
      closest_line: closestLine > 0 ? closestLine : undefined,
      similarity: closestSimilarity > 0 ? Math.round(closestSimilarity * 100) : undefined,
      actual_content: closestRegion,
      hint
    }
  };
}

/** Character-level similarity (Jaccard on 3-grams) */ 
function charSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const size = 3;
  if (a.length < size || b.length < size) return a === b ? 1 : 0;
  
  const getNgrams = (s: string): Set<string> => {
    const ng = new Set<string>();
    for (let i = 0; i <= s.length - size; i++) ng.add(s.slice(i, i + size));
    return ng;
  };
  
  const na = getNgrams(a);
  const nb = getNgrams(b);
  let inter = 0;
  for (const x of na) if (nb.has(x)) inter++;
  const union = na.size + nb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export { charSimilarity as stringSimilarity };
