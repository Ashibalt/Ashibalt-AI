# Ashibalt AI

> **Beta** — расширение активно дорабатывается. Будем рады обратной связи!

---

## Что это

**Ashibalt AI** — полноценный AI-агент для написания кода прямо в Visual Studio Code. Умеет не только отвечать на вопросы, но и самостоятельно редактировать файлы, запускать команды в терминале, искать по проекту, диагностировать ошибки и итеративно решать задачи.

## Возможности

- **Agent-режим** — автономное редактирование кода, создание файлов, запуск терминальных команд, итеративное решение задач через цикл агента
- **Chat-режим** — AI-ассистент только для чтения с доступом к контексту вашего проекта
- **4 провайдера** — Ollama (локально), OpenRouter, Mistral, DeepSeek
- **Браузер моделей** — поиск и добавление моделей прямо из интерфейса
- **Snapshot-система** — каждая правка файла создаёт снимок с кнопками Accept / Reject в редакторе
- **11 инструментов** — `read_file`, `edit_file`, `create_file`, `delete_file`, `list_files`, `search`, `terminal`, `write_to_terminal`, `read_terminal_output`, `diagnose`, `fetch_url`
- **Синтаксический анализ** — tree-sitter для 14+ языков (TypeScript, Python, Rust, Go, C/C++, Java, Ruby и др.)
- **Контекст-менеджмент** — сжатие контекста при приближении к лимиту, управление окном контекста (до 128K)
- **Метрики** — расход токенов, кэш промптов, использование контекстного окна
- **Сессии** — история чатов с сохранением, переключением и поиском

## Быстрый старт

1. Установите расширение из VS Code Marketplace
2. Откройте боковую панель Ashibalt (иконка в Activity Bar)
3. Откройте ⚙️ Настройки, выберите провайдера и введите API-ключ:
   - **Ollama** — установите [Ollama](https://ollama.com), запустите модель локально (бесплатно)
   - **OpenRouter** — получите API-ключ на [openrouter.ai](https://openrouter.ai)
   - **Mistral / DeepSeek** — введите API-ключ
4. Выберите модель и начните работу!

## Архитектура проекта

```
src/
├── extension.ts              # Точка входа расширения
├── promptUtils.ts            # Системные промпты (Agent, Chat)
├── chatClientFactory.ts      # Фабрика HTTP-клиентов для провайдеров
├── constants.ts              # Общие константы (игнор-списки)
├── logger.ts                 # Логирование
├── iconMap.ts                # Иконки файлов
│
├── Config/                   # Конфигурация
│   ├── config.ts             # Загрузка настроек из VS Code
│   └── configManager.ts      # Управление списком моделей
│
├── Engine/                   # Ядро AI-агента
│   ├── agentLoop.ts          # Основной цикл агента (tool calling loop)
│   ├── agentErrors.ts        # Парсинг ошибок API, восстановление JSON
│   ├── fetchWithTools.ts     # HTTP-запросы к chat/completions
│   ├── toolCalling.ts        # Реестр и диспетчер инструментов
│   ├── diagnosticsEngine.ts  # Tree-sitter синтаксический анализ
│   ├── sseParser.ts          # Парсер SSE-потока
│   ├── stringMatcher.ts      # Нечёткий поиск строк для edit_file
│   ├── tools/                # Реализации инструментов
│   │   ├── readFileTool.ts
│   │   ├── editFileTool.ts
│   │   ├── fileManagementTools.ts
│   │   ├── searchTools.ts
│   │   ├── terminalTool.ts
│   │   └── ...
│   ├── SystemContext/        # Управление контекстом
│   │   ├── contextSummarizer.ts  # Сжатие/подготовка сообщений
│   │   ├── contextCache.ts       # Кэш прочитанных файлов
│   │   ├── contextHelpers.ts     # Вспомогательные утилиты
│   │   └── memoryManager.ts      # Межсессионная память
│   └── OpenRouter/
│       └── openRouterClient.ts   # Запросы к каталогу моделей OpenRouter
│
├── WebView/                  # UI чата
│   ├── ChatViewProvider.ts   # Основной провайдер webview (extension host)
│   ├── script.js             # Клиентский JS (UI-логика)
│   ├── style.css             # Стили
│   ├── chatView.html         # HTML-шаблон
│   ├── chatViewHtml.ts       # Генерация HTML
│   └── snapshotHandler.ts    # Обработка снэпшотов в webview
│
├── Storage/                  # Хранение данных
│   ├── storageManager.ts     # Сессии, сообщения, метрики
│   ├── snapshotManager.ts    # Файловые снэпшоты
│   └── snapshotDecorations.ts # Декорации в редакторе
│
├── Commands/
│   └── slashCommands.ts      # Слэш-команды (/fix, /project_analysis, etc.)
│
└── Services/
    └── metricsService.ts     # Сервис метрик использования
```

## Приватность

- API-ключи хранятся локально в секретном хранилище VS Code
- Данные передаются только между вашим компьютером и выбранным AI-провайдером


## Лицензия

MIT — см. файл [LICENSE](LICENSE).

## Контакты

- [GitHub](https://github.com/Ashibalt-AI)
- [Поддержать проект](https://dalink.to/ashibalt)
