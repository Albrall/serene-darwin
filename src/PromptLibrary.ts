import type { VaultIndex } from './VaultIndexer';
import type { LinkingResult } from './ConceptMatcher';

export interface ShortcutPrompt {
    id: string;
    label: string;
    prompt: string;
}

export class PromptLibrary {
    // ── User-facing shortcut prompts (Phase 1) ────────────────────────────────
    // For Phase 1, we hardcode some useful defaults.
    // Later phases could load this from settings or a specific vault note.
    static getPrompts(): ShortcutPrompt[] {
        return [
            {
                id: 'summarize',
                label: '/summarize',
                prompt: 'Summarize the provided content into key bullet points.',
            },
            {
                id: 'extract-concepts',
                label: '/extract-concepts',
                prompt: 'Extract the core medical/scientific concepts from this text.',
            },
            {
                id: 'explain',
                label: '/explain',
                prompt: 'Explain this concept simply as if to a medical student.',
            },
        ];
    }

    // ── Phase 2: System prompt for smart linking ──────────────────────────────

    /**
     * Builds the system prompt for the "Create Note from Lecture" linking pass.
     *
     * Research basis (Zettelkasten + Obsidian MOC best practices):
     * - Notes are named by their concept/claim, never by date or file type.
     *   The title IS the permanent address of the idea in the knowledge graph.
     * - Inline [[wikilinks]] should be DENSE — every term that has its own note
     *   must be linked at each meaningful occurrence in the body, because the
     *   hypertext density is what creates the navigable web of thought.
     * - An MOC is a topic map, not a timestamp list. It links to semantic titles
     *   so you can navigate the graph by concept, not by chronology.
     *
     * The vault index is injected so the LLM can match terms against existing
     * notes in a single pass. JSON output ensures reliable machine-parsing.
     *
     * IMPORTANT: Only inject the full index here — never in regular sidebar
     * chat (AGENTS.md rule 9).
     */
    static getSystemPrompt(_vaultIndex: VaultIndex, vaultIndexFormatted: string): string {
        return `You are an Obsidian Zettelkasten assistant helping organise a medical/academic vault.

## Existing notes in this vault

The following is the complete list of existing note titles and aliases:

${vaultIndexFormatted}

---

## Your task

You will be given the text of a lecture. Process it and return a **single JSON code block** (fenced with \`\`\`json) and nothing else outside it. The JSON must have exactly these six keys:

\`\`\`
{
  "title": "<string: a short, precise semantic title for this note — see rules below>",
  "summary": "<string: one or two sentences summarising the core topic of this note>",
  "linkedContent": "<string: the full lecture text with [[wikilinks]] applied — see rules below>",
  "newConceptSuggestions": ["<Term A>", "<Term B>"],
  "suggestedTags": ["#tag1", "#tag2"],
  "conflicts": [
    { "term": "<term>", "existingNote": "<note title>", "description": "<discrepancy>" }
  ]
}
\`\`\`

---

### Rules for title

The title is the **permanent semantic address** of this note in the knowledge graph. It must:
- Name the **central concept or topic** of this lecture (e.g. "Cohort Studies", "Selection Bias", "Randomised Controlled Trials").
- Be concise: 2–5 words, Title Case.
- Be specific enough that two different lectures would never share it.
- NOT include the word "Lecture", a date, a course name, or any metadata — just the concept.
- NOT be a question or a sentence — just a noun phrase.

Good examples: "Cohort Studies", "Confounding in Observational Research", "Intention to Treat Analysis"
Bad examples: "Lecture 3 Notes", "Epidemiology Overview", "Study Design"

---

### Rules for summary

- One or two sentences, in English only.
- Captures the central claim or purpose of this lecture — what a student should know after reading it.
- Do NOT include wikilinks in the summary.

---

### Rules for linkedContent

This is the MOST IMPORTANT field. The goal is a **dense Zettelkasten hypertext**: every term that matches an existing note must be wikilinked so the graph is maximally navigable.

**Linking rules — follow these strictly:**

1. **Identify ALL meaningful concepts** in the text — explicitly defined terms, bolded key terms, technical vocabulary, named study designs, statistical methods, and domain-specific concepts. Cast a wide net; in a medical/academic vault, most technical terms deserve a link.

2. **For every identified concept, check the vault note list above:**
   - **Match found** → wrap it in \`[[wikilinks]]\` EVERY TIME it appears in the text in a technical/scientific sense. Do NOT limit yourself to the first occurrence — if "selection bias" appears five times and five of those are technical uses, link all five. Dense linking is the goal.
   - **Alias match** → if the text uses an alias or variant of an existing note title, link it using the pipe syntax: \`[[Actual Note Title|term as written]]\`.
   - **No match** → do NOT insert a link; add to \`newConceptSuggestions\` if clearly important.

3. **Context check for every link**: only link where the term is used in its scientific/technical sense. "The study had a personal bias" → do NOT link. "Selection bias threatens external validity" → link both terms.

4. **Do NOT be conservative**. If a term clearly matches a note and is clearly used technically, LINK IT. The failure mode to avoid is under-linking — a note with zero wikilinks is useless in a Zettelkasten. If in genuine doubt about technical vs everyday use, skip it. But do not skip obvious technical matches.

5. **Preserve the full text exactly** — every heading, bullet point, numbered list, and paragraph break. Only ADD \`[[\`\`]]\` brackets; do not rephrase, reorder, summarise, or flatten bullet lists into prose. Each bullet must remain on its own line with its original \`-\` or \`*\` prefix.

6. **Placeholder markers** (e.g. \`<!-- [UNREADABLE SECTION] -->\`, \`📷 [MANUAL SCREENSHOT NEEDED: …]\`) must be passed through verbatim into linkedContent. Do NOT treat them as concepts, do NOT add them to newConceptSuggestions.

---

### Rules for newConceptSuggestions

- Terms that are clearly technically important AND have no matching note in the vault.
- Use canonical form (e.g. "Confounding Variable", not "confounders").
- Do not include terms you were uncertain about.
- **NEVER include**: placeholder strings like "Unreadable Section", "Lecture Material Needed", "Screenshot Needed", or any text that came from a \`[…]\` extraction marker. These are pipeline artefacts, not concepts.

### Rules for suggestedTags

- 3–8 relevant #tags based on the actual content of this specific lecture.
- Do NOT reuse a fixed list from a previous module.
- Format with a leading #, e.g. "#epidemiology".

### Rules for conflicts

- Only flag real, specific discrepancies between this lecture's content and what an existing note implies or states.
- If no conflicts, return an empty array.

---

Return ONLY the JSON block. No prose before or after it.`;
    }

