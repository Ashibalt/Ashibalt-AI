# Ashibalt AI

> **Beta** — the extension is under active development. Feedback is welcome!
>
> **Бета** — расширение активно дорабатывается. Будем рады обратной связи!

---

## What is it / Что это

**Ashibalt AI** is a full-featured AI coding agent for Visual Studio Code. It doesn't just answer questions — it can autonomously edit files, run terminal commands, search your project, diagnose errors, and iteratively solve complex tasks.

**Ashibalt AI** — полноценный AI-агент для написания кода прямо в Visual Studio Code.

## Features / Возможности

- **Agent Mode** — autonomous code editing, file creation, terminal commands, iterative problem solving
- **Chat Mode** — read-only AI assistant with your codebase context
- **4 Providers** — Ollama (local, free), OpenRouter, Mistral, DeepSeek
- **Model Browser** — search and add models directly from the UI
- **Snapshot System** — every file edit creates a recoverable snapshot with inline Accept / Reject buttons
- **11 Tools** — `read_file`, `edit_file`, `create_file`, `delete_file`, `list_files`, `search`, `terminal`, `write_to_terminal`, `read_terminal_output`, `diagnose`, `fetch_url`
- **Syntax Checking** — tree-sitter based analysis for 14+ languages
- **Context Management** — automatic context compression, context window management (up to 128K)
- **Metrics** — real token usage, prompt cache display, context window utilization
- **Sessions** — persistent chat history with switching and search

## Quick Start / Быстрый старт

1. Install the extension from VS Code Marketplace
2. Open the Ashibalt sidebar (icon in the Activity Bar)
3. Open ⚙️ Settings, choose a provider and enter your API key:
   - **Ollama** — install [Ollama](https://ollama.com), run a model locally (free)
   - **OpenRouter** — get an API key at [openrouter.ai](https://openrouter.ai)
   - **Mistral / DeepSeek** — enter API key
4. Pick a model and start coding!

## Privacy / Приватность

- API keys are stored locally in VS Code's secure secret storage
- Data is only transmitted between your machine and the chosen AI provider
- No third-party telemetry

## License

MIT — see [LICENSE](LICENSE).

## Links

- [GitHub](https://github.com/Ashibalt-AI/ashibalt-ai)
- [Support / Поддержать](https://dalink.to/ashibalt)

---

See also: [README (Русский)](README.ru.md) · [README (English)](README.en.md)
