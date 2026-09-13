import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, setIcon, TFile, SuggestModal, App } from 'obsidian';
import type VaultCopilot from '../main';
import { LLMProvider, ChatMessage } from './LLMProvider';
import { PDFHandler, AttachmentData } from './PDFHandler';
import { PromptLibrary } from './PromptLibrary';
import { DiffPreview } from './DiffPreview';
import { MODEL_OPTIONS } from './settings';

export const CHAT_VIEW_TYPE = "vault-copilot-chat-view";

// ── Note picker modal ─────────────────────────────────────────────────────────
// Lets the user choose any note from the vault as the chat context.

class NoteSuggestModal extends SuggestModal<TFile> {
    private onChoose: (file: TFile | null) => void;

    constructor(app: App, onChoose: (file: TFile | null) => void) {
        super(app);
        this.onChoose = onChoose;
        this.setPlaceholder('Choose a note to use as context…');
    }

    getSuggestions(query: string): TFile[] {
        const lower = query.toLowerCase();
        return this.app.vault.getMarkdownFiles().filter(f =>
            f.path.toLowerCase().includes(lower)
        );
    }

    renderSuggestion(file: TFile, el: HTMLElement) {
        el.createEl('div', { text: file.basename });
        el.createEl('small', { text: file.path, cls: 'vc-suggest-path' });
    }

    onChooseSuggestion(file: TFile) {
        this.onChoose(file);
    }
}

// ── ChatPanel ─────────────────────────────────────────────────────────────────

export class ChatPanel extends ItemView {
    plugin: VaultCopilot;
    messages: ChatMessage[] = [];
    attachments: AttachmentData[] = [];

    /** The model currently in use for this session. Starts from settings default. */
    private activeModel: string;
    /**
     * The note currently pinned as context.
     * null  = no context pinned (use active note automatically).
     * TFile = user has pinned a specific note.
     */
    private pinnedContextFile: TFile | null = null;

    private llmProvider: LLMProvider;

    // DOM refs
    private messagesDiv: HTMLElement;
    private filesDiv: HTMLElement;
    private textArea: HTMLTextAreaElement;
    private contextChipLabel: HTMLElement;
    private modelBtnLabel: HTMLElement;

    constructor(leaf: WorkspaceLeaf, plugin: VaultCopilot) {
        super(leaf);
        this.plugin = plugin;
        this.activeModel = plugin.settings.defaultModel;
        this.llmProvider = new LLMProvider(plugin.settings);
    }

    getViewType() { return CHAT_VIEW_TYPE; }
    getDisplayText() { return 'Vault Copilot'; }
    getIcon() { return 'message-circle'; }

    async onOpen() { this.renderUI(); }
    async onClose() { /* nothing */ }

    renderUI() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('vc-root');

        // ── Header ────────────────────────────────────────────────────────────
        const header = container.createDiv({ cls: 'vc-header' });

        const headerLeft = header.createDiv({ cls: 'vc-header-left' });
        const iconEl = headerLeft.createSpan({ cls: 'vc-header-icon' });
        setIcon(iconEl, 'message-circle');
        headerLeft.createSpan({ cls: 'vc-header-title', text: 'Vault Copilot' });

        const headerRight = header.createDiv({ cls: 'vc-header-right' });

        const newChatBtn = headerRight.createEl('button', { cls: 'vc-icon-btn' });
        newChatBtn.title = 'New chat';
        setIcon(newChatBtn, 'square-pen');
        newChatBtn.addEventListener('click', () => this.startNewChat());