    /**
     * The first-pass extraction prompt: asks the LLM to extract clean, plain
     * lecture text from a raw file (PDF or otherwise).
     *
     * This is kept separate from the linking prompt so the linking pass
     * receives clean text without model meta-commentary.
     *
     * Key rules enforced here:
     * - Bullet/paragraph structure must be preserved (one bullet per line).
     * - Output must be English-only; if a slide contains both Arabic and English,
     *   extract the English text only.
     * - Placeholder markers ([UNREADABLE SECTION], screenshot notices) are
     *   pipeline markers for the user — they are NOT concepts and must never
     *   be written as if they are headings or key terms.
     */
    static getExtractionPrompt(): string {
        return `You are a careful academic transcription assistant.

Extract the full text content from the provided lecture material.

Rules:
- **Preserve structure exactly**: output each bullet point on its own line with its original prefix (- or *). Output each numbered list item on its own line. Separate paragraphs with a blank line. Do NOT join bullets or list items into prose run-on sentences.
- Preserve all headings (output them as Markdown #, ##, ### headings matching their visual hierarchy).
- Preserve bolded or emphasised terms (use **bold** markdown).
- Do NOT summarise — output the complete text.
- Do NOT add any commentary, preamble, or closing remarks.
- **English only**: if a slide or section contains text in both Arabic and English (e.g. an Arabic definition alongside an English one), extract the English text only. Omit the Arabic entirely.
- **Unreadable content**: if you genuinely cannot read a section, output exactly the marker \`[UNREADABLE SECTION]\` on its own line. This is a pipeline marker for the user — do NOT treat it as a heading, concept, or key term, and do NOT add explanatory prose around it.
- **Images, diagrams, charts**: you MUST NOT silently skip them and MUST NOT invent a detailed analysis. Output exactly \`📷 [MANUAL SCREENSHOT NEEDED: brief description of what the image shows and its context]\` on its own line so the user knows where to manually paste it later. This is also a pipeline marker — not a concept.

Output only the extracted text.`;
    }

