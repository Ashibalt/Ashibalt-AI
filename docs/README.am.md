# Ashibalt AI

> **Բետա** — ակտիվ մշակման փուլում է։ Հետադարձ կապը ողջունելի է!

---

## Ինչ է սա

**Ashibalt AI**-ը Visual Studio Code-ի համար նախատեսված լիարժեք AI կոդավորման գործակալ է։ Այն ոչ միայն պատասխանում է հարցերին, այլ կարող է ինքնուրույն խմբագրել ֆայլեր, գործարկել տերմինալային հրամաններ, որոնել ձեր նախագծում, ախտորոշել սխալներ և կրկնողաբար լուծել բարդ խնդիրներ։

## Հնարավորություններ

- **Գործակալի ռեժիմ** — կոդի ինքնավար խմբագրում, ֆայլերի ստեղծում, տերմինալային հրամաններ, կրկնողական խնդիրների լուծում
- **Չաթի ռեժիմ** — կարդալ-միայն AI օգնական՝ ձեր կոդային բազայի համատեքստով
- **8 մատակարար** — Ollama (տեղական, անվճար), OpenRouter, Mistral, DeepSeek, OpenAI, Claude, Grok, Gemini
- **Մոդելների դիտարկիչ** — մոդելների որոնում և ավելացում անմիջապես UI-ից
- **Snapshot համակարգ** — ֆայլի յուրաքանչյուր խմբագրում ստեղծում է վերականգնելի snapshot՝ ներկառուցված Accept / Reject կոճակներով
- **12 գործիք** — `read_file`, `edit_file`, `create_file`, `delete_file`, `list_files`, `search`, `terminal`, `write_to_terminal`, `read_terminal_output`, `diagnose`, `fetch_url`, `web_search`
- **Շարահյուսության ստուգում** — tree-sitter հիմքով վերլուծություն 14+ լեզուների համար (TypeScript, Python, Rust, Go, C/C++, Java, Ruby և այլն)
- **Համատեքստի կառավարում** — ավտոմատ սեղմում սահմանների մոտ, համատեքստի պատուհանի կառավարում (մինչև 256K)
- **Չափումներ** — իրական token-ների օգտագործում, prompt cache ցուցադրում, համատեքստի պատուհանի օգտագործում
- **Նիստեր** — կայուն չաթի պատմություն՝ անցման և որոնման հնարավորությամբ

## Արագ մեկնարկ

1. Տեղադրեք ընդլայնումը VS Code Marketplace-ից
2. Բացեք Ashibalt-ի կողագոտին (Activity Bar-ի պատկերակ)
3. Բացեք ⚙️ Կարգավորումները, ընտրեք մատակարար և մուտքագրեք ձեր API բանալին.
   - **Ollama** — տեղադրեք [Ollama](https://ollama.com), գործարկեք մոդել տեղականորեն (անվճար)
   - **OpenRouter** — ստացեք API բանալի [openrouter.ai](https://openrouter.ai)-ում
   - **Mistral / DeepSeek** — մուտքագրեք API բանալի
4. Ընտրեք մոդել և սկսեք կոդավորել!

## Նախագծի կառուցվածք

```
src/
├── extension.ts              # Ընդլայնման մուտքի կետ
├── promptUtils.ts            # Համակարգային prompt-ներ (Գործակալ, Չաթ)
├── chatClientFactory.ts      # HTTP client-ի ֆաբրիկա մատակարարների համար
├── constants.ts              # Ընդհանուր հաստատուններ (անտեսման ցուցակներ)
│
├── Config/                   # Կարգավորում
│   ├── config.ts             # VS Code կարգավորումների բեռնիչ
│   └── configManager.ts      # Մոդելների ցանկի կառավարում
│
├── Engine/                   # AI գործակալի հիմք
│   ├── agentLoop.ts          # Գործակալի հիմնական հանգույց (գործիքների կանչ)
│   ├── agentErrors.ts        # API սխալների վերլուծություն, JSON վերականգնում
│   ├── fetchWithTools.ts     # HTTP հարցումներ chat/completions-ին
│   ├── modelParams.ts        # Մոդելի կենտրոնացված պարամետրեր (temp, top_p, max_tokens)
│   ├── toolCalling.ts        # Գործիքների ռեեստր և dispatcher
│   ├── diagnosticsEngine.ts  # Tree-sitter շարահյուսության վերլուծություն
│   ├── sseParser.ts          # SSE հոսքի վերլուծիչ
│   ├── tools/                # Գործիքների իրականացումներ
│   └── SystemContext/        # Համատեքստի կառավարում
│
├── WebView/                  # Չաթի UI
│   ├── ChatViewProvider.ts   # Webview-ի հիմնական provider (ընդլայնման հոստ)
│   ├── script.js             # Կողմնային JS (UI տրամաբանություն)
│   ├── style.css             # Ոճեր
│   └── chatViewHtml.ts       # HTML գեներացիա
│
├── Storage/                  # Տվյալների պահպանություն
│   ├── storageManager.ts     # Նիստեր, հաղորդագրություններ, չափումներ
│   ├── snapshotManager.ts    # Ֆայլի snapshot-ներ
│   └── snapshotDecorations.ts # Խմբագրիչի դեկորացիաներ
│
├── Commands/
│   └── slashCommands.ts      # Slash հրամաններ (/fix, /project_analysis և այլն)
│
└── Services/
    └── metricsService.ts     # Օգտագործման չափումների ծառայություն
```

## Վեբ-որոնում

`web_search` գործիքն օգտագործում է [Tavily API](https://tavily.com)։ Այն ակտիվացնելու համար՝
1. Գրանցվեք [tavily.com](https://tavily.com)-ում և ստացեք անվճար API բանալի
2. Տեղադրեք բանալին `src/Engine/tools/webSearchTool.ts` ֆայլի `apiKey` փոփոխականում

## Գաղտնիություն

- API բանալիները պահվում են տեղականորեն VS Code-ի անվտանգ գաղտնի պահոցում
- Տվյալները փոխանցվում են միայն ձեր մեքենայի և ընտրված AI մատակարարի միջև

## Լիցենզիա

MIT — տե՛ս [LICENSE](LICENSE)։

## Հղումներ

- [Աջակցություն](https://dalink.to/ashibalt)
