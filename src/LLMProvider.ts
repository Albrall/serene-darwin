import { requestUrl, RequestUrlParam } from 'obsidian';
import type { VaultCopilotSettings } from './settings';
import { PDFHandler } from './PDFHandler';

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    attachments?: Array<{
        name: string;
        mimeType: string;
        data: ArrayBuffer;
    }>;
}

// ── Improvement A: typed provider union ───────────────────────────────────────
// Using a string union (not an enum) keeps the prefix syntax readable in
// settings and avoids a runtime enum-value lookup.
type ModelProvider = 'openrouter' | 'openai' | 'gemini';

interface ParsedModel {
    provider: ModelProvider;
    modelId: string;
}

/** Splits "openrouter:deepseek/deepseek-chat-v3-0324:free" into provider + id. */
function parseModelString(raw: string): ParsedModel {
    const colonIdx = raw.indexOf(':');
    if (colonIdx === -1) {
        // Legacy un-prefixed value (e.g. "gpt-4o" or "gemini-1.5-flash")
        if (raw.startsWith('gpt') || raw.startsWith('o1') || raw.startsWith('o3')) {
            return { provider: 'openai', modelId: raw };
        }
        if (raw.startsWith('gemini')) {
            return { provider: 'gemini', modelId: raw };
        }
        throw new Error(`Unknown model: "${raw}". Use the format provider:model-id (e.g. openai:gpt-4o).`);
    }

    const prefix = raw.slice(0, colonIdx);
    const modelId = raw.slice(colonIdx + 1);

    const validProviders: ModelProvider[] = ['openrouter', 'openai', 'gemini'];
    if (!validProviders.includes(prefix as ModelProvider)) {
        throw new Error(`Unknown provider prefix "${prefix}" in model "${raw}". Valid prefixes: ${validProviders.join(', ')}.`);
    }

    return { provider: prefix as ModelProvider, modelId };
}

// ── Improvement B: provider → API key map ────────────────────────────────────
// One place to see which setting key each provider needs, instead of
// duplicating the "key missing" check inside every callXxx() method.

export class LLMProvider {
    settings: VaultCopilotSettings;

    // Lazily-evaluated key getters. Using arrow functions (not closures over
    // `this.settings`) because `settings` may be replaced between calls.
    private readonly providerKeyMap: Record<ModelProvider, () => string> = {
        openrouter: () => (this.settings.openrouterApiKey || '').trim(),
        openai:     () => (this.settings.openaiApiKey     || '').trim(),
        gemini:     () => (this.settings.geminiApiKey     || '').trim(),
    };

    constructor(settings: VaultCopilotSettings) {
        this.settings = settings;
    }

    /** Returns the API key for `provider`, or throws a user-visible error. */
    private requireApiKey(provider: ModelProvider): string {
        const key = this.providerKeyMap[provider]();
        if (!key) {
            const settingNames: Record<ModelProvider, string> = {
                openrouter: 'OpenRouter API Key',
                openai:     'OpenAI API Key',
                gemini:     'Gemini API Key',
            };
            throw new Error(
                `${settingNames[provider]} is missing. ` +
                `Add it in Settings → Vault Copilot → ${settingNames[provider]}.`
            );
        }
        return key;
    }

