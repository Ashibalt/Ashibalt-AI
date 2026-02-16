import * as vscode from 'vscode';
import * as path from 'path';
import { IGNORED_DIRS, IGNORED_FILES } from '../../constants';
import { resolveFilePath } from './toolUtils';

/**
 * Build a glob exclude pattern from IGNORED_DIRS for findFiles.
 */
function buildExcludePattern(): string {
  const patterns = Array.from(IGNORED_DIRS).map(d => `**/${d}/**`);
  return `{${patterns.join(',')}}`;
}

/**
 * Unified search tool — combines workspace search, file search, and file listing.
 * Supports multi-query search: query can be a single string or array of up to 15 strings.
 * When multiple queries are provided, results are grouped by query.
 */
export async function searchTool(args: any, workspaceRoot?: string): Promise<any> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { error: 'No workspace folder open' };
  }
  
  const rootPath = workspaceRoot || folders[0].uri.fsPath;
  let includePattern = args?.include || '**/*';
  
  // Normalize include pattern: convert folder paths to globs
  // Models often pass "src/WebView/" or "src/WebView" instead of "src/WebView/**"
  if (includePattern && !includePattern.includes('*')) {
    let cleaned = includePattern.replace(/[/\\]+$/, ''); // strip trailing slashes
    // Strip absolute workspace prefix if model passed full path (e.g. "C:\Users\...\src\WebView")
    if (path.isAbsolute(cleaned)) {
      const rel = path.relative(rootPath, cleaned);
      if (!rel.startsWith('..')) {
        cleaned = rel.replace(/\\/g, '/');
      }
    }
    includePattern = `${cleaned}/**`;
  }
  
  // Parse query: support string or array of strings (up to 15)
  let queries: string[];
  if (Array.isArray(args?.query)) {
    queries = args.query.filter((q: any) => typeof q === 'string' && q.trim()).slice(0, 15);
  } else if (typeof args?.query === 'string' && args.query.trim()) {
    queries = [args.query];
  } else {
    return { error: 'search requires query parameter (string or array of up to 15 strings)' };
  }
  
  // Mode 1: Search for files by name/pattern
  if (args.files_only) {
    const excludePattern = buildExcludePattern();
    const allResults: Record<string, string[]> = {};
    for (const query of queries) {
      const files = await vscode.workspace.findFiles(query, excludePattern, 100);
      allResults[query] = files.map(f => path.relative(rootPath, f.fsPath));
    }
    return queries.length === 1
      ? { query: queries[0], mode: 'files', results: allResults[queries[0]] }
      : { queries, mode: 'files', results: allResults };
  }
  
  // Mode 2: Search in specific file (multi-query)
  if (args.file) {
    const resolved = resolveFilePath(args.file, workspaceRoot);
    const uri = vscode.Uri.file(resolved);
    
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString('utf8');
      const lines = content.split(/\r?\n/);
      const contextRadius = 3;
      
      const allMatches: Record<string, any[]> = {};
      for (const query of queries) {
        const qLower = query.toLowerCase();
        const matches: any[] = [];
        
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(qLower)) {
            const start = Math.max(0, i - contextRadius);
            const end = Math.min(lines.length, i + contextRadius + 1);
            const contextLines: string[] = [];
            
            for (let j = start; j < end; j++) {
              const marker = j === i ? '>>>' : '   ';
              contextLines.push(`${marker} ${j + 1}: ${lines[j]}`);
            }
            
            matches.push({ line: i + 1, context: contextLines.join('\n') });
          }
        }
        allMatches[query] = matches.slice(0, 20);
      }
      
      if (queries.length === 1) {
        return {
          query: queries[0],
          file: args.file,
          mode: 'in_file',
          total_matches: allMatches[queries[0]].length,
          matches: allMatches[queries[0]]
        };
      }
      return {
        queries,
        file: args.file,
        mode: 'in_file',
        results: Object.fromEntries(
          queries.map(q => [q, { total_matches: allMatches[q].length, matches: allMatches[q] }])
        )
      };
    } catch (e: any) {
      return { error: `Cannot read file: ${e.message}` };
    }
  }
  
  // Mode 3: Search across workspace (multi-query — single file pass for efficiency)
  const excludePattern = buildExcludePattern();
  const files = await vscode.workspace.findFiles(includePattern, excludePattern, 200);
  const allResults: Record<string, any[]> = {};
  for (const q of queries) allResults[q] = [];
  const queriesLower = queries.map(q => q.toLowerCase());
  const maxResultsPerQuery = 50;
  
  for (const fileUri of files) {
    // Early exit if ALL queries hit their limit
    if (queriesLower.every((_, idx) => allResults[queries[idx]].length >= maxResultsPerQuery)) break;
    
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const content = Buffer.from(bytes).toString('utf8');
      const lines = content.split('\n');
      const relPath = path.relative(rootPath, fileUri.fsPath);
      
      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase();
        for (let qi = 0; qi < queriesLower.length; qi++) {
          if (allResults[queries[qi]].length >= maxResultsPerQuery) continue;
          if (lineLower.includes(queriesLower[qi])) {
            allResults[queries[qi]].push({
              file: relPath,
              line: i + 1,
              preview: lines[i].trim().substring(0, 100)
            });
          }
        }
      }
    } catch {
      continue;
    }
  }
  
  if (queries.length === 1) {
    const results = allResults[queries[0]];
    return {
      query: queries[0],
      mode: 'workspace',
      total_results: results.length,
      results,
      ...(results.length === 0 ? { hint: 'No matches found in workspace source files. Try a different query, or use read_file to check a specific file.' } : {})
    };
  }
  
  return {
    queries,
    mode: 'workspace',
    results: Object.fromEntries(
      queries.map(q => [q, { total_results: allResults[q].length, matches: allResults[q] }])
    )
  };
}

