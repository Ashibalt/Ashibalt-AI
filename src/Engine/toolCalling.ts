/**
 * toolCalling.ts — Tool registry, validation, and dispatcher.
 * 
 * Individual tool implementations are in src/Engine/tools/:
 *   - readFileTool.ts      — read_file + file symbols
 *   - editFileTool.ts      — edit_file (old_string/new_string + line-range)
 *   - fileManagementTools.ts — create_file, delete_file
 *   - searchTools.ts       — search, list_files (project tree)
 *   - terminalTool.ts      — terminal command execution
 *   - diagnoseTool.ts      — diagnose (diagnostics)
 *   - webSearchTool.ts     — web_search (Tavily)
 *   - toolUtils.ts         — shared utilities (resolveFilePath, checkPathSecurity, stripAnsi)
 */

import { readFileTool } from './tools/readFileTool';
import { editFileTool } from './tools/editFileTool';
import { createFileTool, deleteFileTool } from './tools/fileManagementTools';
import { searchTool, getProjectTreeTool } from './tools/searchTools';
import { runTerminalCommandTool, readTerminalOutputTool, writeToTerminalTool } from './tools/terminalTool';
import { diagnoseTool } from './tools/diagnoseTool';
import { fetchUrlTool } from './tools/fetchUrlTool';
import { webSearchTool } from './tools/webSearchTool';
import { logger } from '../logger';

export type ToolSpec = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: any;
  };
};

export const tools: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: `Read a file from the workspace. Returns content with each line prefixed by its line number as "N: content".

Usage:
- By default returns up to 800 lines from start of file.
- Use start_line/end_line to read a specific range.
- Use search parameter to find specific text (returns matching lines with ±3 lines context).
- Use symbols=true to get file structure (functions, classes, imports with line numbers) without content.
- Avoid tiny repeated slices. If you need more context, read a larger window (200-800 lines).
- Call this tool BEFORE using edit_file. The edit will FAIL if you haven't read the file first.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file' },
          symbols: { type: 'boolean', description: 'If true, return only file structure (functions, classes, imports with line numbers) without file content' },
          search: { type: 'string', description: 'Optional: search for this text, return only matching lines with ±3 lines context' },
          start_line: { type: 'integer', description: 'Optional: 1-based start line' },
          end_line: { type: 'integer', description: 'Optional: 1-based end line' }
        },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: `Performs exact string replacement in an existing file.

