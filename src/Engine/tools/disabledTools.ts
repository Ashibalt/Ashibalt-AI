import * as vscode from 'vscode';
import * as path from 'path';
import { fetch } from 'undici';
import { logger } from '../../logger';
import { resolveFilePath } from './toolUtils';
import { runCommandWithChildProcess } from './terminalTool';

// ============================================================================
// DISABLED TOOLS — kept for future use
// ============================================================================

/**
 * Find all references to a symbol using VS Code Language Server.
 */
export async function findReferencesTool(args: any, workspaceRoot?: string): Promise<any> {
  if (!args?.file_path) {
    return { error: 'file_path is required' };
  }
  if (typeof args.line !== 'number' || args.line < 1) {
    return { error: 'line is required (1-based line number)' };
  }
  
  // Resolve file path
  const resolved = resolveFilePath(args.file_path, workspaceRoot);
  const uri = vscode.Uri.file(resolved);
  
  // Check file exists
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    return { error: `File not found: ${resolved}` };
  }
  
  // Convert to 0-based for VS Code API
  const line = args.line - 1;
  let column = (args.column ?? 1) - 1;
  
  // If no column specified, try to find a symbol on this line
  if (!args.column) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const lineText = doc.lineAt(line).text;
      // Find first word character (likely start of symbol)
      const match = lineText.match(/\b\w+/);
      if (match && match.index !== undefined) {
        column = match.index;
      }
    } catch {
      // Use default column 0
    }
  }
  
  const position = new vscode.Position(line, column);
  
  try {
    // Use VS Code's reference provider
    const locations = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      uri,
      position
    );
    
    if (!locations || locations.length === 0) {
      return {
        file: args.file_path,
        line: args.line,
        message: 'No references found. Symbol may not be recognized by language server.',
        references: []
      };
    }
    
    // Get workspace root for relative paths
    const folders = vscode.workspace.workspaceFolders;
    const rootPath = workspaceRoot || (folders && folders.length > 0 ? folders[0].uri.fsPath : '');
    
    // Format references
    const references = locations.map(loc => {
      const relativePath = rootPath ? path.relative(rootPath, loc.uri.fsPath) : loc.uri.fsPath;
      return {
        file: relativePath,
        line: loc.range.start.line + 1,
        column: loc.range.start.character + 1,
        end_line: loc.range.end.line + 1,
        end_column: loc.range.end.character + 1
      };
    });
    
    // Group by file for easier reading
    const byFile: Record<string, number[]> = {};
    for (const ref of references) {
      if (!byFile[ref.file]) {
        byFile[ref.file] = [];
      }
      byFile[ref.file].push(ref.line);
    }
    
    // Build summary
    const summary = Object.entries(byFile)
      .map(([file, lines]) => `${file}: lines ${lines.join(', ')}`)
      .join('\n');
    
    return {
      file: args.file_path,
      line: args.line,
      total_references: references.length,
      files_affected: Object.keys(byFile).length,
      summary,
      references: references.slice(0, 50) // Limit to 50 references
    };
    
  } catch (e: any) {
    logger.log(`[FIND_REFERENCES] Error: ${e.message}`);
    return {
      error: `Failed to find references: ${e.message}`,
      hint: 'Make sure the language server is running for this file type'
    };
  }
}

/**
 * Run tests with auto-detected or specified framework.
 */
