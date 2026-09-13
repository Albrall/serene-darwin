import { App, Modal, Setting, Notice } from 'obsidian';
import type { LinkingResult } from './ConceptMatcher';

/**
 * DiffPreview — shows a preview of content before it is committed to the vault.
 *
 * Phase 1: shows a plain editable textarea + Cancel / Approve & Save buttons.
 * Phase 2: optionally shows a summary panel (links added, new concepts,
 *           suggested tags, conflicts) above the textarea when `metadata` is
 *           provided. New-concept stubs and tag inclusion are user-selectable
 *           via checkboxes; none are applied without explicit approval.
 *
 * The constructor signature is backwards-compatible — `metadata` is optional.
 */
export class DiffPreview extends Modal {
    private contentToSave: string;
    private onApprove: (content: string, approvedNewConcepts: string[], approvedTags: string[]) => Promise<void>;
    private metadata?: LinkingResult;

    /**
     * Resolves when the modal is closed — whether the user approved or cancelled.
     * Await this after calling open() to ensure sequential modal presentation.
     *
     * Example:
     *   const preview = new DiffPreview(...);
     *   preview.open();
     *   await preview.closed; // waits here until user dismisses the modal
     */
    readonly closed: Promise<void>;
    private resolveClose!: () => void;

    constructor(
        app: App,
        contentToSave: string,
        onApprove: (content: string, approvedNewConcepts: string[], approvedTags: string[]) => Promise<void>,
        metadata?: LinkingResult
    ) {
        super(app);
        this.contentToSave = contentToSave;
        this.onApprove = onApprove;
        this.metadata = metadata;
        // Initialise the closed promise. resolveClose is called in onClose()
        // regardless of whether the user approved or cancelled.
        this.closed = new Promise(resolve => { this.resolveClose = resolve; });
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText('Preview Changes');

        // ── Phase 2 summary panel ─────────────────────────────────────────────
        const approvedNewConcepts: Set<string> = new Set();
        const approvedTags: Set<string> = new Set();

        if (this.metadata) {
            const meta = this.metadata;

            // Count how many wikilinks were added to the content
            const linkMatches = (meta.linkedContent.match(/\[\[.+?\]\]/g) ?? []);
            const linkCount = linkMatches.length;

            const summaryEl = contentEl.createDiv({ cls: 'vault-copilot-diff-summary' });

            // Wikilinks count
            summaryEl.createEl('p', {
                text: `🔗 ${linkCount} wikilink${linkCount !== 1 ? 's' : ''} added by smart linking.`,
            });

            // Suggested tags with checkboxes
            if (meta.suggestedTags.length > 0) {
                summaryEl.createEl('p', { text: '🏷️ Suggested tags (select to include in note):' });
                const tagsDiv = summaryEl.createDiv({ cls: 'vault-copilot-tags-list' });
                for (const tag of meta.suggestedTags) {
                    const label = tagsDiv.createEl('label', { cls: 'vault-copilot-tag-label' });
                    const checkbox = label.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
                    checkbox.checked = true; // opt-in by default
                    approvedTags.add(tag);
                    label.createSpan({ text: ` ${tag}` });
                    checkbox.addEventListener('change', () => {
                        if (checkbox.checked) {
                            approvedTags.add(tag);
                        } else {
                            approvedTags.delete(tag);
                        }
                    });
                }
            }

            // New concept suggestions with checkboxes
            if (meta.newConceptSuggestions.length > 0) {
                summaryEl.createEl('p', {
                    text: '🆕 New concepts detected (check to create a stub note for each):',
                });
                const conceptsDiv = summaryEl.createDiv({ cls: 'vault-copilot-concepts-list' });
                for (const term of meta.newConceptSuggestions) {
                    const label = conceptsDiv.createEl('label', { cls: 'vault-copilot-concept-label' });
                    const checkbox = label.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
                    checkbox.checked = false; // opt-in only — never auto-create
                    label.createSpan({ text: ` ${term}` });
                    checkbox.addEventListener('change', () => {
                        if (checkbox.checked) {
                            approvedNewConcepts.add(term);
                        } else {
                            approvedNewConcepts.delete(term);
                        }
                    });
                }
            }

            // Conflict warnings
            if (meta.conflicts.length > 0) {
                const conflictsDiv = summaryEl.createDiv({ cls: 'vault-copilot-conflicts' });
                conflictsDiv.createEl('p', {
                    text: `⚠️ ${meta.conflicts.length} possible conflict${meta.conflicts.length !== 1 ? 's' : ''} detected:`,
                });
                for (const conflict of meta.conflicts) {
                    const entry = conflictsDiv.createDiv({ cls: 'vault-copilot-conflict-entry' });
                    entry.createEl('strong', { text: `${conflict.term} ↔ [[${conflict.existingNote}]]` });
                    entry.createEl('p', { text: conflict.description });
                }
            }

            summaryEl.createEl('hr');
        }

        // ── Content textarea ──────────────────────────────────────────────────
        contentEl.createEl('p', {
            text: 'Review and optionally edit the content below before saving to your vault.',
        });

        const textArea = contentEl.createEl('textarea', {
            text: this.contentToSave,
            attr: {
                style: 'width: 100%; height: 300px; resize: vertical; margin-bottom: 15px; font-family: monospace;',
            },
        });

        // ── Action buttons ────────────────────────────────────────────────────
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => {
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText('Approve & Save')
                .setCta()
                .onClick(async () => {
                    const finalContent = textArea.value;
                    this.close();
                    try {
                        await this.onApprove(
                            finalContent,
                            Array.from(approvedNewConcepts),
                            Array.from(approvedTags)
                        );
                    } catch (e) {
                        new Notice(`Failed to save: ${(e as Error).message}`);
                    }
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        // Settle the closed promise so any awaiting caller can proceed.
        this.resolveClose();
    }
}
