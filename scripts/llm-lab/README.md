# On-device quick-add lab

A desktop stand-in for what a phone can do offline, used to design natural-language task entry. It is a lab, not product code: the shipped pieces are the Kotlin parser and the Prompt API wrapper in `app/` (see `docs/android/overview.md`).

Models and binaries stay out of the repo. By default they live in `~/ai` (`ALONGSIDE_AI_DIR` overrides it): a llama.cpp build in `llama.cpp/` (CPU) or `llama.cpp-cuda/`, and GGUF files in `models/` (Gemma 3n E2B `Q4_0` as the Gemini Nano stand-in, Gemma 3 1B `Q4_K_M` as a pessimistic bound).

| File | What it is |
| --- | --- |
| `nlparse.mjs` | Deterministic date, time and recurrence parser (JS prototype of `QuickAddParser.kt`). `node scripts/llm-lab/nlparse.mjs "water plants every sunday at 9am"` |
| `fixtures/parse-cases.json` | The parser's test table, shared with the Kotlin test |
| `nlparse.test.mjs` | `node --test scripts/llm-lab/nlparse.test.mjs` |
| `run.mjs` | Scores model strategies (one grammar-constrained JSON call, one unconstrained call with a retry, one question per field) on title, recurrence, kind and notes |
| `cases.json`, `cases-hard.json` | Inputs with expected non-date fields for `run.mjs` |
| `prompt.txt`, `fields.txt` | The prompt pieces `run.mjs` assembles |

```sh
# parser in front of the model, on the GPU (timings then say nothing about a phone)
LLM_PREPASS=1 LLM_BUILD=llama.cpp-cuda LLM_NGL=99 node scripts/llm-lab/run.mjs gemma-3n-E2B-it-Q4_0.gguf scripts/llm-lab/cases-hard.json
```

Other knobs: `LLM_MODES=json,free,split`, `LLM_CTX`, `LLM_THREADS`. Scores use a strict word-match for titles, so read the failures, not only the totals. The app's prompt (`QuickAddPrompt`) is a leaner variant of the lab's (no recurrence field, since the parser owns it) and has not been scored here.
