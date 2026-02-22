import { describe, it, expect } from 'vitest';
import { findStringWithStrategies, fixEscapeSequences } from '../src/Engine/stringMatcher';

describe('fixEscapeSequences', () => {
  it('should unescape double-escaped quotes', () => {
    expect(fixEscapeSequences('say \\"hello\\"')).toBe('say "hello"');
  });

  it('should leave normal strings unchanged', () => {
    expect(fixEscapeSequences('no escapes here')).toBe('no escapes here');
  });
});

describe('findStringWithStrategies', () => {
  const sampleFile = [
    'function hello() {',
    '  console.log("Hello, world!");',
    '  return 42;',
    '}',
    '',
    'function goodbye() {',
    '  return "bye";',
    '}'
  ].join('\n');

  it('exact match — finds and replaces', () => {
    const result = findStringWithStrategies(
      sampleFile,
      '  console.log("Hello, world!");',
      '  console.log("Hi!");'
    );
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.strategy).toBe('exact');
      expect(result.matchCount).toBe(1);
    }
  });

  it('exact match — returns error for missing string', () => {
    const result = findStringWithStrategies(
      sampleFile,
      'this does not exist in the file',
      'replacement'
    );
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.error).toBeTruthy();
    }
  });

  it('empty old_string — returns error', () => {
    const result = findStringWithStrategies(
      sampleFile,
      '   ',
      'replacement'
    );
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.error).toContain('empty');
    }
  });

  it('whitespace-normalized match — handles trailing spaces', () => {
    const contentWithTrailing = 'function test() {   \n  return 1;   \n}';
    const result = findStringWithStrategies(
      contentWithTrailing,
      'function test() {\n  return 1;\n}',
      'function test() {\n  return 2;\n}'
    );
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.strategy).toContain('whitespace');
    }
  });

  it('multi-line exact match with context', () => {
    const result = findStringWithStrategies(
      sampleFile,
      'function hello() {\n  console.log("Hello, world!");\n  return 42;\n}',
      'function hello() {\n  console.log("Changed!");\n  return 0;\n}'
    );
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.matchCount).toBe(1);
    }
  });

  it('start_line hint helps disambiguate', () => {
    const dupeContent = 'if (x) {\n  return 1;\n}\nif (y) {\n  return 1;\n}';
    // "return 1;" appears twice
    const result = findStringWithStrategies(
      dupeContent,
      '  return 1;',
      '  return 2;',
      4 // hint: 4th line
    );
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.matchLine).toBeGreaterThanOrEqual(4);
    }
  });

  it('handles CRLF normalization', () => {
    const crlfContent = 'line1\r\nline2\r\nline3';
    const result = findStringWithStrategies(
      crlfContent,
      'line1\nline2',
      'changed1\nchanged2'
    );
    expect(result.found).toBe(true);
  });
});