export async function runTestsTool(args: any, workspaceRoot?: string): Promise<any> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { error: 'No workspace folder open' };
  }
  
  const rootPath = workspaceRoot || folders[0].uri.fsPath;
  
  // Detect test framework if not specified
  let framework = args?.framework;
  if (!framework) {
    framework = await detectTestFramework(rootPath);
  }
  
  if (!framework) {
    return {
      error: 'Could not detect test framework',
      hint: 'Specify framework parameter (jest, vitest, pytest, mocha) or ensure package.json/pyproject.toml exists'
    };
  }
  
  logger.log(`[RUN_TESTS] Using framework: ${framework}`);
  
  // Build test command
  let command: string;
  const file = args?.file;
  const pattern = args?.pattern;
  
  switch (framework.toLowerCase()) {
    case 'jest':
      command = 'npx jest --json --no-coverage';
      if (file) command += ` "${file}"`;
      if (pattern) command += ` -t "${pattern}"`;
      break;
      
    case 'vitest':
      command = 'npx vitest run --reporter=json';
      if (file) command += ` "${file}"`;
      if (pattern) command += ` -t "${pattern}"`;
      break;
      
    case 'mocha':
      command = 'npx mocha --reporter json';
      if (file) command += ` "${file}"`;
      if (pattern) command += ` --grep "${pattern}"`;
      break;
      
    case 'pytest':
      command = 'python -m pytest -v';
      if (file) command += ` "${file}"`;
      if (pattern) command += ` -k "${pattern}"`;
      break;
      
    case 'unittest':
      command = 'python -m unittest';
      if (file) command += ` ${file.replace(/\.py$/, '').replace(/[/\\]/g, '.')}`;
      break;
      
    default:
      return { error: `Unknown test framework: ${framework}` };
  }
  
  // Run the tests
  try {
    const result = await runCommandWithChildProcess(command, rootPath, 120000); // 2 min timeout for tests
    
    // Try to parse JSON output for jest/vitest
    let parsedResults: any = null;
    if (['jest', 'vitest'].includes(framework.toLowerCase())) {
      try {
        // Find JSON in output (jest outputs JSON with --json flag)
        const jsonMatch = result.output.match(/\{[\s\S]*"numTotalTests"[\s\S]*\}/);
        if (jsonMatch) {
          parsedResults = JSON.parse(jsonMatch[0]);
        }
      } catch {
        // JSON parsing failed, use raw output
      }
    }
    
    // Format response
    if (parsedResults) {
      const passed = parsedResults.numPassedTests || 0;
      const failed = parsedResults.numFailedTests || 0;
      const total = parsedResults.numTotalTests || 0;
      
      const response: any = {
        success: failed === 0,
        framework,
        summary: `${passed}/${total} tests passed`,
        passed,
        failed,
        total,
        duration_ms: parsedResults.startTime ? Date.now() - parsedResults.startTime : undefined
      };
      
      // Include failure details
      if (parsedResults.testResults) {
        const failures: any[] = [];
        for (const suite of parsedResults.testResults) {
          for (const test of suite.assertionResults || []) {
            if (test.status === 'failed') {
              failures.push({
                name: test.fullName || test.title,
                file: suite.name,
                error: (test.failureMessages || []).join('\n').substring(0, 500)
              });
            }
          }
        }
        if (failures.length > 0) {
          response.failures = failures.slice(0, 10); // Limit to 10 failures
        }
      }
      
      return response;
    }
    
    // Parse pytest output
    if (framework.toLowerCase() === 'pytest') {
      const passedMatch = result.output.match(/(\d+) passed/);
      const failedMatch = result.output.match(/(\d+) failed/);
      const errorMatch = result.output.match(/(\d+) error/);
      
      const passed = passedMatch ? parseInt(passedMatch[1]) : 0;
      const failed = (failedMatch ? parseInt(failedMatch[1]) : 0) + (errorMatch ? parseInt(errorMatch[1]) : 0);
      
      return {
        success: result.success && failed === 0,
        framework,
        summary: `${passed} passed, ${failed} failed`,
        passed,
        failed,
        output: result.output.substring(0, 5000)
      };
    }
    
    // Fallback: return raw output
    return {
      success: result.success,
      framework,
      command,
      output: result.output.substring(0, 5000),
      hint: 'Could not parse test output. Check raw output above.'
    };
    
  } catch (e: any) {
    return {
      error: `Test execution failed: ${e.message}`,
      framework,
      command
    };
  }
}

/**
 * Detect test framework from project files.
 */