        const settingsBtn = headerRight.createEl('button', { cls: 'vc-icon-btn' });
        settingsBtn.title = 'Settings';
        setIcon(settingsBtn, 'settings');
        settingsBtn.addEventListener('click', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.plugin.app as any).setting?.open();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.plugin.app as any).setting?.openTabById('vault-copilot');
        });

        // ── Messages area ─────────────────────────────────────────────────────
        this.messagesDiv = container.createDiv({ cls: 'vc-messages' });
        this.renderMessages();

        // ── Bottom chrome ─────────────────────────────────────────────────────
        const bottom = container.createDiv({ cls: 'vc-bottom' });

        // ── Toolbar row ───────────────────────────────────────────────────────
        const toolbar = bottom.createDiv({ cls: 'vc-toolbar' });

        // Context chip — shows pinned note or active note; click to pick
        const contextChip = toolbar.createEl('button', { cls: 'vc-context-chip' });
        const contextIcon = contextChip.createSpan({ cls: 'vc-chip-icon' });
        setIcon(contextIcon, 'file-text');
        this.contextChipLabel = contextChip.createSpan({ cls: 'vc-chip-label' });
        this.updateContextChipLabel();
        const contextChevron = contextChip.createSpan({ cls: 'vc-chip-chevron' });
        setIcon(contextChevron, 'chevron-down');

        contextChip.addEventListener('click', () => this.openContextPicker());

        // Update chip when active note changes (only when nothing is pinned)
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                if (!this.pinnedContextFile) this.updateContextChipLabel();
            })
        );

        // Toolbar right
        const toolbarRight = toolbar.createDiv({ cls: 'vc-toolbar-right' });

        // Model dropdown button
        const modelBtn = toolbarRight.createEl('button', { cls: 'vc-model-btn' });
        this.modelBtnLabel = modelBtn.createSpan({ cls: 'vc-model-label' });
        this.modelBtnLabel.textContent = this.getModelLabel(this.activeModel);
        const modelChevron = modelBtn.createSpan({ cls: 'vc-chip-chevron' });
        setIcon(modelChevron, 'chevron-down');
        modelBtn.title = 'Switch model';
        modelBtn.addEventListener('click', (e) => this.openModelDropdown(modelBtn, e));

        const attachToolBtn = toolbarRight.createEl('button', { cls: 'vc-icon-btn' });
        attachToolBtn.title = 'Attach file';
        setIcon(attachToolBtn, 'paperclip');
        attachToolBtn.addEventListener('click', async () => {
            const file = await PDFHandler.selectAndReadFile();
            if (file) {
                this.attachments.push(file);
                this.renderAttachments();
            }
        });

        const historyBtn = toolbarRight.createEl('button', { cls: 'vc-icon-btn' });
        historyBtn.title = 'History';
        setIcon(historyBtn, 'history');
        historyBtn.addEventListener('click', () => {
            new Notice('Chat history coming in a future update.');
        });

        // ── Attachment pills ───────────────────────────────────────────────────
        this.filesDiv = bottom.createDiv({ cls: 'vc-attachments' });

        // ── Input wrapper ──────────────────────────────────────────────────────
        const inputWrapper = bottom.createDiv({ cls: 'vc-input-wrapper' });

        this.textArea = inputWrapper.createEl('textarea', { cls: 'vc-textarea' });
        this.textArea.placeholder = 'Ask anything…  / for prompts';
        this.textArea.rows = 1;

        this.textArea.addEventListener('input', () => this.autoGrow());
        this.textArea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        const sendBtn = inputWrapper.createEl('button', { cls: 'vc-send-btn' });
        const sendIcon = sendBtn.createSpan();
        setIcon(sendIcon, 'arrow-up');
        sendBtn.addEventListener('click', () => this.sendMessage());
    }

    // ── Context picker ────────────────────────────────────────────────────────

    private openContextPicker() {
        // Show a small menu: active note / pick note / no context
        const menu = document.createElement('div');
        menu.className = 'vc-context-menu';

        const activeFile = this.app.workspace.getActiveFile();

        const addItem = (label: string, icon: string, onClick: () => void) => {
            const item = menu.createDiv({ cls: 'vc-context-menu-item' });
            const ic = item.createSpan();
            setIcon(ic, icon);
            item.createSpan({ text: label });
            item.addEventListener('click', () => {
                menu.remove();
                onClick();
            });
        };

        if (activeFile) {
            addItem(`Use active note: ${activeFile.basename}`, 'file-text', () => {
                this.pinnedContextFile = null; // auto = active note
                this.updateContextChipLabel();
            });
        }

        addItem('Pick any note…', 'search', () => {
            new NoteSuggestModal(this.app, (file) => {
                if (file) {
                    this.pinnedContextFile = file;
                    this.updateContextChipLabel();
                }
            }).open();
        });

        addItem('No context', 'x-circle', () => {
            this.pinnedContextFile = null;
            // Override to show explicitly "No context" even if active note exists
            this.contextChipLabel.textContent = 'No context';
        });

        // Position below the chip — use visualViewport on iOS for accurate coords
        document.body.appendChild(menu);
        const chipRect = (this.containerEl.querySelector('.vc-context-chip') as HTMLElement)?.getBoundingClientRect();
        if (chipRect) {
            const vpTop = (window.visualViewport?.offsetTop ?? 0);
            menu.style.top  = (chipRect.bottom + 4 - vpTop) + 'px';
            menu.style.left = chipRect.left + 'px';
            // Clamp so the menu doesn't overflow the right edge of the screen
            const menuWidth = 220;
            const maxLeft   = (window.visualViewport?.width ?? window.innerWidth) - menuWidth - 8;
            if (chipRect.left > maxLeft) menu.style.left = maxLeft + 'px';
        }

        this.attachDismissListener(menu);
    }

    private updateContextChipLabel() {
        if (this.pinnedContextFile) {
            this.contextChipLabel.textContent = this.pinnedContextFile.basename;
            return;
        }
        const active = this.app.workspace.getActiveFile();
        this.contextChipLabel.textContent = active ? active.basename : 'No file';
    }

    // ── Model dropdown ────────────────────────────────────────────────────────

    private getModelLabel(value: string): string {
        const opt = MODEL_OPTIONS.find(o => o.value === value);
        return opt ? opt.label : value;
    }

    private openModelDropdown(anchor: HTMLElement, e: MouseEvent) {
        e.stopPropagation();

        const menu = document.createElement('div');
        menu.className = 'vc-model-menu';

        for (const opt of MODEL_OPTIONS) {
            const item = menu.createDiv({ cls: 'vc-model-menu-item' + (opt.value === this.activeModel ? ' vc-model-menu-item-active' : '') });
            item.textContent = opt.label;
            if (opt.value === this.activeModel) {
                const check = item.createSpan({ cls: 'vc-model-check' });
                setIcon(check, 'check');
            }
            item.addEventListener('click', () => {
                this.activeModel = opt.value;
                this.llmProvider.settings = { ...this.plugin.settings, defaultModel: opt.value };
                this.modelBtnLabel.textContent = opt.label;
                menu.remove();
            });
        }

        document.body.appendChild(menu);
        const anchorRect = anchor.getBoundingClientRect();
        const vpHeight   = window.visualViewport?.height ?? window.innerHeight;
        // Open upward: bottom edge of menu anchors to top of button
        menu.style.bottom = (vpHeight - anchorRect.top + 4) + 'px';
        // Clamp left so menu doesn't overflow screen edges
        const menuWidth = 220;
        const vw        = window.visualViewport?.width ?? window.innerWidth;
        const clampedLeft = Math.min(anchorRect.left, vw - menuWidth - 8);
        menu.style.left = Math.max(8, clampedLeft) + 'px';

        this.attachDismissListener(menu);
    }

    /**
     * Attaches a dismiss listener to a floating menu that closes it when the
     * user taps or clicks anywhere outside it.
     *
     * Listens on BOTH 'mousedown' (desktop) and 'touchstart' (iOS/iPadOS) —
     * iOS Safari fires touch events, not mouse events, for taps outside modals.
     * Without touchstart the menu would never close on mobile.
     */
    private attachDismissListener(menu: HTMLElement) {
        const close = (e: Event) => {
            if (!menu.contains(e.target as Node)) {
                menu.remove();
                document.removeEventListener('mousedown', close);
                document.removeEventListener('touchstart', close);
            }
        };
        setTimeout(() => {
            document.addEventListener('mousedown', close);
            document.addEventListener('touchstart', close, { passive: true });
        }, 0);
    }

    // ── Rendering helpers ─────────────────────────────────────────────────────

    private autoGrow() {
        this.textArea.style.height = 'auto';
        this.textArea.style.height = Math.min(this.textArea.scrollHeight, 160) + 'px';
    }

    renderAttachments() {
        this.filesDiv.empty();
        for (let i = 0; i < this.attachments.length; i++) {
            const att = this.attachments[i];
            const pill = this.filesDiv.createDiv({ cls: 'vc-attachment-pill' });
            const ic = pill.createSpan();
            setIcon(ic, 'file');
            pill.createSpan({ text: att.name });
            const removeBtn = pill.createSpan({ cls: 'vc-attachment-remove' });
            setIcon(removeBtn, 'x');
            removeBtn.addEventListener('click', () => {
                this.attachments.splice(i, 1);
                this.renderAttachments();
            });
        }
    }

    renderMessages() {
        this.messagesDiv.empty();

        if (this.messages.length === 0) {
            const empty = this.messagesDiv.createDiv({ cls: 'vc-empty-state' });
            const emptyIcon = empty.createDiv({ cls: 'vc-empty-icon' });
            setIcon(emptyIcon, 'message-circle');
            empty.createDiv({ cls: 'vc-empty-text', text: 'Ask anything about your vault.' });
            return;
        }

        for (const msg of this.messages) {
            const bubble = this.messagesDiv.createDiv({
                cls: `vc-bubble vc-bubble-${msg.role}`
            });

            if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
                const attBadge = bubble.createDiv({ cls: 'vc-bubble-attachments' });
                for (const a of msg.attachments) {
                    const p = attBadge.createDiv({ cls: 'vc-bubble-att-pill' });
                    const ic = p.createSpan();
                    setIcon(ic, 'file');
                    p.createSpan({ text: a.name });
                }
            }

            const contentEl = bubble.createDiv({ cls: 'vc-bubble-content' });
            if (msg.role === 'user') {
                contentEl.textContent = msg.content;
            } else if (msg.content === '…') {
                contentEl.addClass('vc-loading');
                contentEl.createSpan({ cls: 'vc-dot' });
                contentEl.createSpan({ cls: 'vc-dot' });
                contentEl.createSpan({ cls: 'vc-dot' });
            } else {
                MarkdownRenderer.renderMarkdown(msg.content, contentEl, '', this.plugin);

                const actions = bubble.createDiv({ cls: 'vc-bubble-actions' });

                const saveBtn = actions.createEl('button', { cls: 'vc-action-btn', text: 'Save to note' });
                saveBtn.addEventListener('click', () => {
                    new DiffPreview(
                        this.plugin.app,
                        msg.content,
                        async (final, _c, _t) => { await this.createNewNoteWithContent(final); }
                    ).open();
                });

                const applyBtn = actions.createEl('button', { cls: 'vc-action-btn', text: 'Apply to active note' });
                applyBtn.addEventListener('click', async () => {
                    const af = this.plugin.app.workspace.getActiveFile();
                    if (!af) { new Notice('No active note.'); return; }
                    let content = msg.content;
                    const match = content.match(/```markdown\r?\n([\s\S]*?)\r?\n```/i);
                    if (match) content = match[1];
                    new DiffPreview(this.plugin.app, content, async (final) => {
                        await this.plugin.app.vault.modify(af, final);
                        new Notice(`Applied to ${af.name}`);
                    }).open();
                });
            }
        }

        this.messagesDiv.scrollTop = this.messagesDiv.scrollHeight;
    }

    async createNewNoteWithContent(content: string) {
        const title = `Copilot Note ${window.moment().format('YYYY-MM-DD HH-mm-ss')}`;
        const newFile = await this.plugin.app.vault.create(`${title}.md`, content);
        const leaf = this.plugin.app.workspace.getLeaf(true);
        await leaf.openFile(newFile);
        new Notice(`Saved to ${title}`);
    }

    async getOmnisearchContext(query: string): Promise<string> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((window as any).omnisearch) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const results = await (window as any).omnisearch.search(query);
                if (results && results.length > 0) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return results.slice(0, 5).map((r: any) => `### ${r.basename}\n${r.excerpt}`).join('\n\n');
                }
            } catch (err) {
                console.error('Omnisearch error:', err);
            }
        }
        return '';
    }

    async startNewChat() {
        if (this.messages.length === 0) return;

        const notice = new Notice('Saving memory & starting new chat…', 0);
        try {
            const extraction = [...this.messages, {
                role: 'user' as const,
                content: PromptLibrary.getMemoryExtractionPrompt()
            }];
            this.llmProvider.settings = { ...this.plugin.settings, defaultModel: this.activeModel };
            const response = await this.llmProvider.generateResponse(extraction);
            if (!response.includes('NO_NEW_MEMORY')) {
                const current = this.plugin.settings.chatMemory || '';
                this.plugin.settings.chatMemory = (current + '\n' + response).trim();
                await this.plugin.saveData(this.plugin.settings);
            }
        } catch (err) {
            console.error('Memory extraction failed:', err);
            new Notice('Could not save memory, starting fresh anyway.');
        } finally {
            notice.hide();
        }

        this.messages = [];
        this.attachments = [];
        this.renderAttachments();
        this.renderMessages();
    }

    async sendMessage() {
        let text = this.textArea.value.trim();

        for (const p of PromptLibrary.getPrompts()) {
            if (text.startsWith(p.label)) {
                text = text.replace(p.label, p.prompt);
                break;
            }
        }

        if (!text && this.attachments.length === 0) return;

        const userMsg: ChatMessage = {
            role: 'user',
            content: text,
            attachments: [...this.attachments]
        };
        this.messages.push(userMsg);

        this.textArea.value = '';
        this.textArea.style.height = 'auto';
        this.attachments = [];
        this.renderAttachments();
        this.renderMessages();

        const loadingMsg: ChatMessage = { role: 'assistant', content: '…' };
        this.messages.push(loadingMsg);
        this.renderMessages();

        try {
            // Always use the active session model
            this.llmProvider.settings = { ...this.plugin.settings, defaultModel: this.activeModel };

            const toSend = [...this.messages.slice(0, -1)];

            // Inject context note — pinned takes priority, otherwise active note
            const contextFile = this.pinnedContextFile ?? this.plugin.app.workspace.getActiveFile();
            if (contextFile) {
                const content = await this.plugin.app.vault.read(contextFile);
                toSend.unshift({
                    role: 'system',
                    content: PromptLibrary.getInteractiveEditPrompt(contextFile.name, content)
                });
            }

            const omniContext = await this.getOmnisearchContext(text);
            if (omniContext) {
                toSend.unshift({
                    role: 'system',
                    content: PromptLibrary.getVaultContextPrompt(omniContext)
                });
            }

            if (this.plugin.settings.chatMemory) {
                toSend.unshift({
                    role: 'system',
                    content: PromptLibrary.getMemoryInjectionPrompt(this.plugin.settings.chatMemory)
                });
            }

            const response = await this.llmProvider.generateResponse(toSend);
            this.messages.pop();
            this.messages.push({ role: 'assistant', content: response });
        } catch (error) {
            this.messages.pop();
            this.messages.push({ role: 'assistant', content: `**Error:** ${(error as Error).message}` });
        }

        this.renderMessages();
    }
}
