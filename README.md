# Ashibalt AI

> **Beta** — actively developed. Feedback is welcome!

---

## What is it

**Ashibalt AI** is a full-featured AI coding agent for Visual Studio Code. It doesn't just answer questions — it can autonomously edit files, run terminal commands, search your project, diagnose errors, and iteratively solve complex tasks.

## Features

- **Agent Mode** — autonomous code editing, file creation, terminal commands, iterative problem solving via agent loop
- **Chat Mode** — read-only AI assistant with your codebase context
- **8 Providers** — Ollama (local, free), OpenRouter, Mistral, DeepSeek, OpenAI, Claude, Grok, Gemini
- **Model Browser** — search and add models directly from the UI
- **Snapshot System** — every file edit creates a recoverable snapshot with inline Accept / Reject buttons
- **12 Tools** — `read_file`, `edit_file`, `create_file`, `delete_file`, `list_files`, `search`, `terminal`, `write_to_terminal`, `read_terminal_output`, `diagnose`, `fetch_url`, `web_search`
- **Syntax Checking** — tree-sitter based analysis for 14+ languages (TypeScript, Python, Rust, Go, C/C++, Java, Ruby, etc.)
- **Context Management** — automatic context compression near limits, context window management (up to 256K)
- **Metrics** — real token usage, prompt cache display, context window utilization
- **Sessions** — persistent chat history with switching and search

## Quick Start

1. Install the extension from VS Code Marketplace
2. Open the Ashibalt sidebar (icon in the Activity Bar)
3. Open ⚙️ Settings, choose a provider and enter your API key:
   - **Ollama** — install [Ollama](https://ollama.com), run a model locally (free)
   - **OpenRouter** — get an API key at [openrouter.ai](https://openrouter.ai)
   - **Mistral / DeepSeek** — enter API key
4. Pick a model and start coding!

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

## Web Search

The `web_search` tool uses [Tavily API](https://tavily.com). To enable it:
1. Sign up at [tavily.com](https://tavily.com) and get a free API key
2. Paste the key into `src/Engine/tools/webSearchTool.ts` in the `apiKey` variable

## Privacy

- API keys are stored locally in VS Code's secure secret storage
- Data is only transmitted between your machine and the chosen AI provider


## License

MIT — see [LICENSE](LICENSE).

## Links

- [Support](https://dalink.to/ashibalt)
