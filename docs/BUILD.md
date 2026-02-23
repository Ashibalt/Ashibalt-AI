# Build & Development Guide

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- **npm** 9+
- **VS Code** 1.106.0+
- **Git**

## Quick Start

```bash
# Clone the repository
git clone https://github.com/Ashibalt-AI/ashibalt-ai.git
cd ashibalt-ai

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode (recompiles on changes)
npm run watch
```

## Running in Development

1. Open the project folder in VS Code
2. Press **F5** — this launches a new Extension Development Host window
3. The extension will be available in the sidebar of the new window

> If F5 doesn't work, make sure VS Code has a launch configuration. Create `.vscode/launch.json`:
> ```json
> {
>   "version": "0.2.0",
>   "configurations": [
>     {
>       "name": "Run Extension",
>       "type": "extensionHost",
>       "request": "launch",
>       "args": ["--extensionDevelopmentPath=${workspaceFolder}"]
>     }
>   ]
> }
> ```

## Available Scripts

| Command              | Description                          |
| -------------------- | ------------------------------------ |
| `npm run compile`    | One-shot TypeScript compilation      |
| `npm run watch`      | Watch mode — recompile on save       |
| `npm test`           | Run tests (Vitest)                   |
| `npx @vscode/vsce package` | Build `.vsix` package        |

## Building a VSIX Package

```bash
# Install vsce if not already available
npm install -g @vscode/vsce

# Package the extension
vsce package
```

This creates `ashibalt-ai-<version>.vsix` in the project root.

To install locally:
```bash
code --install-extension ashibalt-ai-*.vsix
```

## Project Structure

```
src/
├── extension.ts              # Extension entry point
├── promptUtils.ts            # System prompts (Agent, Chat)
├── chatClientFactory.ts      # HTTP client factory for providers
├── constants.ts              # Shared constants (ignore lists)
│
├── Config/                   # Configuration
│   ├── config.ts             # VS Code settings loader
│   └── configManager.ts      # Model list management
│
├── Engine/                   # AI Agent core
│   ├── agentLoop.ts          # Main agent loop (tool calling)
│   ├── agentErrors.ts        # API error parsing, JSON recovery
│   ├── fetchWithTools.ts     # HTTP requests to chat/completions
│   ├── modelParams.ts        # Centralized model parameters (temp, top_p, max_tokens)
│   ├── toolCalling.ts        # Tool registry and dispatcher
│   ├── diagnosticsEngine.ts  # Tree-sitter syntax analysis
│   ├── sseParser.ts          # SSE stream parser
│   ├── providerAutoSelect.ts # Auto-selection of provider (cache, price, speed)
│   ├── tools/                # Tool implementations
│   └── SystemContext/        # Context management
│
├── WebView/                  # Chat UI
│   ├── ChatViewProvider.ts   # Main webview provider (extension host)
│   ├── script.js             # Client-side JS (UI logic)
│   ├── style.css             # Styles
│   └── chatViewHtml.ts       # HTML generation
│
├── Storage/                  # Data persistence
│   ├── storageManager.ts     # Sessions, messages, metrics
│   ├── snapshotManager.ts    # File snapshots
│   └── snapshotDecorations.ts # Editor decorations
│
├── Commands/
│   └── slashCommands.ts      # Slash commands (/fix, /project_analysis, etc.)
│
└── Services/
    └── metricsService.ts     # Usage metrics service
```

## Tests

```bash
npm test
```

Tests use **Vitest** with a VS Code API mock (`test/__mocks__/vscode.ts`).

## Tech Stack

- **TypeScript** — main language (ES2022 target, CommonJS modules)
- **VS Code Extension API** — webview, commands, decorations, secrets, terminals
- **tree-sitter** (via `web-tree-sitter`) — syntax analysis for 14+ languages
- **SSE streaming** — real-time response rendering
- **Vitest** — test runner

## License

MIT — see [LICENSE](LICENSE).
