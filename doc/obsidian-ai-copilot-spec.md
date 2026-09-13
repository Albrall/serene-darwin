# Project Spec: Obsidian Plugin — "Vault Copilot"

## Goal

A personal Obsidian plugin, used the same way as Copilot for Obsidian
(sidebar chat, auto-context from the active note), but with finer
control and extra features tailored to a medical-lecture-notes workflow.

---

## Features (in priority order)

### Phase 1 — MVP (core, works from day one)

1. **Sidebar chat panel** — same location and feel as Copilot for
   Obsidian.
2. **File upload (PDF/MD/TXT)** — drag-and-drop or an attach button,
   sends the file directly to the model (native PDF input via the
   Gemini/OpenAI API — not an intermediate text-extraction step).
3. **Multi-model support (BYOK)** — enter an OpenAI and/or Gemini key,
   pick the model from a dropdown (gpt-5.4-mini, gemini-3.1-flash-lite,
   etc.).
4. **Saved shortcut prompts** — same idea as Custom Prompts, invoked
   with `/`.
5. **"Save to Note"** — save the model's reply as a new note, or append
   it to an existing one, in one click.
6. **Built-in "Create Note from Lecture" command** — a fixed command in
   the Command Palette (not a user-saved prompt). Opens a file picker,
   you choose a PDF, and it runs the full pipeline: extract →
   summarize → smart-link → tag → conflict-check, using the same fixed
   rules — no need to write or invoke any prompt manually each time.

### Phase 2 — Understanding the vault's structure (the most important part)

**⚠️ Important change from the original design:** there is no
manually-maintained concept whitelist. Reason: the original list was
tied to the "Health Research Methodology" module only, and every new
module will have completely different terminology — the user shouldn't
have to go edit settings every time a new topic starts. Discovery must
be **dynamic and automatic**.

7. **Vault indexing** — the plugin reads every existing note title +
   alias and builds an internal "concept map" from them — this is the
   single source of truth, not a separate manual list.
8. **Dynamic concept discovery** — instead of a fixed list, the model
   analyzes the lecture content itself and identifies terms that read
   as "core concepts" in context (explicit definitions, bolded key
   terms, recurring subheadings in a medical/research domain) — the
   same judgment a subject-matter expert would use reading a lecture
   and deciding what deserves its own reference note.
9. **Match against the existing vault first** — for every discovered
   concept, check whether it already has a matching note (via
   VaultIndexer) before deciding to link it.
10. **Propose a new note for new concepts** — if a concept is important
    and has no matching note yet, the plugin **proposes** creating one
    (via preview, never silently automatic) instead of ignoring it or
    linking it nowhere.
11. **Context-aware smart linking** — even when a word matches a
    discovered concept, the model confirms it's used in its
    scientific/technical sense in that specific sentence (e.g.
    statistical "bias" vs. everyday "bias") — not blind text matching.
12. **Preview before applying (Diff View)** — any proposed change (new
    link, tag, new note, rewording) shows as a diff (green/red) and you
    approve it before it's actually applied.
13. **Automatic tags** — same discovery logic, suggests relevant
    #tags based on the actual lecture content, not a fixed tag list.
14. **Conflict detection** — if a concept already documented in an
    older note contradicts something in the new lecture (same term,
    different definition or number), explicitly flag it to the user
    instead of ignoring it or silently overwriting it.
15. **Automatic MOC update** — every new note is automatically linked
    to the central MOC note, no manual step.

### Phase 3 — Interactive editing

16. **Plain-language edit commands** — you type "add a section about
    Blinding" or "link this paragraph to Confounding" and the model
    edits the currently open note directly (with a preview first).
17. **Awareness of the currently open file** — any command you give is
    assumed to target the open note unless you specify otherwise.

### Phase 4 — Images and attachments

18. **PDF image extraction** — where possible (via a library like
    `pdf-lib` or `pdf.js` to extract images actually embedded in the
    PDF), auto-save them as files in the Attachments folder and insert
    `![[image.png]]` in the correct place in the note.
