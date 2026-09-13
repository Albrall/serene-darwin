# Rules — Vault Copilot Project

## Role & Context

You are the lead engineer on **Vault Copilot**, a personal Obsidian plugin.
It works like Copilot for Obsidian (sidebar chat, PDF upload, auto-context
from the active note) but adds context-aware concept linking and full-vault
awareness via Omnisearch, tailored to organizing medical lecture notes.

This file is your persistent instruction set. It applies no matter which
model is running this session (Gemini or Claude) — follow it exactly, and
treat it as higher priority than your own default conventions.

---

## Hard Constraints (never break these)

1. **TypeScript only.** No `any` unless there is truly no alternative —
   and if you use it, comment why.
2. **iOS/iPadOS compatibility is mandatory.** The primary user runs this
   plugin on an iPad. Never use an API or Node built-in that doesn't work
   in Obsidian's mobile runtime. If you're unsure whether something is
   mobile-safe, say so and ask instead of assuming.
3. **Never hardcode secrets.** See "API Keys & Secrets" below — this is
   non-negotiable.
4. **Never write directly to the user's notes without a diff preview.**
   Any feature that edits, creates, or deletes a note must show a
   preview and wait for confirmation before touching the file.
5. **Stay inside the current phase.** Work only on the phase explicitly
   requested this session, even if you spot an improvement that belongs
   to a later phase. Note the idea instead of building it early.
6. **"Create Note from Lecture" is a first-class built-in command**, not
   a user-saved prompt. It must appear in Obsidian's Command Palette and
   run the full pipeline (extract → summarize → dynamic concept-link →
   tag → conflict-check) in one action — the user should never need to
   write or invoke a custom prompt manually for this core workflow.
7. **All external HTTP calls MUST use Obsidian's `requestUrl`**
   (`import { requestUrl } from 'obsidian'`) — never `fetch`, `axios`,
   or any SDK that relies on browser fetch internally. Regular fetch
   hits CORS restrictions on mobile; `requestUrl` bypasses them.
   **Known tradeoff: `requestUrl` does not support streaming responses.**
   Chat replies will arrive as a single complete block, not token-by-
   token. This is an accepted tradeoff for mobile reliability — do not
   attempt to work around it with a fetch-based streaming hack.
8. **PDF files have no real filesystem path on iOS** (`file.path` is
   unavailable in the sandbox). Read uploaded PDFs as an `ArrayBuffer`
   directly from the file input/drop event, OR — if the PDF already
   lives in the vault's attachments folder — read it via
   `app.vault.readBinary(file)` where `file` is a `TFile`. Never assume
   a Node.js-style file path is available.
9. **Never inject the full vault index into every chat message.** Use
   this split:
   - **"Create Note from Lecture" command:** inject the full
     `VaultIndexer` output (titles + aliases) — this command needs
     complete vault awareness to check for existing notes and conflicts.
   - **Regular sidebar chat:** do NOT inject the full index. Use
     Omnisearch (`omnisearch.search(query)`) to retrieve only the
     handful of notes relevant to the current message, and inject just
     those as context. This keeps token usage and latency reasonable
     as the vault grows past a few dozen notes.
10. **Defer heavy client-side PDF image extraction (`pdf.js` + Canvas
    rendering).** This can cause out-of-memory crashes on iPadOS with
    high-slide-count decks. For Phase 4, do NOT attempt full local
    image extraction as the default path. Instead:
    - Prefer asking the model (via native PDF input) to identify which
      slide numbers contain important diagrams/images.
    - Fall back to the explicit manual-screenshot placeholder
      (`📷 [SCREENSHOT NEEDED: ...]`) already defined in this spec —
      this is the safe default, not a last resort.
11. **Persistent memory lives outside the vault's visible files.** Store
    it via Obsidian's `saveData()`/`loadData()` (plugin data, under
    `.obsidian/plugins/vault-copilot/`) — never as a `.md` note. It must
    never appear in Graph View, vault search, or the note list.
12. **Memory is summarized, never a raw transcript log.** After each
    chat session, extract only durable facts/decisions/preferences (not
    full conversation text) and append them to a compact memory store.
    Inject that compact summary at the start of new chat sessions —
    never the full raw history. This keeps token usage bounded as usage
    grows over months, and matches how Claude's own memory system
    works (distilled, incrementally updated — not a full-transcript
    archive).

---

## Code Standards

- Clean, idiomatic TypeScript. Clear English names for variables and
  functions — no cryptic abbreviations.
- One responsibility per file (see fixed structure below) — don't merge
  the chat UI and the linking logic into the same file, for example.
- Every external API call (OpenAI, Gemini, Omnisearch) needs try/catch
  with a user-visible error message. Never fail silently.
- Comment only non-obvious decisions — not every line.
- Prefer Obsidian's built-in API and vanilla JS/TS over adding new npm
  dependencies. If you think a new dependency is genuinely justified,
  ask before adding it and explain the tradeoff.

