import { Plugin, WorkspaceLeaf, Notice, TFile } from 'obsidian';
import { VaultCopilotSettings, DEFAULT_SETTINGS, VaultCopilotSettingTab } from './src/settings';
import { ChatPanel, CHAT_VIEW_TYPE } from './src/ChatPanel';
import { PDFHandler } from './src/PDFHandler';
import { LLMProvider, ChatMessage } from './src/LLMProvider';
import { DiffPreview } from './src/DiffPreview';
import { ConceptMatcher, LinkingResult } from './src/ConceptMatcher';
import { PromptLibrary } from './src/PromptLibrary';

export default class VaultCopilot extends Plugin {
    settings: VaultCopilotSettings;

    async onload() {
        await this.loadSettings();

        // Add settings tab
        this.addSettingTab(new VaultCopilotSettingTab(this.app, this));

        // Register the chat view
        this.registerView(
            CHAT_VIEW_TYPE,
            (leaf) => new ChatPanel(leaf, this)
        );

        // Add ribbon icon to open the chat panel
        this.addRibbonIcon('message-circle', 'Open Vault Copilot', () => {
            this.activateChatView();
        });

        // Add "Create Note from Lecture" command
        this.addCommand({
            id: 'create-note-from-lecture',
            name: 'Create Note from Lecture',
            callback: () => {
                this.createNoteFromLecture();
            }
        });
    }

