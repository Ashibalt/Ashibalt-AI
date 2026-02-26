# Ashibalt AI

> **Beta** — расширение активно дорабатывается. Будем рады обратной связи!

---

## Что это

**Ashibalt AI** — полноценный AI-агент для написания кода прямо в Visual Studio Code. Умеет не только отвечать на вопросы, но и самостоятельно редактировать файлы, запускать команды в терминале, искать по проекту, диагностировать ошибки и итеративно решать задачи.

## Возможности

- **Agent-режим** — автономное редактирование кода, создание файлов, запуск терминальных команд, итеративное решение задач через цикл агента
- **Chat-режим** — AI-ассистент только для чтения с доступом к контексту вашего проекта
- **Мульти-провайдер** — Ollama (локально, бесплатно), OpenRouter, Mistral, DeepSeek.
- **Браузер моделей** — поиск и добавление моделей прямо из интерфейса
- **Snapshot-система** — каждая правка файла создаёт снимок с кнопками Accept / Reject в редакторе
- **17 инструментов** — `read_file`, `edit_file`, `create_file`, `delete_file`, `list_files`, `search`, `terminal`, `xray_codebase`, `tasks`, `diagnose`, `lsp`, `fetch_url`, `web_search`, `ask_user`, `add_commit`, `get_commit`, `product_check`
- **Автономный терминал** — агент выполняет команды в выделенном терминале с автоматическим захватом вывода, обнаружением интерактивных промптов (y/n, пароль, выбор) и UI подтверждения для пользователя
- **Семантический анализ проекта[LSP]** — инструмент `xray_codebase` даёт структурный обзор кодовой базы: дерево файлов с сигнатурами функций/классов, константами, переменными и номерами строк. Поддержка Python, TypeScript, JavaScript, Go и других языков
- **Трекинг задач** — инструмент `tasks` позволяет агенту создавать структурированный список задач, отображаемый в UI чата с автоочисткой при новом запросе
- **Уточняющие вопросы** — инструмент `ask_user` позволяет агенту задать вопрос с вариантами ответов прямо в чате и дождаться ответа пользователя, не прерывая агентский цикл
- **Коммиты (бэкапы)** — инструменты `add_commit` / `get_commit`: git-аналог без git. Агент создаёт полные файловые бэкапы с именем и путём scope, может восстанавливать, удалять и сравнивать снапшоты с текущим состоянием
- **QA-проверка страниц** — инструмент `product_check`: headless-браузер проверяет веб-страницу на viewport overflow, наложения элементов, сломанные изображения, мёртвые кнопки, обрезанный текст, accessibility-проблемы, дублирующиеся ID и JS-ошибки. Автоматически открывает URL в браузере по умолчанию. Весь вывод — текст, Vision-модель не нужна
- **Синтаксический анализ** — tree-sitter для 14+ языков (TypeScript, Python, Rust, Go, C/C++, Java, Ruby и др.)
- **Контекст-менеджмент** — сжатие контекста при приближении к лимиту, управление окном контекста (до 256K)
- **Метрики** — расход токенов, кэш промптов, использование контекстного окна, **стоимость per-model** (`grok-4.1-fast: $0.000093`) и **остаток баланса** OpenRouter (`Balance: $1.03`)
- **Сессии** — история чатов с сохранением, переключением и поиском
- **Автовыбор Провайдера** - Подробнее в Changelog. 

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
│   ├── modelParams.ts        # Единый конфиг параметров модели (temp, top_p, max_tokens)
│   ├── toolCalling.ts        # Реестр и диспетчер инструментов
│   ├── diagnosticsEngine.ts  # Tree-sitter синтаксический анализ
│   ├── sseParser.ts          # Парсер SSE-потока
│   ├── stringMatcher.ts      # Нечёткий поиск строк для edit_file
│   ├── providerAutoSelect.ts # Автовыбор провайдера (кэш, цена, скорость)
│   ├── tools/                # Реализации инструментов
│   │   ├── readFileTool.ts
│   │   ├── editFileTool.ts
│   │   ├── fileManagementTools.ts
│   │   ├── searchTools.ts
│   │   ├── terminalTool.ts         # Автономный терминал (run, write_stdin, read)
│   │   ├── xrayCodebaseTool.ts     # Семантический анализ проекта
│   │   ├── tasksTool.ts            # Трекинг задач
│   │   ├── commitTool.ts           # add_commit / get_commit (бэкапы)
│   │   ├── productCheckTool.ts     # product_check (headless QA-аудит)
│   │   ├── lspBridgeTool.ts
│   │   ├── diagnoseTool.ts
│   │   ├── fetchUrlTool.ts
│   │   ├── webSearchTool.ts
│   │   └── toolUtils.ts
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
│   ├── commitManager.ts      # Git-аналог: бэкапы, restore, diff
│   └── snapshotDecorations.ts # Декорации в редакторе
│
├── Commands/
│   └── slashCommands.ts      # Слэш-команды (/fix, /project_analysis, etc.)
│
└── Services/
    └── metricsService.ts     # Сервис метрик использования
```

## Веб-поиск

Инструмент `web_search` использует [Tavily API](https://tavily.com). Для его работы:
1. Зарегистрируйтесь на [tavily.com](https://tavily.com) и получите бесплатный API-ключ
2. Вставьте ключ в `src/Engine/tools/webSearchTool.ts` в переменную `apiKey`

## Приватность

- API-ключи хранятся локально в секретном хранилище VS Code
- Данные передаются только между вашим компьютером и выбранным AI-провайдером


## Лицензия

MIT — см. файл [LICENSE](LICENSE).

## Контакты

- [Поддержать проект](https://dalink.to/ashibalt)