async function detectTestFramework(rootPath: string): Promise<string | null> {
  // Check package.json for JS/TS projects
  try {
    const packageJsonPath = path.join(rootPath, 'package.json');
    const packageJsonUri = vscode.Uri.file(packageJsonPath);
    const bytes = await vscode.workspace.fs.readFile(packageJsonUri);
    const packageJson = JSON.parse(Buffer.from(bytes).toString('utf8'));
    
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    
    if (deps['vitest']) return 'vitest';
    if (deps['jest']) return 'jest';
    if (deps['mocha']) return 'mocha';
    
    // Check scripts
    const scripts = packageJson.scripts || {};
    if (scripts.test?.includes('vitest')) return 'vitest';
    if (scripts.test?.includes('jest')) return 'jest';
    if (scripts.test?.includes('mocha')) return 'mocha';
    
  } catch {
    // No package.json or error reading it
  }
  
  // Check for Python projects
  try {
    const pyprojectPath = path.join(rootPath, 'pyproject.toml');
    await vscode.workspace.fs.stat(vscode.Uri.file(pyprojectPath));
    return 'pytest';
  } catch {
    // No pyproject.toml
  }
  
  // Check for requirements.txt with pytest
  try {
    const reqPath = path.join(rootPath, 'requirements.txt');
    const reqUri = vscode.Uri.file(reqPath);
    const bytes = await vscode.workspace.fs.readFile(reqUri);
    const content = Buffer.from(bytes).toString('utf8');
    if (content.includes('pytest')) return 'pytest';
  } catch {
    // No requirements.txt
  }
  
  // Check for test files to guess framework
  try {
    const files = await vscode.workspace.findFiles('**/*.test.{ts,js,tsx,jsx}', '**/node_modules/**', 1);
    if (files.length > 0) return 'jest'; // Default for JS/TS test files
  } catch {
    // Ignore
  }
  
  try {
    const pyFiles = await vscode.workspace.findFiles('**/test_*.py', '**/venv/**', 1);
    if (pyFiles.length > 0) return 'pytest';
  } catch {
    // Ignore
  }
  
  return null;
}

/**
 * Web search using Tavily API.
 */
export async function webSearchTool(args: any): Promise<any> {
  if (!args?.query) {
    throw new Error('web_search requires "query" parameter');
  }
  
  const apiKey = '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';
  
  const query = args.query;
  const maxResults = Math.min(Math.max(1, args.max_results || 5), 10);
  
  logger.log(`[WEB_SEARCH] Searching for: "${query}", max_results: ${maxResults}`);
  
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: 'basic', // 'basic' is cheaper, 'advanced' for deeper search
        include_answer: true,  // Get AI-generated answer
        include_raw_content: false,
        max_results: maxResults,
        include_domains: [],
        exclude_domains: []
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logger.log(`[WEB_SEARCH] API error: ${response.status} - ${errorText}`);
      return {
        success: false,
        error: `Tavily API error: ${response.status} - ${errorText.slice(0, 200)}`,
        results: []
      };
    }
    
    const data: any = await response.json();
    logger.log(`[WEB_SEARCH] Got ${data.results?.length || 0} results`);
    
    // Format results for the model
    const results = (data.results || []).map((r: any) => ({
      title: r.title || 'No title',
      url: r.url,
      content: r.content || r.snippet || '',
      score: r.score
    }));
    
    // Build formatted output
    let formatted = `Web search results for: "${query}"\n\n`;
    
    // Include AI-generated answer if available
    if (data.answer) {
      formatted += `## AI Summary\n${data.answer}\n\n`;
    }
    
    formatted += `## Search Results (${results.length})\n\n`;
    
    results.forEach((r: any, i: number) => {
      formatted += `### ${i + 1}. ${r.title}\n`;
      formatted += `URL: ${r.url}\n`;
      if (r.content) {
        // Truncate very long content
        const content = r.content.length > 500 ? r.content.slice(0, 500) + '...' : r.content;
        formatted += `${content}\n`;
      }
      formatted += '\n';
    });
    
    return {
      success: true,
      query,
      answer: data.answer || null,
      results_count: results.length,
      results,
      formatted
    };
    
  } catch (err: any) {
    logger.log(`[WEB_SEARCH] Error: ${err.message}`);
    return {
      success: false,
      error: `Web search failed: ${err.message}`,
      results: []
    };
  }
}