    /**
     * Builds the full structured Obsidian note from a LinkingResult.
     *
     * Generates:
     *  - YAML frontmatter (aliases, tags, source, created)
     *  - > [!abstract] overview callout using the LLM summary
     *  - Metadata table (Lecturer, Module, Source Deck, Tags)
     *  - > [!danger] callouts for each conflict (if any)
     *  - The linked body content
     *  - > [!tip] Key Takeaways scaffold
     *  - > [!warning] Points to Review scaffold
     *  - ## Cross-References section
     */
    static getNoteTemplate(result: LinkingResult, sourceFileName: string): string {
        const today = window.moment().format('YYYY-MM-DD');

        // ── Frontmatter ──────────────────────────────────────────────────────
        // Derive alias candidates from the title (bare title without special chars)
        const aliasLine = result.title ? `aliases:\n  - "${result.title}"` : 'aliases: []';

        // Convert suggestedTags from "#tag" format to bare "tag" for YAML list
        const yamlTags = result.suggestedTags
            .map(t => t.replace(/^#/, '').trim())
            .filter(t => t.length > 0);
        const tagsYaml = yamlTags.length > 0
            ? 'tags:\n' + yamlTags.map(t => `  - ${t}`).join('\n')
            : 'tags: []';

        const frontmatter = [
            '---',
            aliasLine,
            tagsYaml,
            `source: "${sourceFileName}"`,
            `created: ${today}`,
            '---',
        ].join('\n');

        // ── Abstract callout ─────────────────────────────────────────────────
        const summaryText = result.summary?.trim() || '*(no summary available)*';
        const abstractCallout = `> [!abstract] Overview\n> ${summaryText}`;

        // ── Metadata table ───────────────────────────────────────────────────
        const tagsDisplay = result.suggestedTags.join(' ') || '—';
        const metadataTable = [
            '## Metadata',
            '',
            '| Field | Value |',
            '|---|---|',
            '| Lecturer | — |',
            '| Module | — |',
            `| Source Deck | ${sourceFileName} |`,
            `| Tags | ${tagsDisplay} |`,
        ].join('\n');


        // ── Body content ─────────────────────────────────────────────────────
        const body = result.linkedContent.trim();

        // ── Scaffolding callouts ─────────────────────────────────────────────
        const tipCallout = `> [!tip] Key Takeaways\n> *(fill in after reviewing)*`;
        const warningCallout = `> [!warning] Points to Review\n> *(flag anything unclear here)*`;

        // ── Cross-references section ─────────────────────────────────────────
        const crossRefs = `## Cross-References\n\n*(links to related notes will appear here)*`;

        // ── Assemble ─────────────────────────────────────────────────────────
        const sections: string[] = [
            frontmatter,
            '',
            abstractCallout,
            '',
            `# ${result.title}`,
            '',
            metadataTable,
        ];

        if (result.conflicts.length > 0) {
            sections.push('');
            sections.push(...result.conflicts.map(c =>
                `> [!danger] Conflict: ${c.term}\n> **Existing note**: [[${c.existingNote}]]\n> ${c.description}`
            ));
        }

        sections.push(
            '',
            '---',
            '',
            body,
            '',
            '---',
            '',
            tipCallout,
            '',
            warningCallout,
            '',
            crossRefs,
        );

        return sections.join('\n');
    }

    /**
     * Builds the enriched concept stub template used by createConceptStub().
     * Uses callouts and frontmatter so stubs are immediately useful as
     * structured Zettelkasten nodes.
     */
    static getConceptStubTemplate(term: string): string {
        const today = window.moment().format('YYYY-MM-DD');
        return [
            '---',
            'aliases: []',
            'tags: []',
            `created: ${today}`,
            '---',
            '',
            `# ${term}`,
            '',
            '> [!abstract] Definition',
            '> *(stub — fill in the definition and key details)*',
            '',
            '## Key Properties',
            '',
            '## Related Concepts',
            '',
            '## Sources',
        ].join('\n');
    }

    /**
     * Phase 5: System prompt for Omnisearch RAG Context
     */
    static getVaultContextPrompt(contextString: string): string {
        return `Here is relevant context from the user's Obsidian vault to help answer their query:

${contextString}

When answering, prioritize this context and explicitly cite the source note titles (e.g. 'According to [[Note Title]]...').`;
    }

    /**
     * Phase 3: System prompt for interactive editing
     */
    static getInteractiveEditPrompt(filename: string, content: string): string {
        return `The user currently has the note '${filename}' open with the following content:

\`\`\`markdown
${content}
\`\`\`

If the user asks you to edit, rewrite, or add something, you MUST output the COMPLETE updated text inside a single \`\`\`markdown ... \`\`\` block so it can be directly applied as a full file replacement.`;
    }

    /**
     * Phase 6: System prompt for injecting persistent memory
     */
    static getMemoryInjectionPrompt(memory: string): string {
        return `Here are the user's persistent preferences and facts from previous conversations:\n\n${memory}\n\nPlease respect these preferences in all your responses.`;
    }

    /**
     * Phase 6: System prompt for extracting persistent memory
     */
    static getMemoryExtractionPrompt(): string {
        return `Analyze our conversation above. Extract ONLY durable facts, decisions, or user preferences that should be remembered for future sessions (e.g., formatting habits, study focus, preferred tone). Do NOT summarize the medical topic itself. Return them as a brief bulleted list. If there are no new persistent preferences worth remembering, output exactly: NO_NEW_MEMORY.`;
    }
}