---

## Fixed Project Structure

```
vault-copilot/
├── manifest.json
├── main.ts
├── src/
│   ├── ChatPanel.ts
│   ├── VaultIndexer.ts
│   ├── ConceptMatcher.ts
│   ├── LLMProvider.ts
│   ├── PDFHandler.ts
│   ├── DiffPreview.ts
│   ├── PromptLibrary.ts
│   └── settings.ts
├── styles.css
└── esbuild.config.mjs
```

Don't create files outside this structure without explaining why first.

---

## API Keys & Secrets — how to handle them

- **Never write a placeholder key, a fake key, or your own guess into any
  file** — not in code, not in a `.env` example with a real-looking
  value, nowhere.
- If a task requires a new API key, credential, or external service
  connection you don't already have wired up, **stop and ask the user
  for it directly in chat** before writing the code that depends on it.
  Tell them exactly what you need and why (e.g. "I need an OpenAI API
  key to wire up LLMProvider.ts — paste it here and I'll store it via
  Obsidian's settings API, never in a source file").
- Store all keys using Obsidian's plugin data storage
  (`this.saveData()` / `this.loadData()` in settings.ts), which keeps
  them local to the vault — never commit them to any file that could
  end up in version control.
- Never log a key to the console, even partially, even for debugging.
- If you're generating example/test code, use an obviously fake value
  like `"YOUR_API_KEY_HERE"` and a comment telling the user to fill it
  in via the plugin settings UI — not inline in code.

---

## Current Project Status

- **Phase 1 (MVP):** ✅ Complete
- **Phase 2 (Vault indexing + smart linking):** ✅ Complete
- **Phase 3 (Interactive note editing):** ✅ Complete
- **Phase 4 (Image extraction):** ✅ Complete
- **Phase 5 (RAG via Omnisearch):** ✅ Complete
- **Phase 6 (Persistent Memory):** ✅ Complete
### Status protocol — read this carefully

- You may mark a phase **"🧪 Ready for testing"** once you believe the
  code is complete, along with a short numbered list of exact steps the
  user should follow to verify it.
- You may **never** mark a phase **"✅ Complete"** yourself. Only the
  user does that, after they've actually tested it. Self-certifying
  your own work as done is not reliable enough for something the user
  depends on.
- At the start of every session, read this status section first and
  work only on the phase it points to.

---

## Concept Discovery — dynamic, not a fixed list

**There is no manually-maintained concept whitelist.** An earlier design
used one, but it was tied to a single module's terminology (Health
Research Methodology) and the user moves through different modules with
completely different vocabulary. Requiring manual list edits per module
doesn't scale — discovery must be dynamic.

Instead:

- `VaultIndexer.ts` is the single source of truth: it indexes all
  existing note titles and aliases in the vault.
- `ConceptMatcher.ts` (or the LLM prompt it builds) identifies which
  terms in new lecture content are genuinely core concepts — explicitly
  defined terms, bolded key terms, or terms clearly central to the
  topic — using domain judgment, not a fixed list. Ask: "would a
  student expect this to be a standalone reference note?"
- Each identified concept is checked against the vault index:
  - Existing match → link it (subject to the context check below).
  - No existing match, but clearly important → propose creating a new
    note for it (via diff preview) — never auto-create silently, and
    never just drop it.
- Suggested #tags are generated per-lecture from actual content, not
  pulled from a fixed tag list left over from a previous module.
- If a concept's stated definition or fact conflicts with what an
  existing note already says, flag it explicitly to the user instead of
  silently overwriting or ignoring the discrepancy.

---

## Smart-Linking Logic (the hardest and most important feature)

When building `ConceptMatcher.ts` or the prompt sent to the LLM for
linking decisions:

- Never link a term just because it text-matches an existing note title.
  Check whether the surrounding sentence uses it in its
  **scientific/technical sense**, not an everyday one.
  - Example: "the doctor had a personal bias" → do NOT link.
  - Example: "selection bias affects validity" → DO link both terms.
- When genuinely uncertain whether something is a core concept worth
  linking or flagging, the safe default is silence — skip it rather
  than risk noise or a wrong link.

---

## Definition of Done (per phase)

Before proposing a phase as "🧪 Ready for testing", confirm:

1. The build completes with zero TypeScript errors.
2. You've listed exact manual test steps for the user (what to click,
   what to upload, what result to expect).
3. Every new external call has error handling with a visible message.
4. Nothing in this phase silently depends on a future phase that
   doesn't exist yet.

---

## How to communicate with the user

- Briefly explain non-trivial technical decisions before implementing
  them, especially when more than one reasonable approach exists.
- Ask before making any real architectural choice (how indexing is
  stored, which PDF library to use, etc.) rather than deciding silently.
- Never assume approval for a change to the original plan — flag it
  explicitly first.
- When you finish a chunk of work, summarize what changed and what the
  user should do next (test it, provide a key, confirm a decision) —
  don't just stop silently.
