import { App, PluginSettingTab, Setting } from 'obsidian';
import type VaultCopilot from '../main';

export interface VaultCopilotSettings {
    // Phase 6
    chatMemory: string;

    // Phase 1
    openaiApiKey: string;
    geminiApiKey: string;
    openrouterApiKey: string;
    defaultModel: string;

    // Phase 2
    /** Exact filename (without .md) of the central MOC / index note. */
    mocNoteName: string;
    /**
     * Folder path to scope vault indexing (e.g. "Lectures/Notes").
     * Leave empty to index the entire vault.
     */
    vaultIndexFolder: string;
    /**
     * Folder path where new concept stub notes will be proposed.
     * Leave empty to propose them in the vault root.
     */
    newConceptFolder: string;
    /**
     * Conflict detection depth:
     *   "shallow" — the LLM uses note titles only; fast, lower token cost.
     *   "deep"    — the LLM receives a snippet from each matched note's body;
     *               more accurate but slower and uses more tokens.
     */
    conflictDetectionMode: 'shallow' | 'deep';
}

export const DEFAULT_SETTINGS: VaultCopilotSettings = {
    chatMemory: '',

    openaiApiKey: '',
    geminiApiKey: '',
    openrouterApiKey: '',
    // Default to DeepSeek V4 Flash via OpenRouter
    defaultModel: 'openrouter:deepseek/deepseek-chat-v3-0324:free',

    // Phase 2 defaults — all configurable without a rebuild
    mocNoteName: 'MOC',
    vaultIndexFolder: '',
    newConceptFolder: '',
    conflictDetectionMode: 'shallow',
};

/**
 * Curated model list shown in the in-panel dropdown.
 * Format: "<provider>:<model-id>" — the prefix tells LLMProvider which API to call.
 *
 * OpenRouter models use the "openrouter:" prefix.
 * OpenAI models use the "openai:" prefix (no prefix needed for legacy compat but canonical form used here).
 * Gemini models use the "gemini:" prefix.
 */
export interface ModelOption {
    value: string;
    label: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
    { value: 'openrouter:deepseek/deepseek-chat-v3-0324:free', label: 'DeepSeek V4 Flash' },
    { value: 'openai:gpt-5.4-mini',                            label: 'ChatGPT 5.4 Mini' },
    { value: 'gemini:gemini-3.1-flash',                        label: 'Gemini 3.1 Flash' },
];

export class VaultCopilotSettingTab extends PluginSettingTab {
    plugin: VaultCopilot;

    constructor(app: App, plugin: VaultCopilot) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // ── Phase 1 ──────────────────────────────────────────────────────────
        containerEl.createEl('h2', { text: 'API Keys & Model' });

        new Setting(containerEl)
            .setName('OpenRouter API Key')
            .setDesc('Primary key — used for all OpenRouter models (DeepSeek, Gemini, Claude, GPT via OpenRouter). Get one free at openrouter.ai.')
            .addText(text => text
                .setPlaceholder('sk-or-...')
                .setValue(this.plugin.settings.openrouterApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.openrouterApiKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('OpenAI API Key')
            .setDesc('Only needed if using OpenAI direct models (not via OpenRouter).')
            .addText(text => text
                .setPlaceholder('sk-...')
                .setValue(this.plugin.settings.openaiApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.openaiApiKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Gemini API Key')
            .setDesc('Only needed if using Gemini direct models (not via OpenRouter).')
            .addText(text => text
                .setPlaceholder('AIza...')
                .setValue(this.plugin.settings.geminiApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.geminiApiKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Default Model')
            .setDesc('The model loaded by default when the chat panel opens. Can be changed per-session using the in-panel dropdown.')
            .addDropdown(dropdown => {
                for (const opt of MODEL_OPTIONS) {
                    dropdown.addOption(opt.value, opt.label);
                }
                // Handle legacy model values (no prefix) gracefully
                const currentVal = this.plugin.settings.defaultModel;
                const known = MODEL_OPTIONS.some(o => o.value === currentVal);
                if (!known) dropdown.addOption(currentVal, currentVal);
                dropdown.setValue(currentVal);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.defaultModel = value;
                    await this.plugin.saveSettings();
                });
            });

        // ── Phase 2 ──────────────────────────────────────────────────────────
        containerEl.createEl('h2', { text: 'Vault Indexing & Smart Linking' });

        new Setting(containerEl)
            .setName('MOC Note Name')
            .setDesc(
                'The exact filename (without .md) of your central Map of Content / index note. ' +
                'Every new lecture note will be linked there automatically. ' +
                'If the note doesn\'t exist yet the plugin will create it.'
            )
            .addText(text => text
                .setPlaceholder('MOC')
                .setValue(this.plugin.settings.mocNoteName)
                .onChange(async (value) => {
                    this.plugin.settings.mocNoteName = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Vault Index Folder')
            .setDesc(
                'Restrict vault indexing to this folder path (e.g. "Lectures/Notes"). ' +
                'Leave blank to index the entire vault.'
            )
            .addText(text => text
                .setPlaceholder('(entire vault)')
                .setValue(this.plugin.settings.vaultIndexFolder)
                .onChange(async (value) => {
                    this.plugin.settings.vaultIndexFolder = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('New Concept Note Folder')
            .setDesc(
                'Folder where proposed new concept stub notes will be saved (e.g. "Concepts"). ' +
                'Leave blank to save them in the vault root.'
            )
            .addText(text => text
                .setPlaceholder('(vault root)')
                .setValue(this.plugin.settings.newConceptFolder)
                .onChange(async (value) => {
                    this.plugin.settings.newConceptFolder = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Conflict Detection Mode')
            .setDesc(
                '"Shallow" checks titles only (fast, fewer tokens). ' +
                '"Deep" feeds a snippet of each matched note\'s content to the model for a more accurate comparison (slower).'
            )
            .addDropdown(dropdown => dropdown
                .addOption('shallow', 'Shallow (fast)')
                .addOption('deep', 'Deep (accurate)')
                .setValue(this.plugin.settings.conflictDetectionMode)
                .onChange(async (value) => {
                    this.plugin.settings.conflictDetectionMode = value as 'shallow' | 'deep';
                    await this.plugin.saveSettings();
                }));
    }
}