Usage:
- You MUST use read_file at least once before editing. This tool will error if you haven't read the file first.
- When using text from read_file output, preserve exact indentation. The line number prefix format is "N: content" — never include the line number prefix in old_string or new_string.
- ALWAYS prefer editing existing files. NEVER create new files unless explicitly required.
- old_string must match exactly in the file. Include 2-3 surrounding lines for unique matching.
- The edit will FAIL if old_string is not found ("old_string not found in content").
- The edit will FAIL if old_string matches multiple locations. Provide more surrounding context to make it unique, or add start_line hint.
- Keep each edit focused: change only the specific lines that need changing.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to existing file' },
          old_string: { type: 'string', description: 'Exact text to find and replace. Include surrounding context for uniqueness.' },
          new_string: { type: 'string', description: 'Replacement text. Use empty string to delete.' },
          start_line: { type: 'integer', description: 'Optional hint: approximate line number where old_string is located. Helps if multiple matches.' }
        },
        required: ['file_path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: `Create a new file. Fails if file already exists — use edit_file instead.

Usage:
- ALWAYS prefer editing existing files. NEVER write new files unless explicitly required.
- If the file already exists, you MUST use edit_file to modify it.
- If edit_file failed, it means your old_string didn't match — re-read the file instead of creating a new one.
- "content" must be actual file text (HTML, CSS, JS, etc.), NOT JSON representation.
- Before creating, verify the target directory fits the existing project structure.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to new file' },
          content: { type: 'string', description: 'Raw file text (actual code/markup, NOT JSON representation)' }
        },
        required: ['file_path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file. Requires user confirmation. Avoid deleting and recreating files — use edit_file instead.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to file to delete' }
        },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in directory. Returns tree structure with file sizes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: workspace root)' },
          max_depth: { type: 'integer', description: 'Max depth (default: 4)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description: `Search for text or files in workspace. Supports searching for up to 15 words/phrases at once by passing an array.
Set files_only=true to search by filename. Set file to search within a specific file.`,
      parameters: {
        type: 'object',
        properties: {
          query: { 
            oneOf: [
              { type: 'string', description: 'Single text/pattern to search for' },
              { type: 'array', items: { type: 'string' }, maxItems: 15, description: 'Array of up to 15 texts/patterns to search for simultaneously' }
            ],
            description: 'Text/pattern(s) to search for. String or array of strings (max 15).'
          },
          file: { type: 'string', description: 'Optional: search only in this file' },
          files_only: { type: 'boolean', description: 'Optional: search for file names only' },
          include: { type: 'string', description: 'Optional: glob pattern (e.g. "**/*.ts")' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'terminal',
      description: `Run shell command in workspace. Returns output.
Use the cwd parameter for working directory — do NOT prepend "cd".
Output is cleaned of ANSI codes. Supports git, npm, python, pip, node and other CLI tools.
Set background=true for long-running processes (servers, watchers). Server commands (npm run dev, etc.) auto-run in background.
Use read_terminal_output to check output of background processes.`,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          cwd: { type: 'string', description: 'Working directory relative to workspace (optional)' },
          timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default: 30000, max: 120000)' },
          background: { type: 'boolean', description: 'Run in background (non-blocking). Use for servers, watchers, long-running processes. Default: auto-detected for server commands.' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'diagnose',
      description: `Check file for errors. Returns errors with ±5 lines of code context. Use after editing to verify changes.`,
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to file to check' }
        },
        required: ['file']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: `Fetch a URL via HTTP/HTTPS. Useful for checking if a dev server is running, debugging web apps, seeing error pages.

Returns status code, headers, and response body (max 50KB).
Supports localhost and remote URLs.`,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL (e.g. http://localhost:3000)' },
          method: { type: 'string', description: 'HTTP method (default: GET)' },
          timeout_ms: { type: 'integer', description: 'Timeout in ms (default: 10000, max: 30000)' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: `Search the web using Tavily API. Use for questions about current events, documentation, APIs, or anything not in the codebase.

Returns search results with titles, URLs, and content snippets. May include an AI-generated summary.`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'integer', description: 'Maximum results (1-10, default: 5)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_terminal_output',
      description: `Read output from a background terminal process started with terminal(background=true).
Returns accumulated output since last read. Use to check server status, build progress, etc.`,
      parameters: {
        type: 'object',
        properties: {
          clear_buffer: { type: 'boolean', description: 'Clear the output buffer after reading (default: true)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_to_terminal',
      description: `Send input text to the active terminal or background process.
Use this to answer interactive prompts (e.g. "y\\n", "N\\n", password input).
The text is sent to stdin. Include \\n at the end to press Enter.

Use AFTER starting a command with terminal() and seeing a prompt in the output.
Returns the latest output after sending the input.`,
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Text to send to terminal stdin (include \\n for Enter)' }
        },
        required: ['input']
      }
    }
  },
];

/**
 * Read-only tool subset for Chat mode.
 * Chat mode can read and search but NOT modify files or run commands.
 */
export const chatTools: ToolSpec[] = tools.filter(t => 
  ['read_file', 'list_files', 'search', 'diagnose', 'fetch_url', 'web_search', 'read_terminal_output'].includes(t.function.name)
);

/**
 * Validate tool arguments before execution.
 * Returns error message if validation fails, null if valid.
 */
function validateToolArgs(toolName: string, args: any): string | null {
  if (!args || typeof args !== 'object') {
    return `${toolName} requires an arguments object`;
  }

  switch (toolName) {
    case 'read_file':
      if (!args.file_path || typeof args.file_path !== 'string') {
        return 'read_file requires file_path (string)';
      }
      if (args.start_line !== undefined && (typeof args.start_line !== 'number' || args.start_line < 1)) {
        return 'read_file: start_line must be a positive integer';
      }
      if (args.end_line !== undefined && (typeof args.end_line !== 'number' || args.end_line < 1)) {
        return 'read_file: end_line must be a positive integer';
      }
      break;

    case 'edit_file':
      if (!args.file_path || typeof args.file_path !== 'string') {
        return 'edit_file requires file_path (string)';
      }
      // Primary format: old_string/new_string (with optional start_line hint)
      const hasOldNew = typeof (args.old_string ?? args.oldString) === 'string' && typeof (args.new_string ?? args.newString) === 'string';
      // Legacy format: start_line/end_line/content
      const hasLineRange = typeof args.start_line === 'number' && typeof args.end_line === 'number' && typeof args.content === 'string';
      if (!hasOldNew && !hasLineRange) {
        return 'edit_file requires (old_string + new_string). Use read_file to see the file first, then provide exact text in old_string and replacement in new_string.';
      }
      break;

    case 'create_file':
      if (!args.file_path || typeof args.file_path !== 'string') {
        return 'create_file requires file_path (string)';
      }
      if (typeof args.content !== 'string') {
        return 'create_file requires content (string)';
      }
      break;

    case 'delete_file':
      if (!args.file_path || typeof args.file_path !== 'string') {
        return 'delete_file requires file_path (string)';
      }
      break;

    case 'terminal':
      if (!args.command || typeof args.command !== 'string') {
        return 'terminal requires command (string)';
      }
      break;

    case 'diagnose':
      if (!args.file || typeof args.file !== 'string') {
        return 'diagnose requires file (string)';
      }
      break;

    case 'fetch_url':
      if (!args.url || typeof args.url !== 'string') {
        return 'fetch_url requires url (string)';
      }
      break;

    case 'search':
      if (!args.query || typeof args.query !== 'string') {
        return 'search requires query (string)';
      }
      break;

    case 'web_search':
      if (!args.query || typeof args.query !== 'string') {
        return 'web_search requires query (string)';
      }
      break;

    case 'list_files':
      // These have all optional parameters
      break;

    case 'read_terminal_output':
      // All parameters optional
      break;

    case 'write_to_terminal':
      if (!args.input || typeof args.input !== 'string') {
        return 'write_to_terminal requires input (string)';
      }
      break;

    default:
      break;
  }

  return null;
}

/**
 * Execute a registered tool by name.
 * workspaceRoot may be provided to resolve relative paths.
 */
export async function executeTool(toolName: string, args: any, workspaceRoot?: string): Promise<any> {
  if (!toolName) throw new Error('toolName required');
  const startedAt = Date.now();

  const summarizeArgs = (name: string, value: any): string => {
    try {
      if (!value || typeof value !== 'object') return '{}';
      const summary: Record<string, any> = {};
      if (typeof value.file_path === 'string') summary.file_path = value.file_path;
      if (typeof value.file === 'string') summary.file = value.file;
      if (typeof value.path === 'string') summary.path = value.path;
      if (typeof value.query === 'string') summary.query = value.query.slice(0, 80);
      if (typeof value.command === 'string') summary.command = value.command.slice(0, 120);
      if (typeof value.url === 'string') summary.url = value.url;
      if (typeof value.start_line === 'number') summary.start_line = value.start_line;
      if (typeof value.end_line === 'number') summary.end_line = value.end_line;
      if (typeof value.old_string === 'string') summary.old_string_len = value.old_string.length;
      if (typeof value.new_string === 'string') summary.new_string_len = value.new_string.length;
      if (typeof value.content === 'string' && name === 'create_file') summary.content_len = value.content.length;
      return JSON.stringify(summary);
    } catch {
      return '{"summary":"failed"}';
    }
  };

  logger.log(`[TOOL_DISPATCH] START ${toolName} args=${summarizeArgs(toolName, args)}`);
  
  // Validate arguments before execution
  const validationError = validateToolArgs(toolName, args);
  if (validationError) {
    return { 
      error: validationError,
      hint: 'Please check the required parameters for this tool and try again with correct arguments.'
    };
  }
  
  let result: any;
  try {
    switch (toolName) {
      case 'read_file':
        result = await readFileTool(args, workspaceRoot);
        break;
      case 'edit_file':
        result = await editFileTool(args, workspaceRoot);
        break;
      case 'create_file':
        result = await createFileTool(args, workspaceRoot);
        break;
      case 'delete_file':
        result = await deleteFileTool(args, workspaceRoot);
        break;
      case 'list_files':
        result = await getProjectTreeTool(args, workspaceRoot);
        break;
      case 'search':
        result = await searchTool(args, workspaceRoot);
        break;
      case 'terminal':
        result = await runTerminalCommandTool(args, workspaceRoot);
        break;
      case 'diagnose':
        result = await diagnoseTool(args, workspaceRoot);
        break;
      case 'fetch_url':
        result = await fetchUrlTool(args);
        break;
      case 'web_search':
        result = await webSearchTool(args);
        break;
      case 'read_terminal_output':
        result = await readTerminalOutputTool(args);
        break;
      case 'write_to_terminal':
        result = await writeToTerminalTool(args);
        break;
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }

    const elapsed = Date.now() - startedAt;
    const resultType = typeof result;
    const resultSize = typeof result === 'string' ? result.length : JSON.stringify(result || {}).length;
    const hasError = !!result?.error;
    logger.log(`[TOOL_DISPATCH] END ${toolName} ok=${!hasError} elapsed=${elapsed}ms resultType=${resultType} resultSize=${resultSize}`);
    return result;
  } catch (e: any) {
    const elapsed = Date.now() - startedAt;
    logger.log(`[TOOL_DISPATCH] ERROR ${toolName} elapsed=${elapsed}ms err=${(e?.message || String(e)).slice(0, 200)}`);
    throw e;
  }
}
