/**
 * File Skeleton Extractor
 * 
 * Извлекает структуру файла для компактного хранения в памяти:
 * - Импорты
 * - Классы с методами
 * - Функции
 * - Интерфейсы и типы
 * - С указанием номеров строк
 * 
 * Это позволяет хранить "скелет" файла вместо полного содержимого,
 * значительно экономя токены при сохранении контекста.
 */

export interface SkeletonItem {
  type: 'import' | 'class' | 'function' | 'method' | 'interface' | 'type' | 'variable' | 'export';
  name: string;
  line: number;
  endLine?: number;
  children?: SkeletonItem[];
  signature?: string; // Сигнатура функции/метода
}

export interface FileSkeleton {
  filePath: string;
  language: string;
  totalLines: number;
  items: SkeletonItem[];
}

/**
 * Определяет язык по расширению файла
 */
export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    'ts': 'typescript',
    'tsx': 'typescript',
    'js': 'javascript',
    'jsx': 'javascript',
    'mjs': 'javascript',
    'cjs': 'javascript',
    'py': 'python',
    'pyw': 'python',
    'java': 'java',
    'kt': 'kotlin',
    'kts': 'kotlin',
    'cs': 'csharp',
    'go': 'go',
    'rs': 'rust',
    'rb': 'ruby',
    'php': 'php',
    'c': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'swift': 'swift',
    'vue': 'vue',
    'svelte': 'svelte',
  };
  return langMap[ext] || 'unknown';
}

/**
 * Извлекает скелет TypeScript/JavaScript файла
 */
function extractTypeScriptSkeleton(content: string): SkeletonItem[] {
  const lines = content.split('\n');
  const items: SkeletonItem[] = [];
  
  // Регулярные выражения для различных конструкций
  const patterns = {
    // Импорты
    import: /^import\s+(?:(?:\{[^}]*\}|[\w*]+)\s+from\s+)?['"][^'"]+['"];?/,
    importMultiStart: /^import\s+\{[^}]*$/,
    
    // Экспорты
    exportDefault: /^export\s+default\s+(?:class|function|const|let|var)?\s*(\w+)?/,
    exportNamed: /^export\s+(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/,
    
    // Классы
    class: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?/,
    
    // Функции
    function: /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)/,
    arrowFunction: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(?[^)]*\)?\s*=>/,
    
    // Методы внутри класса (проверяем по оригинальной строке с отступами)
    method: /^\s+(?:private\s+|public\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:readonly\s+)?(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)/,
    // Методы без отступа (для trimmed строки)
    methodTrimmed: /^(?:private\s+|public\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:readonly\s+)?(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)/,
    getter: /^\s*(?:private\s+|public\s+|protected\s+)?(?:static\s+)?get\s+(\w+)\s*\(/,
    setter: /^\s*(?:private\s+|public\s+|protected\s+)?(?:static\s+)?set\s+(\w+)\s*\(/,
    
    // Интерфейсы и типы
    interface: /^(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[\w,\s<>]+)?/,
    type: /^(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/,
    enum: /^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/,
    
    // Переменные верхнего уровня
    variable: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=/,
  };
  
  let currentClass: SkeletonItem | null = null;
  let braceDepth = 0;
  let inMultilineImport = false;
  let multilineImportStart = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;
    
    // Пропускаем пустые строки и комментарии
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }
    
    // Подсчёт скобок для определения конца класса
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;
    
    // Многострочный импорт
    if (inMultilineImport) {
      if (trimmed.includes('}')) {
        items.push({
          type: 'import',
          name: 'import {...}',
          line: multilineImportStart,
          endLine: lineNum
        });
        inMultilineImport = false;
      }
      continue;
    }
    
    // Проверяем начало многострочного импорта
    if (patterns.importMultiStart.test(trimmed)) {
      inMultilineImport = true;
      multilineImportStart = lineNum;
      continue;
    }
    
    // Импорты (однострочные)
    if (patterns.import.test(trimmed)) {
      // Группируем импорты - просто отмечаем диапазон
      const lastItem = items[items.length - 1];
      if (lastItem && lastItem.type === 'import' && lastItem.endLine === lineNum - 1) {
        lastItem.endLine = lineNum;
      } else {
        items.push({ type: 'import', name: 'imports', line: lineNum, endLine: lineNum });
      }
      continue;
    }
    
    // Классы
    const classMatch = trimmed.match(patterns.class);
    if (classMatch) {
      currentClass = {
        type: 'class',
        name: classMatch[1],
        line: lineNum,
        children: []
      };
      items.push(currentClass);
      braceDepth = openBraces - closeBraces;
      continue;
    }
    
    // Если мы внутри класса
    if (currentClass && braceDepth > 0) {
      braceDepth += openBraces - closeBraces;
      
      // Методы (используем methodTrimmed для trimmed строки)
      const methodMatch = trimmed.match(patterns.methodTrimmed);
      if (methodMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('while')) {
        currentClass.children?.push({
          type: 'method',
          name: methodMatch[1],
          line: lineNum,
          signature: trimmed.slice(0, 80)
        });
        continue;
      }
      
      // Геттеры
      const getterMatch = trimmed.match(patterns.getter);
      if (getterMatch) {
        currentClass.children?.push({
          type: 'method',
          name: `get ${getterMatch[1]}`,
          line: lineNum
        });
        continue;
      }
      
      // Сеттеры
      const setterMatch = trimmed.match(patterns.setter);
      if (setterMatch) {
        currentClass.children?.push({
          type: 'method',
          name: `set ${setterMatch[1]}`,
          line: lineNum
        });
        continue;
      }
      
      // Закрытие класса
      if (braceDepth === 0) {
        currentClass.endLine = lineNum;
        currentClass = null;
      }
      continue;
    }
    
    // Интерфейсы
    const interfaceMatch = trimmed.match(patterns.interface);
    if (interfaceMatch) {
      items.push({ type: 'interface', name: interfaceMatch[1], line: lineNum });
      continue;
    }
    
    // Типы
    const typeMatch = trimmed.match(patterns.type);
    if (typeMatch) {
      items.push({ type: 'type', name: typeMatch[1], line: lineNum });
      continue;
    }
    
    // Enums
    const enumMatch = trimmed.match(patterns.enum);
    if (enumMatch) {
      items.push({ type: 'type', name: `enum ${enumMatch[1]}`, line: lineNum });
      continue;
    }
    
    // Функции
    const funcMatch = trimmed.match(patterns.function);
    if (funcMatch) {
      items.push({ 
        type: 'function', 
        name: funcMatch[1], 
        line: lineNum,
        signature: trimmed.slice(0, 100)
      });
      continue;
    }
    
    // Arrow функции
    const arrowMatch = trimmed.match(patterns.arrowFunction);
    if (arrowMatch) {
      items.push({ 
        type: 'function', 
        name: arrowMatch[1], 
        line: lineNum,
        signature: trimmed.slice(0, 100)
      });
      continue;
    }
    
    // Export default
    const exportDefaultMatch = trimmed.match(patterns.exportDefault);
    if (exportDefaultMatch) {
      items.push({ 
        type: 'export', 
        name: exportDefaultMatch[1] || 'default', 
        line: lineNum 
      });
      continue;
    }
  }
  
  return items;
}