19. **Explicit fallback for what it can't do** — if an image can't be
    extracted (a diagram that's part of a slide screenshot, not a
    separate embedded image in the PDF), write clearly:
    `📷 [MANUAL SCREENSHOT NEEDED: description of the image and where
    it belongs]` — never invent a description or silently skip it.

### Phase 5 — "Vault brain" (RAG via Omnisearch + other plugins)

20. **Answering questions about the whole vault** — when asked a
    general question ("what did we cover about Confounding across all
    lectures?"), the plugin:
    a. Calls `omnisearch.search(query)` (Omnisearch's own public API)
       to get the best-matching notes.
    b. Injects the content of those notes as "context" in the system
       prompt.
    c. Asks the model to answer **based on that context only**, citing
       the source note names.
21. **Integration with other plugins via a general API** — Obsidian
    exposes `app.plugins.plugins['plugin-id']` to reach any enabled
    plugin and check whether it exposes an API (e.g. Dataview), so this
    can later extend beyond Omnisearch.
22. **Feature fusion** — any chat request ("summarize this lecture,
    link it to related concepts in the vault, and tell me if it
    conflicts with an older note") goes through the same pipeline:
    Omnisearch fetches context ← the model analyzes ← Diff Preview
    shows the proposed change.

**Illustrative TypeScript for calling Omnisearch from inside the plugin:**

```typescript
// inside ChatPanel.ts or VaultIndexer.ts
async function getRelevantContext(query: string): Promise<string> {
  const omnisearch = (window as any).omnisearch;
  if (!omnisearch) return ""; // plugin not enabled — fail silently
  const results = await omnisearch.search(query);
  return results
    .slice(0, 8) // top 8 results only (token budget)
    .map((r: any) => `### ${r.basename}\n${r.excerpt}`)
    .join("\n\n");
}
```

### Phase 6 — Persistent memory

**The idea:** the plugin has its own "memory" — completely separate
from the lecture notes — that stores context from your conversations
(decisions, preferences, topics you've settled on), automatically
loaded at the start of every new conversation, without ever appearing
in the lecture vault or affecting it.

23. **Storage location** — via Obsidian's built-in `saveData()` /
    `loadData()`, stored under `.obsidian/plugins/vault-copilot/` —
    completely hidden from Graph View, normal search, and the note
    list. **Not a `.md` note in the vault.**
24. **Summarized memory, not a raw archive** — it does not store full
    conversation text verbatim (that would bloat and burn tokens
    unnecessarily). Instead:
    - After each session, the model extracts only the durable
      facts/decisions worth keeping (e.g. "decided to use
      gpt-5.4-mini as the default model", "prefers formatting with no
      HTML tags").
    - These are appended as new lines to a compact memory store
      (`MemoryStore.ts`), not rewritten from scratch each time.
25. **Automatic recall** — at the start of every new sidebar chat
    session, it reads the compact memory file and injects it into the
    system prompt automatically — small (a few lines, not pages).
26. **No repeating yourself** — if you stated a preference in an old
    conversation, you don't need to restate it in a new one.

**Design note:** this mirrors how Claude's own memory system works
(continuously updated distilled summaries, not verbatim conversation
copies) — a proven pattern, not a theoretical experiment.

---

## Proposed Technical Architecture

```
vault-copilot/
├── manifest.json          # Obsidian plugin manifest
├── main.ts                 # entry point
├── src/
│   ├── ChatPanel.ts         # sidebar chat view
│   ├── VaultIndexer.ts      # indexes note titles/aliases
│   ├── ConceptMatcher.ts    # smart-linking logic (builds the system prompt)
│   ├── LLMProvider.ts       # unified layer for OpenAI/Gemini/Anthropic calls
│   ├── PDFHandler.ts        # PDF upload + image extraction (pdf.js/pdf-lib)
│   ├── DiffPreview.ts       # preview window for changes before applying
│   ├── PromptLibrary.ts     # manages saved shortcut prompts
│   ├── MemoryStore.ts       # persistent cross-session memory (Phase 6)
│   └── settings.ts          # settings page (API keys, preferences)
├── styles.css
└── esbuild.config.mjs      # build tool
```

**Core technologies:**
- TypeScript + the official Obsidian Plugin API
- esbuild for bundling (same as most Obsidian plugins)
- `pdf.js` (Mozilla) for local text/image extraction, when needed, or
  native PDF input directly to the model when supported
- Direct API calls, no heavy SDKs, for compatibility

**⚠️ Mandatory technical constraints (see `vault-copilot-rules.md` for
full detail):**
- All HTTP calls **exclusively via Obsidian's `requestUrl`**, never
  `fetch` or `axios` (to bypass mobile CORS restrictions) — but this
  means responses are not streamed; they arrive as one complete block.
- PDF upload: handle as an `ArrayBuffer` or as a `TFile` via
  `readBinary` — never assume a system file path (`file.path` does not
  exist on iOS).
- The full vault index is only injected for the "Create Note from
  Lecture" command, not on every regular chat message (use Omnisearch
  RAG for regular chat instead).
- `pdf.js`-based image extraction is deferred as the default path — risk
  of out-of-memory crashes on iPad — the manual screenshot fallback is
  the baseline, not a last resort.

---

## System Prompt Model for Dynamic Smart Linking (Phase 2)

Built dynamically from vault indexing only — no fixed list:

```
You are an Obsidian assistant helping organize a medical/academic vault.

Here are existing note titles and their aliases in this vault:
[VaultIndexer.ts output]

When processing new lecture content:

1. Identify genuinely important concepts in THIS content — terms that are
   explicitly defined, bolded as key terms, or clearly central to the
   topic (not every noun). Use domain judgment: would a student expect
   this to be a standalone reference note?

2. For each identified concept, check if it matches an existing note
   title or alias above.
   - If yes: use [[wikilink]] — but only where the term is used in its
     scientific/technical sense in that specific sentence, not an
     everyday coincidental use of the same word.
   - If no existing note matches but the concept is clearly important:
     flag it as "🆕 New concept — suggest creating a note: [Term]"
     instead of linking or ignoring it.

3. If uncertain whether a term qualifies as a core concept, do not link
   or flag it — silence is safer than noise.

4. Suggest 3-8 relevant #tags based on the actual content of this
   lecture — do not reuse a fixed tag list from a previous module.

5. If any identified concept's definition or key fact conflicts with
   what an existing note already says about it, flag it explicitly:
   "⚠️ Possible conflict with [[Existing Note]]: [describe the
   discrepancy]" — do not silently overwrite or ignore it.
```

---

## Proposed Implementation Plan (in order)

1. **Week 1:** MVP — sidebar chat + PDF upload + BYOK, no linking
   intelligence yet (equivalent to replacing Copilot Plus only).
2. **Week 2:** Vault indexing + dynamic concept discovery + Diff
   Preview.
3. **Week 3:** Interactive editing commands on the open note.
4. **Week 4:** Image extraction (the hardest technical part — can stay
   manual-fallback-first if it gets too complex).
5. **Week 5:** Omnisearch API integration for RAG — the plugin becomes
   aware of the whole vault, not just the open file.
6. **Week 6:** Persistent memory (Phase 6) — cross-session recall of
   decisions and preferences, stored outside the vault's visible files.

---

## Development Environment

Development happens in Antigravity on a laptop, so a full Node.js/npm
build environment is already available — no cloud IDE workaround
needed. After each build (`npm run build`), the output files
(`main.js`, `manifest.json`, `styles.css`) get copied into
`.obsidian/plugins/vault-copilot/` inside the vault (which lives on
iPad/iPhone via iCloud) for testing.

---

## A Note of Honesty

This is a medium-to-large project even for an experienced developer
(not a beginner one) — it may take several real weeks of testing and
iteration even with AI writing most of the code. Start with Phase 1
(MVP) only, confirm it's stable, before adding the complexity of later
phases.
