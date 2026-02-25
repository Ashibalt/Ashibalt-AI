/**
 * toolCalling.ts — Tool registry, validation, and dispatcher.
 * 
 * Individual tool implementations are in src/Engine/tools/:
 *   - readFileTool.ts        — read_file + file symbols
 *   - editFileTool.ts        — edit_file (old_string/new_string + line-range)
 *   - fileManagementTools.ts — create_file, delete_file
 *   - searchTools.ts         — search, list_files (project tree)
 *   - terminalTool.ts        — terminal (unified: run/write/read)
 *   - diagnoseTool.ts        — diagnose (diagnostics)
 *   - webSearchTool.ts       — web_search (Tavily)
 *   - xrayCodebaseTool.ts    — xray_codebase (project-wide symbol map)
 *   - tasksTool.ts           — tasks (agent task checklist)
 *   - productCheckTool.ts    — product_check (headless QA engine)
 *   - toolUtils.ts           — shared utilities (resolveFilePath, checkPathSecurity, stripAnsi)
 */

import { readFileTool } from './tools/readFileTool';
import { editFileTool } from './tools/editFileTool';
import { createFileTool, deleteFileTool } from './tools/fileManagementTools';
import { searchTool, getProjectTreeTool } from './tools/searchTools';
import { terminalTool, runTerminalCommandTool, readTerminalOutputTool, writeToTerminalTool } from './tools/terminalTool';
import { diagnoseTool } from './tools/diagnoseTool';
import { lspBridgeTool } from './tools/lspBridgeTool';
import { fetchUrlTool } from './tools/fetchUrlTool';
import { webSearchTool } from './tools/webSearchTool';
import { xrayCodebaseTool } from './tools/xrayCodebaseTool';
import { tasksTool } from './tools/tasksTool';
import { productCheckTool } from './tools/productCheckTool';
import { logger } from '../logger';

/** Injected postMessage for tools that push UI updates (e.g. tasks). */
let _postMessage: ((msg: any) => void) | undefined;

export function setToolPostMessage(fn: (msg: any) => void): void {
  _postMessage = fn;
}