/**
 * Извлекает скелет Python файла
 */
function extractPythonSkeleton(content: string): SkeletonItem[] {
  const lines = content.split('\n');
  const items: SkeletonItem[] = [];
  
  const patterns = {
    import: /^(?:import\s+[\w.]+|from\s+[\w.]+\s+import\s+.+)/,
    class: /^class\s+(\w+)(?:\([^)]*\))?:/,
    function: /^def\s+(\w+)\s*\([^)]*\)/,
    method: /^def\s+(\w+)\s*\([^)]*\)/,  // Для trimmed строки
    asyncFunction: /^async\s+def\s+(\w+)\s*\([^)]*\)/,
    asyncMethod: /^async\s+def\s+(\w+)\s*\([^)]*\)/,  // Для trimmed строки
    variable: /^(\w+)\s*(?::\s*\w+)?\s*=/,
  };
  
  let currentClass: SkeletonItem | null = null;
  let classIndent = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;
    const indent = line.length - line.trimStart().length;
    
    // Пропускаем пустые строки и комментарии
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    
    // Проверяем выход из класса по отступу
    if (currentClass && indent <= classIndent && !trimmed.startsWith('def ') && !trimmed.startsWith('async def ')) {
      currentClass.endLine = lineNum - 1;
      currentClass = null;
    }
    
    // Импорты
    if (patterns.import.test(trimmed)) {
      const lastItem = items[items.length - 1];
      if (lastItem && lastItem.type === 'import' && lastItem.endLine === lineNum - 1) {
        lastItem.endLine = lineNum;
      } else {
        items.push({ type: 'import', name: 'imports', line: lineNum, endLine: lineNum });
      }
      continue;
    }
    
    // Классы
    const classMatch = trimmed.match(patterns.class);
    if (classMatch) {
      currentClass = {
        type: 'class',
        name: classMatch[1],
        line: lineNum,
        children: []
      };
      classIndent = indent;
      items.push(currentClass);
      continue;
    }
    
    // Методы внутри класса (по отступу > classIndent)
    if (currentClass && indent > classIndent) {
      const methodMatch = trimmed.match(patterns.method) || trimmed.match(patterns.asyncMethod);
      if (methodMatch) {
        currentClass.children?.push({
          type: 'method',
          name: methodMatch[1],
          line: lineNum,
          signature: trimmed.slice(0, 80)
        });
        continue;
      }
    }
    
    // Функции верхнего уровня
    const funcMatch = trimmed.match(patterns.function) || trimmed.match(patterns.asyncFunction);
    if (funcMatch && !currentClass) {
      items.push({ 
        type: 'function', 
        name: funcMatch[1], 
        line: lineNum,
        signature: trimmed.slice(0, 100)
      });
      continue;
    }
  }
  
  // Закрываем последний класс
  if (currentClass) {
    currentClass.endLine = lines.length;
  }
  
  return items;
}