    async activateChatView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(CHAT_VIEW_TYPE);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                leaf = rightLeaf;
                await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
            }
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }

    // ── Create Note from Lecture — full Phase 2 pipeline ─────────────────────

    async createNoteFromLecture() {
        // ── Step 1: File selection ────────────────────────────────────────────
        const file = await PDFHandler.selectAndReadFile();
        if (!file) {
            new Notice('No file selected.');
            return;
        }

        // ── Step A: Extract lecture text ──────────────────────────────────────
        new Notice(`📖 Step 1/2 — Extracting text from ${file.name}…`);

        let lectureText: string;
        try {
            const llm = new LLMProvider(this.settings);
            const extractionMsg: ChatMessage = {
                role: 'user',
                content: PromptLibrary.getExtractionPrompt(),
                attachments: [file],
            };
            lectureText = await llm.generateResponse([extractionMsg]);
        } catch (error) {
            console.error('Create Note from Lecture — extraction failed', error);
            new Notice(`❌ Text extraction failed: ${(error as Error).message}`);
            return;
        }

        // ── Step B: Smart linking pipeline ────────────────────────────────────
        new Notice('🔗 Step 2/2 — Running smart linking and concept discovery…');

        let linkingResult: LinkingResult;
        try {
            const matcher = new ConceptMatcher(this.app, this.settings);
            linkingResult = await matcher.runLinkingPipeline(lectureText);
        } catch (error) {
            console.error('Create Note from Lecture — linking failed', error);
            new Notice(`❌ Smart linking failed: ${(error as Error).message}`);
            return;
        }

        // ── Step C: Assemble note content ─────────────────────────────────────
        // Derive the semantic filename from the LLM-extracted title.
        // Fall back to a timestamp only if the title came back empty.
        const semanticTitle = this.sanitiseTitle(linkingResult.title)
            || `Lecture Note ${window.moment().format('YYYY-MM-DD HH-mm-ss')}`;

        // Build the fully structured note (frontmatter, callouts, metadata table,
        // cross-reference section) via the template helper.
        const assembledContent = PromptLibrary.getNoteTemplate(linkingResult, file.name);

        // ── Step D: DiffPreview ───────────────────────────────────────────────
        new DiffPreview(
            this.app,
            assembledContent,
            async (finalContent, approvedNewConcepts, _approvedTags) => {
                // ── Step E: Save the lecture note ─────────────────────────────
                // Tags are embedded in YAML frontmatter by getNoteTemplate() —
                // no inline tag appending needed here. The user can edit the
                // frontmatter directly after saving if they want to adjust tags.

                let newFile: TFile;
                try {
                    newFile = await this.app.vault.create(`${semanticTitle}.md`, finalContent);
                } catch (error) {
                    new Notice(`❌ Failed to create note: ${(error as Error).message}`);
                    return;
                }

                // Open the new note
                const leaf = this.app.workspace.getLeaf(true);
                await leaf.openFile(newFile);
                new Notice(`✅ Created note: ${semanticTitle}`);

                // ── MOC update ────────────────────────────────────────────────
                // Pass the semantic title so the MOC links by concept, not timestamp.
                await this.updateMOC(semanticTitle);

                // ── New concept stub notes ────────────────────────────────────
                for (const term of approvedNewConcepts) {
                    await this.createConceptStub(term);
                }
            },
            linkingResult // pass metadata for the summary panel
        ).open();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Sanitises an LLM-generated title for use as an Obsidian filename.
     * Removes characters that are illegal on Windows (\/:*?"<>|) and iOS,
     * collapses whitespace, and trims to 100 chars.
     * Returns an empty string if the result is blank (caller should fall back).
     */
    private sanitiseTitle(raw: string): string {
        return raw
            .replace(/[\\/:*?"<>|#^[\]]/g, '')  // illegal filename chars
            .replace(/\s+/g, ' ')                 // collapse whitespace
            .trim()
            .slice(0, 100)                        // max length
            .trim();
    }

    // ── MOC update ────────────────────────────────────────────────────────────

    /**
     * Shows a DiffPreview of the MOC note after adding a link to the new
     * lecture note. The user must approve before anything is written.
     * Satisfies Hard Constraint #4: no note edit without a preview.
     *
     * Handles two cases:
     *   - MOC already exists: shows the full updated content for approval.
     *   - MOC does not exist yet: shows the initial content for approval,
     *     and creates the file only on approval.
     */
    private async updateMOC(newNoteTitle: string) {
        const mocName = (this.settings.mocNoteName || 'MOC').trim();
        const mocPath = mocName.endsWith('.md') ? mocName : `${mocName}.md`;

        try {
            const existingMOC = this.app.vault.getAbstractFileByPath(mocPath);
            let proposedContent: string;
            let isNewFile: boolean;

            if (existingMOC instanceof TFile) {
                const currentContent = await this.app.vault.read(existingMOC);
                const newLink = `- [[${newNoteTitle}]]`;

                // If the link is already there (e.g. from a previous run), skip silently.
                if (currentContent.includes(newLink)) return;

                proposedContent = `${currentContent}\n${newLink}`;
                isNewFile = false;
            } else {
                // MOC doesn't exist yet — propose creating it.
                proposedContent = `# ${mocName}\n\n- [[${newNoteTitle}]]`;
                isNewFile = true;
            }

            const mocPreview = new DiffPreview(
                this.app,
                proposedContent,
                async (finalContent) => {
                    try {
                        if (isNewFile) {
                            await this.app.vault.create(mocPath, finalContent);
                            new Notice(`📚 Created MOC note: ${mocName}`);
                        } else {
                            const file = this.app.vault.getAbstractFileByPath(mocPath);
                            if (file instanceof TFile) {
                                await this.app.vault.modify(file, finalContent);
                            }
                        }
                    } catch (error) {
                        new Notice(`⚠️ Could not save MOC note: ${(error as Error).message}`);
                    }
                }
            );
            mocPreview.open();
            await mocPreview.closed; // wait for user to approve or cancel before returning

        } catch (error) {
            console.error('VaultCopilot: MOC update preview failed', error);
            new Notice(`⚠️ Could not prepare MOC update: ${(error as Error).message}`);
        }
    }

    // ── New concept stub creation ─────────────────────────────────────────────

    /**
     * Proposes a stub note for a newly discovered concept via DiffPreview.
     * The stub is pre-filled with a minimal template; the user can edit it
     * before approving. Never creates anything silently.
     */
    private async createConceptStub(term: string) {
        const stubContent = PromptLibrary.getConceptStubTemplate(term);


        const stubPreview = new DiffPreview(
            this.app,
            stubContent,
            async (finalContent) => {
                const folder = this.settings.newConceptFolder.trim();
                const path = folder ? `${folder}/${term}.md` : `${term}.md`;

                // Ensure the target folder exists
                if (folder) {
                    try {
                        const folderExists = this.app.vault.getAbstractFileByPath(folder);
                        if (!folderExists) {
                            await this.app.vault.createFolder(folder);
                        }
                    } catch {
                        // Folder may already exist — ignore
                    }
                }

                try {
                    const stubFile = await this.app.vault.create(path, finalContent);
                    const leaf = this.app.workspace.getLeaf(true);
                    await leaf.openFile(stubFile);
                    new Notice(`✅ Created concept stub: ${term}`);
                } catch (error) {
                    new Notice(`❌ Failed to create stub for "${term}": ${(error as Error).message}`);
                }
            }
            // No metadata panel needed for stub previews
        );
        stubPreview.open();
        await stubPreview.closed; // wait for user to dismiss before opening the next stub
    }

    // ── Plugin data ───────────────────────────────────────────────────────────

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}