// Re-export interactive prompt handler setter from terminalTool
export { setInteractivePromptHandler } from './tools/terminalTool';

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
          include: { type: 'string', description: 'Optional: glob pattern (e.g. "**/*.ts")' },
          case_sensitive: { type: 'boolean', description: 'Optional: when true, search is case-sensitive (default: false)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'terminal',
      description: `Unified terminal tool. Use action to choose mode.

action="run" (default) — run a shell command. Returns cleaned output.
  - command: shell command (required)
  - cwd: working directory relative to workspace
  - timeout_ms: timeout in ms (default 30000, max 120000)
  - background: true for servers/watchers (non-blocking)

action="write" — send stdin text to the active terminal or background process.
  - input: text to send (include \\n for Enter); e.g. "y\\n" to confirm a prompt

action="read" — read accumulated output from the background process started with background=true.
  - clear_buffer: clear buffer after reading (default: true)

Do NOT prepend "cd" to commands — use the cwd parameter instead.
Output is cleaned of ANSI escape codes.`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['run', 'write', 'read'], description: 'Mode: "run" (default), "write" (send stdin), "read" (read background output)' },
          command: { type: 'string', description: '[run] Shell command to execute' },
          cwd: { type: 'string', description: '[run] Working directory relative to workspace (optional)' },
          timeout_ms: { type: 'integer', description: '[run] Timeout in milliseconds (default: 30000, max: 120000)' },
          background: { type: 'boolean', description: '[run] Run in background (non-blocking). Use for servers, watchers, long-running processes.' },
          input: { type: 'string', description: '[write] Text to send to terminal stdin (include \\n for Enter)' },
          clear_buffer: { type: 'boolean', description: '[read] Clear output buffer after reading (default: true)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'xray_codebase',
      description: `Get a full symbol map of the entire codebase — all functions, classes, interfaces, methods, enums, constructors, variables, and constants with file paths, line numbers, and signatures.

Grouped by file, sorted by line. Includes function signatures (parameters + return types), class inheritance, and variable types when available. Use at the start of large refactoring tasks or when you need to understand project structure without reading every file.

Optionally filter by name substring (query) or symbol kinds. Set signatures=false for faster/smaller output.`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional: filter symbols whose name contains this substring (case-insensitive). Omit for all symbols.' },
          kinds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: filter by symbol kinds. Valid values: class, method, function, interface, enum, constructor, property, module, namespace, struct, variable, constant. Omit for all important kinds.'
          },
          max_files: { type: 'integer', description: 'Max number of files to include in result (default: 500, max: 1000)' },
          signatures: { type: 'boolean', description: 'Include function/method signatures extracted from source (default: true). Set false for faster output.' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'tasks',
      description: `Manage a visible task checklist displayed in the chat UI. Use this to show your plan to the user and track progress step-by-step.

Actions (use this tool ONLY for):
- "set" — replace the full list. Requires: tasks (array of strings)
- "add" — append task(s). Requires: task (string) OR tasks (array of strings)

ZERO-COST STATUS UPDATES — to mark tasks done, change text, or clear the list,
DO NOT call this tool. Instead, append this tag at the END of your text response:
  <tasks>{"done":[0,1,2]}</tasks>
  <tasks>{"done":[0], "update":[{"index":1,"text":"new description","done":true}]}</tasks>
  <tasks>{"clear":true}</tasks>
Fields: done (number[] of 0-based indexes), update ({index,text?,done?}[]), clear (boolean).
The system processes and strips this tag automatically — it costs zero input tokens.`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set', 'add'], description: 'Action to perform: "set" replaces the full list, "add" appends tasks' },
          tasks: { type: 'array', items: { type: 'string' }, description: '[set/add] Array of task strings' },
          task: { type: 'string', description: '[add] Single task string to append' }
        },
        required: ['action']
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
      name: 'lsp',
      description: `Query the IDE Language Server for code intelligence. This gives you precise, compiler-level information about code — far more accurate than text search.

Operations:
- "definitions" — Go to definition of symbol at position. Returns file path + line.
- "references" — Find ALL usages of a symbol across the entire project. Essential before renaming or refactoring.
- "hover" — Get type signature and documentation for a symbol.
- "symbols" — List all symbols (functions, classes, variables, types) in a file with their line numbers. Does NOT require line/symbol_name.
- "type_definition" — Go to the type definition (e.g., interface/class that defines the type).
- "implementations" — Find all implementations of an interface or abstract class.
- "rename_preview" — Preview what a rename would change (files + positions). Does NOT apply the rename. Requires "new_name".

Position can be specified by line+character OR by symbol_name (auto-resolved via document symbols).`,
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['definitions', 'references', 'hover', 'symbols', 'type_definition', 'implementations', 'rename_preview'],
            description: 'The LSP operation to perform'
          },
          file_path: {
            type: 'string',
            description: 'Path to the file (absolute or relative to workspace)'
          },
          line: {
            type: 'number',
            description: '1-indexed line number. Required for all operations except "symbols" (unless symbol_name is provided)'
          },
          character: {
            type: 'number',
            description: '0-indexed character offset within the line. Defaults to 0 if omitted.'
          },
          symbol_name: {
            type: 'string',
            description: 'Name of the symbol to find. Alternative to line+character — the position is auto-resolved by searching document symbols.'
          },
          new_name: {
            type: 'string',
            description: 'New name for rename_preview operation'
          }
        },
        required: ['operation', 'file_path']
      }
    }
  },
  // ── ask_user ──────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: `Ask the user a clarifying question and wait for their answer before continuing.

Use this when:
- The task is ambiguous and proceeding without clarification could waste effort or produce the wrong result.
- The user needs to choose between two or more approaches.
- You need a preference, value, or confirmation you cannot infer from context.

Guidelines:
- Keep the question concise and direct.
- Provide 2-3 short option labels that cover the most likely answers.
- The user can also type a custom answer — options are suggestions, not a forced choice.
- Do NOT use this for trivial decisions you can make yourself.
- Do NOT ask more than one question per call.`,
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask. Be concise and specific.'
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 3,
            description: '2-3 short suggested answers the user can click. They may also type a custom response.'
          }
        },
        required: ['question', 'options']
      }
    }
  },
  // ── add_commit ────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'add_commit',
      description: `Create a checkpoint by backing up the current state of files in the workspace.

Use this BEFORE large refactoring or destructive changes so you can restore a known-good state later.
Think of it like "git commit" — but without requiring git; backups are stored in the session folder.

After creating a commit you can restore it with: get_commit(action="restore", commitId="<id>")`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Short descriptive name for this checkpoint, e.g. "Before refactoring agent loop"'
          },
          scope: {
            type: 'string',
            description: 'Path relative to workspace root to back up. Use "." for the entire workspace, or a subfolder like "src/Engine". Directories like node_modules and .git are always skipped.'
          }
        },
        required: ['name', 'scope']
      }
    }
  },
  // ── get_commit ────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_commit',
      description: `Manage session commits (checkpoints). Supports four actions:

- "list"    — Show all commits for the current session (id, name, scope, date, file count).
- "restore" — Overwrite workspace files with the contents from a commit. Requires commitId.
- "delete"  — Permanently delete a commit to free space. Requires commitId.
- "diff"    — Compare a commit snapshot with the current workspace state. Requires commitId.

Always call get_commit(action="list") first to see available commit IDs.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'restore', 'delete', 'diff'],
            description: 'Operation to perform'
          },
          commitId: {
            type: 'string',
            description: 'Commit ID (required for restore, delete, diff). Get IDs via action="list".'
          }
        },
        required: ['action']
      }
    }
  },
  // ── product_check ──────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'product_check',
      description: `Run automated QA checks on a live web page to detect visual, layout, and interaction bugs.

This tool launches a headless browser, navigates to the given URL, and performs comprehensive checks:
- Viewport overflow (elements causing horizontal scroll)
- Sibling overlap (layout bugs where elements cover each other)
- Covered interactive elements (buttons/links blocked by overlaying elements)
- Broken images and missing alt text
- Dead interactions (buttons with pointer-events:none, empty buttons)
- Alignment and sizing consistency in grid/flex containers
- Text clipping (overflow:hidden without ellipsis)
- Accessibility issues (missing labels, heading hierarchy, small tap targets)
- Console JavaScript errors
- Failed network requests (4xx/5xx responses)

All output is plain text — no screenshots or vision model required.

Use "responsive" viewport to check at mobile (375px), tablet (768px), and desktop (1440px) simultaneously.

Requires Chrome, Edge, or Chromium installed on the user's machine, and puppeteer-core npm package.`,
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Full URL to check (http:// or https://). Typically a local dev server like http://localhost:3000'
          },
          viewport: {
            type: 'string',
            description: 'Viewport to test. "mobile" (375px), "tablet" (768px), "desktop" (1440px, default), "responsive" (all three), or custom "WxH" like "1920x1080".'
          },
          checks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: specific checks to run. Values: "viewport", "overlap", "interactions", "alignment", "images", "accessibility". Default: all.'
          },
          wait_ms: {
            type: 'number',
            description: 'Milliseconds to wait after page load before running checks (for SPA hydration). Default: 2000, max: 15000.'
          }
        },
        required: ['url']
      }
    }
  },
];

/**
 * Read-only tool subset for Chat mode.
 * Chat mode can read and search but NOT modify files or run commands.
 */
export const chatTools: ToolSpec[] = tools.filter(t => 
  ['read_file', 'list_files', 'search', 'diagnose', 'fetch_url', 'web_search', 'xray_codebase', 'lsp'].includes(t.function.name)
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

    case 'terminal': {
      const termAction = (args.action ?? 'run').toLowerCase();
      if (termAction === 'run' || termAction === '') {
        if (!args.command || typeof args.command !== 'string') {
          return 'terminal action="run" requires command (string)';
        }
      } else if (termAction === 'write') {
        if (!args.input || typeof args.input !== 'string') {
          return 'terminal action="write" requires input (string)';
        }
      } else if (termAction !== 'read') {
        return `terminal: unknown action "${termAction}". Use "run", "write", or "read".`;
      }
      break;
    }

    case 'xray_codebase':
      // All parameters optional
      break;

    case 'tasks':
      if (!args.action || typeof args.action !== 'string') {
        return 'tasks requires action (string): "set" or "add"';
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

    case 'lsp': {
      if (!args.file_path || typeof args.file_path !== 'string') {
        return 'lsp requires file_path (string)';
      }
      const validOps = ['definitions', 'references', 'hover', 'symbols', 'type_definition', 'implementations', 'rename_preview'];
      if (!args.operation || !validOps.includes(args.operation)) {
        return `lsp requires operation (one of: ${validOps.join(', ')})`;
      }
      if (args.operation !== 'symbols') {
        if (typeof args.line !== 'number' && typeof args.symbol_name !== 'string') {
          return `lsp operation "${args.operation}" requires either "line" (number) or "symbol_name" (string)`;
        }
      }
      if (args.operation === 'rename_preview' && (!args.new_name || typeof args.new_name !== 'string')) {
        return 'lsp rename_preview requires new_name (string)';
      }
      break;
    }

    case 'product_check':
      if (!args.url || typeof args.url !== 'string') {
        return 'product_check requires url (string)';
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
        result = await terminalTool(args, workspaceRoot);
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
      case 'xray_codebase':
        result = await xrayCodebaseTool(args, workspaceRoot);
        break;
      case 'tasks':
        result = await tasksTool(args, _postMessage);
        break;
      case 'lsp':
        result = await lspBridgeTool(args, workspaceRoot);
        break;
      case 'product_check':
        result = await productCheckTool(args);
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