    async generateResponse(messages: ChatMessage[], onToken?: (chunk: string) => void): Promise<string> {
        const raw = (this.settings.defaultModel || 'openrouter:deepseek/deepseek-chat-v3-0324:free').trim();
        const { provider, modelId } = parseModelString(raw);

        // TypeScript exhaustiveness — if a new provider is added to the union
        // without a case here, the compiler will flag it.
        switch (provider) {
            case 'openrouter': return this.callOpenRouter(modelId, messages, onToken);
            case 'openai':     return this.callOpenAI(modelId, messages, onToken);
            case 'gemini':     return this.callGemini(modelId, messages, onToken);
        }
    }

    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    /**
     * Calls OpenRouter's OpenAI-compatible endpoint.
     *
     * OpenRouter accepts the same request format as OpenAI /v1/chat/completions
     * but routes to many model backends. We use requestUrl (not fetch) to satisfy
     * the mobile CORS constraint (AGENTS.md rule 7).
     *
     * PDF attachments are text-extracted first since OpenRouter models generally
     * don't accept binary inlineData — only the Gemini direct API does that.
     */
    private async callOpenRouter(modelId: string, messages: ChatMessage[], onToken?: (chunk: string) => void): Promise<string> {
        const apiKey = this.requireApiKey('openrouter');

        const orMessages = await Promise.all(messages.map(async msg => {
            if (!msg.attachments || msg.attachments.length === 0) {
                return { role: msg.role, content: msg.content };
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const parts: any[] = [{ type: 'text', text: msg.content }];
            for (const att of msg.attachments) {
                if (att.mimeType.startsWith('image/')) {
                    const base64 = this.arrayBufferToBase64(att.data);
                    parts.push({
                        type: 'image_url',
                        image_url: { url: `data:${att.mimeType};base64,${base64}` }
                    });
                } else if (att.mimeType === 'application/pdf') {
                    try {
                        const text = await PDFHandler.extractPdfText(att.data);
                        parts.push({ type: 'text', text: `\n--- ${att.name} ---\n${text}\n---\n` });
                    } catch {
                        parts.push({ type: 'text', text: `\n--- ${att.name} (unreadable) ---\n` });
                    }
                } else if (att.mimeType === 'text/plain' || att.mimeType === 'text/markdown') {
                    const text = new TextDecoder('utf-8').decode(att.data);
                    parts.push({ type: 'text', text: `\n--- ${att.name} ---\n${text}\n---\n` });
                }
            }
            return { role: msg.role, content: parts };
        }));

        let body: string;
        try {
            body = JSON.stringify({ model: modelId, messages: orMessages, stream: !!onToken });
        } catch (err) {
            throw new Error(`Failed to serialize OpenRouter request: ${(err as Error).message}`);
        }

        const headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'obsidian://vault-copilot',
            'X-Title': 'Vault Copilot',
        };

        if (onToken) {
            try {
                const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers,
                    body
                });
                
                if (!response.ok) {
                    throw new Error(`OpenRouter error ${response.status}: ${await response.text()}`);
                }

                if (!response.body) throw new Error("No response body");
                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let fullContent = '';
                let buffer = '';
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let newlineIndex;
                    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                        const line = buffer.slice(0, newlineIndex).trim();
                        buffer = buffer.slice(newlineIndex + 1);
                        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                            try {
                                const parsed = JSON.parse(line.slice(6));
                                const content = parsed.choices[0]?.delta?.content || '';
                                if (content) {
                                    fullContent += content;
                                    onToken(content);
                                }
                            } catch (e) {
                                // ignore parse errors on partial chunks
                            }
                        }
                    }
                }
                return fullContent;
            } catch (error) {
                console.error('LLMProvider OpenRouter streaming error:', error);
                throw new Error(`OpenRouter streaming failed (check CORS or connection): ${(error as Error).message}`);
            }
        } else {
            const request: RequestUrlParam = {
                url: 'https://openrouter.ai/api/v1/chat/completions',
                method: 'POST',
                headers,
                body,
                throw: false,
            };

            try {
                const response = await requestUrl(request);
                if (response.status !== 200) {
                    throw new Error(`OpenRouter error ${response.status}: ${JSON.stringify(response.json)}`);
                }
                return response.json.choices[0].message.content;
            } catch (error) {
                console.error('LLMProvider OpenRouter error:', error);
                throw new Error(`OpenRouter request failed: ${(error as Error).message}`);
            }
        }
    }

    private async callOpenAI(model: string, messages: ChatMessage[], onToken?: (chunk: string) => void): Promise<string> {
        const apiKey = this.requireApiKey('openai');

        const openAiMessages = await Promise.all(messages.map(async msg => {
            if (!msg.attachments || msg.attachments.length === 0) {
                return { role: msg.role, content: msg.content };
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const contentParts: any[] = [{ type: 'text', text: msg.content }];

            for (const att of msg.attachments) {
                if (att.mimeType.startsWith('image/')) {
                    const base64 = this.arrayBufferToBase64(att.data);
                    contentParts.push({
                        type: 'image_url',
                        image_url: { url: `data:${att.mimeType};base64,${base64}` }
                    });
                } else if (att.mimeType === 'application/pdf') {
                    // OpenAI's standard chat/completions endpoint does not accept
                    // native PDF binary — extract text first as a fallback.
                    try {
                        const extractedText = await PDFHandler.extractPdfText(att.data);
                        contentParts.push({
                            type: 'text',
                            text: `\n--- Attachment: ${att.name} (Extracted Text) ---\n${extractedText}\n--- End Attachment ---\n`
                        });
                    } catch (e) {
                        console.error(`Failed to extract text from PDF: ${att.name}`, e);
                        contentParts.push({
                            type: 'text',
                            text: `\n--- Attachment: ${att.name} ---\n[UNREADABLE SECTION - PDF EXTRACTION FAILED]\n--- End Attachment ---\n`
                        });
                    }
                } else if (att.mimeType === 'text/plain' || att.mimeType === 'text/markdown') {
                    const text = new TextDecoder('utf-8').decode(att.data);
                    contentParts.push({
                        type: 'text',
                        text: `\n--- Attachment: ${att.name} ---\n${text}\n--- End Attachment ---\n`
                    });
                } else {
                    console.warn(`OpenAI standard chat may not support native ${att.mimeType} inline.`);
                }
            }

            return { role: msg.role, content: contentParts };
        }));

        let body: string;
        try {
            body = JSON.stringify({ model, messages: openAiMessages, stream: !!onToken });
        } catch (err) {
            throw new Error(`Failed to serialize OpenAI request: ${(err as Error).message}`);
        }

        const headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        };

        if (onToken) {
            try {
                const response = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers,
                    body
                });
                
                if (!response.ok) {
                    throw new Error(`OpenAI API error: ${response.status} - ${await response.text()}`);
                }

                if (!response.body) throw new Error("No response body");
                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let fullContent = '';
                let buffer = '';
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let newlineIndex;
                    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                        const line = buffer.slice(0, newlineIndex).trim();
                        buffer = buffer.slice(newlineIndex + 1);
                        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                            try {
                                const parsed = JSON.parse(line.slice(6));
                                const content = parsed.choices[0]?.delta?.content || '';
                                if (content) {
                                    fullContent += content;
                                    onToken(content);
                                }
                            } catch (e) {
                                // ignore parse errors on partial chunks
                            }
                        }
                    }
                }
                return fullContent;
            } catch (error) {
                console.error('LLMProvider OpenAI streaming error:', error);
                throw new Error(`OpenAI streaming failed (check CORS or connection): ${(error as Error).message}`);
            }
        } else {
            const request: RequestUrlParam = {
                url: 'https://api.openai.com/v1/chat/completions',
                method: 'POST',
                headers,
                body,
                throw: false,
            };

            try {
                const response = await requestUrl(request);
                if (response.status !== 200) {
                    throw new Error(`OpenAI API error: ${response.status} - ${JSON.stringify(response.json)}`);
                }
                return response.json.choices[0].message.content;
            } catch (error) {
                console.error('LLMProvider OpenAI Error:', error);
                throw new Error(`Failed to get response from OpenAI: ${(error as Error).message}`);
            }
        }
    }

    private async callGemini(model: string, messages: ChatMessage[], onToken?: (chunk: string) => void): Promise<string> {
        const apiKey = this.requireApiKey('gemini');

        const geminiContents = await Promise.all(messages.filter(msg => msg.role !== 'system').map(async msg => {
            const role = msg.role === 'assistant' ? 'model' : 'user';
            
            if (!msg.attachments || msg.attachments.length === 0) {
                return { role, parts: [{ text: msg.content }] };
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const parts: any[] = [{ text: msg.content }];
            for (const att of msg.attachments) {
                if (att.mimeType === 'text/plain' || att.mimeType === 'text/markdown') {
                    const text = new TextDecoder('utf-8').decode(att.data);
                    parts.push({ text: `\n--- ${att.name} ---\n${text}\n---\n` });
                } else {
                    const base64 = this.arrayBufferToBase64(att.data);
                    parts.push({ inlineData: { mimeType: att.mimeType, data: base64 } });
                }
            }
            return { role, parts };
        }));

        const systemMessages = messages.filter(msg => msg.role === 'system');
        const systemInstruction = systemMessages.length > 0
            ? { parts: [{ text: systemMessages.map(m => m.content).join('\n') }] }
            : undefined;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload: any = { contents: geminiContents };
        if (systemInstruction) {
            payload.systemInstruction = systemInstruction;
        }

        let body: string;
        try {
            body = JSON.stringify(payload);
        } catch (err) {
            throw new Error(`Failed to serialize Gemini request: ${(err as Error).message}`);
        }

        if (onToken) {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body
                });

                if (!response.ok) {
                    throw new Error(`Gemini error ${response.status}: ${await response.text()}`);
                }

                if (!response.body) throw new Error("No response body");
                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let fullContent = '';
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let newlineIndex;
                    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                        const line = buffer.slice(0, newlineIndex).trim();
                        buffer = buffer.slice(newlineIndex + 1);
                        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                            try {
                                const parsed = JSON.parse(line.slice(6));
                                const content = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
                                if (content) {
                                    fullContent += content;
                                    onToken(content);
                                }
                            } catch (e) {
                                // ignore parse errors on partial chunks
                            }
                        }
                    }
                }
                return fullContent;
            } catch (error) {
                console.error('LLMProvider Gemini streaming error:', error);
                throw new Error(`Gemini streaming failed: ${(error as Error).message}`);
            }
        } else {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const request: RequestUrlParam = {
                url,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                throw: false,
            };

            try {
                const response = await requestUrl(request);
                if (response.status !== 200) {
                    throw new Error(`Gemini error ${response.status}: ${JSON.stringify(response.json)}`);
                }
                const text = response.json.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!text) throw new Error('Gemini returned an empty or invalid response structure.');
                return text;
            } catch (error) {
                console.error('LLMProvider Gemini Error:', error);
                throw new Error(`Gemini request failed: ${(error as Error).message}`);
            }
        }
    }
}
