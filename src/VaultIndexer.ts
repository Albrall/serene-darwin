import { App, TFile } from 'obsidian';

/** A single note entry in the vault index. */
export interface NoteEntry {
    /** Note title (basename without extension). */
    title: string;
    /** Aliases from YAML frontmatter (`aliases` array or `alias` string). */
    aliases: string[];
    /** Vault-relative path, e.g. "Lectures/Bias.md". */
    path: string;
}

/** The full vault index: an array of note entries. */
export type VaultIndex = NoteEntry[];

export class VaultIndexer {
    private app: App;
    /**
     * Optional folder path to scope indexing.
     * If empty, the entire vault is indexed.
     */
    private folderScope: string;

    constructor(app: App, folderScope = '') {
        this.app = app;
        this.folderScope = folderScope.trim();
    }

    /**
     * Builds the vault index synchronously using Obsidian's already-parsed
     * metadataCache — no file reads, instant even on large vaults, mobile-safe.
     */
    buildIndex(): VaultIndex {
        const allFiles = this.app.vault.getMarkdownFiles();

        const scopedFiles = this.folderScope
            ? allFiles.filter(f => f.path.startsWith(this.folderScope))
            : allFiles;

        const index: VaultIndex = scopedFiles.map(file => ({
            title: file.basename,
            aliases: this.getAliases(file),
            path: file.path,
        }));

        return index;
    }

    /**
     * Reads a note's body text via Obsidian's vault API.
     * Used in "deep" conflict detection mode to inject snippets.
     * Returns the first `maxChars` characters of the note body (after frontmatter).
     */
    async readNoteSnippet(path: string, maxChars = 600): Promise<string> {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return '';

        try {
            const content = await this.app.vault.cachedRead(file);
            // Strip YAML frontmatter block if present
            const withoutFrontmatter = content.replace(/^---[\s\S]*?---\n?/, '');
            return withoutFrontmatter.slice(0, maxChars);
        } catch (e) {
            console.error(`VaultIndexer: could not read note at ${path}`, e);
            return '';
        }
    }

    /**
     * Serialises a VaultIndex into a compact plain-text block for injection
     * into a system prompt. Format:
     *   - Note Title (aliases: Alias 1, Alias 2)
     */
    static formatForPrompt(index: VaultIndex): string {
        if (index.length === 0) {
            return '(No existing notes found in the vault index.)';
        }

        return index
            .map(entry => {
                const aliasPart = entry.aliases.length > 0
                    ? ` (aliases: ${entry.aliases.join(', ')})`
                    : '';
                return `- ${entry.title}${aliasPart}`;
            })
            .join('\n');
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Extracts aliases from a note's cached frontmatter.
     * Handles both `aliases: [...]` (array) and `alias: "..."` (string),
     * and normalises single-alias string notation.
     */
    private getAliases(file: TFile): string[] {
        const metadata = this.app.metadataCache.getFileCache(file);
        if (!metadata?.frontmatter) return [];

        const fm = metadata.frontmatter;

        // `aliases` key (preferred Obsidian standard)
        if (fm['aliases']) {
            const raw = fm['aliases'];
            if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
            if (typeof raw === 'string') return [raw].filter(Boolean);
        }

        // `alias` key (singular variant some users prefer)
        if (fm['alias']) {
            const raw = fm['alias'];
            if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
            if (typeof raw === 'string') return [raw].filter(Boolean);
        }

        return [];
    }
}
