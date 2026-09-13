import { App, Notice } from 'obsidian';
import { LLMProvider, ChatMessage } from './LLMProvider';
import { VaultIndexer, VaultIndex } from './VaultIndexer';
import { PromptLibrary } from './PromptLibrary';
import type { VaultCopilotSettings } from './settings';

// ── Public result types ───────────────────────────────────────────────────────

export interface ConflictEntry {
    term: string;
    existingNote: string;
    description: string;
}

/**
 * The structured result returned by runLinkingPipeline().
 * All fields will be populated even if empty (never undefined).
 */
export interface LinkingResult {
    /** Semantic concept title for the note, e.g. "Cohort Studies". Used as the filename. */
    title: string;
    /** One-to-two sentence summary of the note's core topic. Used in the > [!abstract] callout. */
    summary: string;
    /** Lecture text with [[wikilinks]] and #tags inserted. */
    linkedContent: string;
    /** Terms the LLM flagged as important but without an existing note. */
    newConceptSuggestions: string[];
    /** Suggested #tags for the new note (3–8). */
    suggestedTags: string[];
    /** Any definition conflicts between the lecture and existing notes. */
    conflicts: ConflictEntry[];
}

// ── Placeholder filtering ─────────────────────────────────────────────────────

/**
 * Regex patterns that match pipeline placeholder markers inserted by the
 * extraction LLM (see PromptLibrary.getExtractionPrompt()).
 *
 * These strings must NEVER be treated as linkable concepts or stub candidates.
 * We replace them with HTML comments in the text so they survive visibly in
 * the note for the user to address, but are invisible to the linking LLM.
 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
    /\[UNREADABLE SECTION\]/gi,
    /\[LECTURE MATERIAL NEEDED[^\]]*\]/gi,   // handle common LLM variant
    /\[CONTENT UNAVAILABLE[^\]]*\]/gi,        // handle another common variant
];

/**
 * Screenshot markers are kept verbatim (the user needs the description),
 * but wrapped in an HTML comment so the linking LLM ignores them as concepts.
 */
const SCREENSHOT_PATTERN = /📷 \[MANUAL SCREENSHOT NEEDED:[^\]]*\]/gi;

/**
 * Denylist applied to newConceptSuggestions after LLM parsing.
 * Any suggestion matching one of these patterns is dropped and logged.
 */
const CONCEPT_DENYLIST: RegExp[] = [
    /unreadable section/i,
    /lecture material needed/i,
    /content unavailable/i,
    /manual screenshot needed/i,
    /screenshot needed/i,
    /^\s*\[.*\]\s*$/,   // any bare bracket-enclosed string, e.g. "[Some Marker]"
];

// ── ConceptMatcher ────────────────────────────────────────────────────────────

export class ConceptMatcher {
    private app: App;
    private llm: LLMProvider;
    private settings: VaultCopilotSettings;
    private indexer: VaultIndexer;

    constructor(app: App, settings: VaultCopilotSettings) {
        this.app = app;
        this.settings = settings;
        this.llm = new LLMProvider(settings);
        this.indexer = new VaultIndexer(app, settings.vaultIndexFolder);
    }