/**
 * Основная функция извлечения скелета
 */
export function extractSkeleton(content: string, filePath: string): FileSkeleton {
  const language = detectLanguage(filePath);
  const lines = content.split('\n');
  
  let items: SkeletonItem[] = [];
  
  switch (language) {
    case 'typescript':
    case 'javascript':
    case 'vue':
    case 'svelte':
      items = extractTypeScriptSkeleton(content);
      break;
    case 'python':
      items = extractPythonSkeleton(content);
      break;
    default:
      // Для неизвестных языков - базовый анализ
      items = extractGenericSkeleton(content);
  }
  
  return {
    filePath,
    language,
    totalLines: lines.length,
    items
  };
}

/**
 * Базовый анализ для неизвестных языков
 */
function extractGenericSkeleton(content: string): SkeletonItem[] {
  const lines = content.split('\n');
  const items: SkeletonItem[] = [];
  
  // Ищем что-то похожее на функции/классы
  const patterns = {
    function: /(?:function|def|fn|func)\s+(\w+)/i,
    class: /(?:class|struct|type)\s+(\w+)/i,
  };
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;
    
    const funcMatch = trimmed.match(patterns.function);
    if (funcMatch) {
      items.push({ type: 'function', name: funcMatch[1], line: lineNum });
      continue;
    }
    
    const classMatch = trimmed.match(patterns.class);
    if (classMatch) {
      items.push({ type: 'class', name: classMatch[1], line: lineNum });
      continue;
    }
  }
  
  return items;
}

/**
 * Компактный формат скелета для хранения в памяти
 */
export function formatSkeletonCompact(skeleton: FileSkeleton): string {
  const parts: string[] = [];
  
  parts.push(`[${skeleton.filePath}] ${skeleton.totalLines}L`);
  
  const importRanges: string[] = [];
  const classes: string[] = [];
  const functions: string[] = [];
  const types: string[] = [];
  
  for (const item of skeleton.items) {
    switch (item.type) {
      case 'import':
        if (item.endLine && item.endLine > item.line) {
          importRanges.push(`L${item.line}-${item.endLine}`);
        } else {
          importRanges.push(`L${item.line}`);
        }
        break;
        
      case 'class':
        let classStr = `${item.name}:L${item.line}`;
        if (item.children && item.children.length > 0) {
          const methods = item.children.map(c => `${c.name}:L${c.line}`).join(',');
          classStr += `{${methods}}`;
        }
        classes.push(classStr);
        break;
        
      case 'function':
        functions.push(`${item.name}:L${item.line}`);
        break;
        
      case 'interface':
      case 'type':
        types.push(`${item.name}:L${item.line}`);
        break;
    }
  }
  
  if (importRanges.length > 0) {
    parts.push(`imports:${importRanges.join(',')}`);
  }
  if (classes.length > 0) {
    parts.push(`classes:[${classes.join(';')}]`);
  }
  if (functions.length > 0) {
    parts.push(`fn:[${functions.join(',')}]`);
  }
  if (types.length > 0) {
    parts.push(`types:[${types.join(',')}]`);
  }
  
  return parts.join(' | ');
}