// ============================================================================
// Project tree tool
// ============================================================================

interface TreeNode {
  name: string;
  type: 'file' | 'directory';
  size?: number;
  children?: TreeNode[];
}

/**
 * Get project tree structure.
 */
export async function getProjectTreeTool(args: any, workspaceRoot?: string): Promise<any> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { error: 'No workspace folder open' };
  }

  const rootPath = workspaceRoot || folders[0].uri.fsPath;
  const subPath = args?.path ? path.resolve(rootPath, args.path) : rootPath;
  const maxDepth = Math.min(args?.max_depth ?? 4, 10);

  // Security check
  const rel = path.relative(rootPath, subPath);
  if (rel.startsWith('..')) {
    return { error: 'Cannot access directories outside workspace' };
  }

  const uri = vscode.Uri.file(subPath);
  
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.Directory) {
      return { error: 'Path is not a directory' };
    }
  } catch (e) {
    return { error: `Directory not found: ${subPath}` };
  }

  const tree = await buildTree(uri, 0, maxDepth);
  
  // Convert tree to string representation
  const treeString = treeToString(tree, '');
  
  return {
    root: path.basename(subPath),
    tree: treeString,
    max_depth: maxDepth
  };
}

async function buildTree(uri: vscode.Uri, depth: number, maxDepth: number): Promise<TreeNode> {
  const name = path.basename(uri.fsPath);
  const stat = await vscode.workspace.fs.stat(uri);

  if (stat.type === vscode.FileType.File) {
    return { name, type: 'file', size: stat.size };
  }

  if (depth >= maxDepth) {
    return { name, type: 'directory', children: [{ name: '...', type: 'file' }] };
  }

  const entries = await vscode.workspace.fs.readDirectory(uri);
  const children: TreeNode[] = [];

  // Sort: directories first, then files, alphabetically
  entries.sort((a, b) => {
    if (a[1] === b[1]) return a[0].localeCompare(b[0]);
    return a[1] === vscode.FileType.Directory ? -1 : 1;
  });

  for (const [entryName, entryType] of entries) {
    // Skip ignored
    if (entryType === vscode.FileType.Directory && IGNORED_DIRS.has(entryName)) continue;
    if (entryType === vscode.FileType.File && IGNORED_FILES.has(entryName)) continue;
    if (entryName.startsWith('.') && entryName !== '.env') continue; // Skip hidden except .env

    const childUri = vscode.Uri.joinPath(uri, entryName);
    const childNode = await buildTree(childUri, depth + 1, maxDepth);
    children.push(childNode);
  }

  return { name, type: 'directory', children };
}

function treeToString(node: TreeNode, prefix: string): string {
  let result = node.name;
  
  if (node.type === 'file' && node.size !== undefined) {
    const sizeStr = node.size < 1024 ? `${node.size}B` : 
                    node.size < 1024 * 1024 ? `${(node.size / 1024).toFixed(1)}KB` :
                    `${(node.size / 1024 / 1024).toFixed(1)}MB`;
    result += ` (${sizeStr})`;
  }
  
  if (node.children && node.children.length > 0) {
    result += '/\n';
    const lastIdx = node.children.length - 1;
    node.children.forEach((child, idx) => {
      const isLast = idx === lastIdx;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';
      result += prefix + connector + treeToString(child, prefix + childPrefix) + '\n';
    });
    result = result.trimEnd();
  }
  
  return result;
}