    /**
     * Runs the full Phase 2 linking pipeline on the extracted lecture text.
     *
     * Steps:
     *   1. Sanitise the extracted text — replace placeholder markers with
     *      HTML comments so the linking LLM never sees them as concepts.
     *   2. Build the vault index (synchronous, uses metadataCache).
     *   3. (Deep mode) Read snippets for matched notes to inject context.
     *   4. Build the system prompt with the vault index.
     *   5. Call the LLM with the system prompt + sanitised lecture text.
     *   6. Parse the structured JSON response, filtering the concept denylist.
     *
     * Returns a LinkingResult. Throws on unrecoverable errors.
     */
    async runLinkingPipeline(lectureText: string): Promise<LinkingResult> {
        // 1. Sanitise: replace placeholders before sending to the linking LLM
        const sanitisedText = this.sanitisePlaceholders(lectureText);

        // 2. Build vault index
        const vaultIndex: VaultIndex = this.indexer.buildIndex();
        let formattedIndex = VaultIndexer.formatForPrompt(vaultIndex);

        // 3. Deep conflict mode: append note snippets for all indexed notes
        //    so the LLM can compare definitions directly.
        if (this.settings.conflictDetectionMode === 'deep') {
            formattedIndex = await this.enrichIndexWithSnippets(vaultIndex, formattedIndex);
        }

        // 4. Build system prompt
        const systemPrompt = PromptLibrary.getSystemPrompt(vaultIndex, formattedIndex);

        // 5. Call LLM
        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: sanitisedText },
        ];

        let rawResponse: string;
        try {
            rawResponse = await this.llm.generateResponse(messages);
        } catch (error) {
            throw new Error(`Linking LLM call failed: ${(error as Error).message}`);
        }

        // 6. Parse structured JSON response
        return this.parseLinkerResponse(rawResponse, sanitisedText);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Replaces pipeline placeholder markers with HTML comments so they:
     * - remain visible to the user in the final note (HTML comments render
     *   as invisible but are readable in source mode)
     * - are invisible to the linking LLM as potential concept targets
     *
     * Also logs each placeholder found with its surrounding context so the
     * user can identify which slide caused the extraction failure.
     */
    private sanitisePlaceholders(text: string): string {
        let sanitised = text;

        for (const pattern of PLACEHOLDER_PATTERNS) {
            sanitised = sanitised.replace(pattern, (match, offset) => {
                // Log the match with ~100 chars of surrounding context for debugging
                const start = Math.max(0, offset - 80);
                const end = Math.min(text.length, offset + match.length + 80);
                const context = text.slice(start, end).replace(/\n/g, ' ');
                console.warn(
                    `[VaultCopilot] Extraction placeholder found — this slide likely failed:\n` +
                    `  Marker: "${match}"\n` +
                    `  Context: "…${context}…"`
                );
                return `<!-- ${match} -->`;
            });
        }

        // Screenshot markers: keep the description verbatim (useful for the user)
        // but wrap in an HTML comment so the linking LLM ignores the bracket text.
        sanitised = sanitised.replace(SCREENSHOT_PATTERN, (match) => {
            return `<!-- ${match} -->`;
        });

        return sanitised;
    }

    /**
     * For deep conflict detection: reads a snippet of each note and appends it
     * to the formatted index string so the LLM can compare definitions.
     * Limits to 600 chars per note to stay within reasonable token budgets.
     */
    private async enrichIndexWithSnippets(
        index: VaultIndex,
        formattedIndex: string
    ): Promise<string> {
        const lines: string[] = [formattedIndex, '', '## Note Snippets (for conflict detection)'];

        for (const entry of index) {
            const snippet = await this.indexer.readNoteSnippet(entry.path, 600);
            if (snippet) {
                lines.push(`\n### ${entry.title}\n${snippet.trim()}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Extracts the JSON block from the LLM's response and parses it.
     * Falls back to a safe result (original text, no links) if parsing fails,
     * so the pipeline never crashes silently — it shows a Notice instead.
     *
     * After parsing, filters newConceptSuggestions through CONCEPT_DENYLIST
     * to remove any placeholder strings the LLM may have included anyway.
     */
    private parseLinkerResponse(rawResponse: string, originalText: string): LinkingResult {
        // Find the ```json ... ``` block
        const jsonMatch = rawResponse.match(/```json\s*([\s\S]*?)```/i);

        if (!jsonMatch || !jsonMatch[1]) {
            // Model did not return JSON — show a visible warning and pass through original text
            new Notice(
                '⚠️ Vault Copilot: The linking model did not return structured JSON. ' +
                'The note was saved without smart links. Check console for the raw response.'
            );
            console.warn('ConceptMatcher: raw LLM response without JSON block:', rawResponse);
            return this.fallbackResult(originalText);
        }

        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(jsonMatch[1]);
        } catch (e) {
            new Notice(
                '⚠️ Vault Copilot: Failed to parse the linking model\'s JSON response. ' +
                'The note was saved without smart links.'
            );
            console.error('ConceptMatcher: JSON parse error:', e, '\nRaw JSON:', jsonMatch[1]);
            return this.fallbackResult(originalText);
        }

        // Filter concept suggestions through the denylist
        const rawSuggestions = this.expectStringArray(parsed['newConceptSuggestions']);
        const filteredSuggestions = this.filterConceptDenylist(rawSuggestions);

        return {
            title: this.expectString(parsed['title'], ''),
            summary: this.expectString(parsed['summary'], ''),
            linkedContent: this.expectString(parsed['linkedContent'], originalText),
            newConceptSuggestions: filteredSuggestions,
            suggestedTags: this.expectStringArray(parsed['suggestedTags']),
            conflicts: this.expectConflicts(parsed['conflicts']),
        };
    }

    /**
     * Filters out any concept suggestion that matches the CONCEPT_DENYLIST.
     * Logs a warning for each dropped suggestion so it's traceable.
     */
    private filterConceptDenylist(suggestions: string[]): string[] {
        return suggestions.filter(term => {
            const blocked = CONCEPT_DENYLIST.some(pattern => pattern.test(term));
            if (blocked) {
                console.warn(
                    `[VaultCopilot] Blocked placeholder from concept suggestions: "${term}"`
                );
            }
            return !blocked;
        });
    }

    /** Returns a safe no-op result using the original lecture text. */
    private fallbackResult(originalText: string): LinkingResult {
        return {
            title: '',   // empty → main.ts will fall back to timestamp filename
            summary: '',
            linkedContent: originalText,
            newConceptSuggestions: [],
            suggestedTags: [],
            conflicts: [],
        };
    }

    // ── Type-safe JSON field accessors ────────────────────────────────────────

    private expectString(value: unknown, fallback: string): string {
        return typeof value === 'string' && value.trim() ? value : fallback;
    }

    private expectStringArray(value: unknown): string[] {
        if (!Array.isArray(value)) return [];
        return value.filter((v): v is string => typeof v === 'string');
    }

    private expectConflicts(value: unknown): ConflictEntry[] {
        if (!Array.isArray(value)) return [];
        return value.filter((v): v is ConflictEntry =>
            v !== null &&
            typeof v === 'object' &&
            typeof (v as Record<string, unknown>)['term'] === 'string' &&
            typeof (v as Record<string, unknown>)['existingNote'] === 'string' &&
            typeof (v as Record<string, unknown>)['description'] === 'string'
        );
    }
}
