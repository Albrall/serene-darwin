import { requestUrl, RequestUrlParam } from 'obsidian';
import type { VaultCopilotSettings } from './settings';
import { PDFHandler } from './PDFHandler';

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    attachments?: Array<{
        name: string;
        mimeType: string;
        data: ArrayBuffer; // We will convert to Base64
    }>;
}

export class LLMProvider {
    settings: VaultCopilotSettings;

    constructor(settings: VaultCopilotSettings) {
        this.settings = settings;
    }

    async generateResponse(messages: ChatMessage[]): Promise<string> {
        const raw = (this.settings.defaultModel || 'openrouter:deepseek/deepseek-chat-v3-0324:free').trim();

        if (raw.startsWith('openrouter:')) {
            const modelId = raw.slice('openrouter:'.length);
            return this.callOpenRouter(modelId, messages);
        } else if (raw.startsWith('openai:')) {
            const modelId = raw.slice('openai:'.length);
            return this.callOpenAI(modelId, messages);
        } else if (raw.startsWith('gemini:')) {
            const modelId = raw.slice('gemini:'.length);
            return this.callGemini(modelId, messages);
        } else if (raw.startsWith('gpt')) {
            // Legacy unprefixed OpenAI model value
            return this.callOpenAI(raw, messages);
        } else if (raw.startsWith('gemini')) {
            // Legacy unprefixed Gemini model value
            return this.callGemini(raw, messages);
        } else {
            throw new Error(`Unknown model: "${raw}". Check the model setting.`);
        }
    }

    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
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
    private async callOpenRouter(modelId: string, messages: ChatMessage[]): Promise<string> {
        const apiKey = (this.settings.openrouterApiKey || '').trim();
        if (!apiKey) {
            throw new Error('OpenRouter API key is missing. Add it in plugin Settings → OpenRouter API Key.');
        }

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

        const request = {
            url: 'https://openrouter.ai/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'obsidian://vault-copilot',
                'X-Title': 'Vault Copilot',
            },
            body: JSON.stringify({ model: modelId, messages: orMessages }),
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

    private async callOpenAI(model: string, messages: ChatMessage[]): Promise<string> {
        const apiKey = (this.settings.openaiApiKey || '').trim();
        if (!apiKey) {
            throw new Error("OpenAI API key is missing. Please set it in the plugin settings.");
        }

        const openAiMessages = await Promise.all(messages.map(async msg => {
            if (!msg.attachments || msg.attachments.length === 0) {
                return { role: msg.role, content: msg.content };
            }

            // If there are attachments, format as array (OpenAI Vision API style)
            const contentParts: any[] = [{ type: "text", text: msg.content }];
            
            for (const att of msg.attachments) {
                const base64 = this.arrayBufferToBase64(att.data);
                // Note: OpenAI chat/completions natively supports images, but for PDFs it requires Assistants API.
                // We will try sending it as an image URL just in case, or warn if it's a PDF.
                if (att.mimeType.startsWith('image/')) {
                    contentParts.push({
                        type: "image_url",
                        image_url: { url: `data:${att.mimeType};base64,${base64}` }
                    });
                } else if (att.mimeType === 'application/pdf') {
                    try {
                        const extractedText = await PDFHandler.extractPdfText(att.data);
                        contentParts.push({ 
                            type: "text", 
                            text: `\n--- Attachment: ${att.name} (Extracted Text) ---\n${extractedText}\n--- End Attachment ---\n` 
                        });
                    } catch (e) {
                        console.error(`Failed to extract text from PDF: ${att.name}`, e);
                        contentParts.push({ type: "text", text: `\n--- Attachment: ${att.name} ---\n[UNREADABLE SECTION - PDF EXTRACTION FAILED]\n--- End Attachment ---\n` });
                    }
                } else {
                    // For non-images on OpenAI without text extraction, this might fail or be ignored.
                    // We just pass it as text if it's txt/md.
                    if (att.mimeType === 'text/plain' || att.mimeType === 'text/markdown') {
                        const decoder = new TextDecoder('utf-8');
                        const text = decoder.decode(att.data);
                        contentParts.push({ type: "text", text: `\n--- Attachment: ${att.name} ---\n${text}\n--- End Attachment ---\n` });
                    } else {
                        console.warn(`OpenAI standard chat may not support native ${att.mimeType} inline.`);
                    }
                }
            }

            return { role: msg.role, content: contentParts };
        }));

        const request: RequestUrlParam = {
            url: 'https://api.openai.com/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model,
                messages: openAiMessages
            }),
            throw: false
        };

        try {
            const response = await requestUrl(request);
            if (response.status !== 200) {
                throw new Error(`OpenAI API error: ${response.status} - ${JSON.stringify(response.json)}`);
            }
            return response.json.choices[0].message.content;
        } catch (error) {
            console.error("LLMProvider OpenAI Error:", error);
            throw new Error(`Failed to get response from OpenAI: ${(error as Error).message}`);
        }
    }

    private async callGemini(model: string, messages: ChatMessage[]): Promise<string> {
        const apiKey = (this.settings.geminiApiKey || '').trim();
        if (!apiKey) {
            throw new Error("Gemini API key is missing. Please set it in the plugin settings.");
        }

        const geminiContents = messages.filter(msg => msg.role !== 'system').map(msg => {
            const parts: any[] = [];
            
            if (msg.content) {
                parts.push({ text: msg.content });
            }

            if (msg.attachments) {
                for (const att of msg.attachments) {
                    const base64 = this.arrayBufferToBase64(att.data);
                    if (att.mimeType === 'text/plain' || att.mimeType === 'text/markdown') {
                        const decoder = new TextDecoder('utf-8');
                        const text = decoder.decode(att.data);
                        parts.push({ text: `\n--- Attachment: ${att.name} ---\n${text}\n--- End Attachment ---\n` });
                    } else {
                        // Gemini supports inlineData for PDF and images
                        parts.push({
                            inlineData: {
                                mimeType: att.mimeType,
                                data: base64
                            }
                        });
                    }
                }
            }

            return {
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: parts
            };
        });

        // Handle system instructions
        const systemMessages = messages.filter(msg => msg.role === 'system');
        const systemInstruction = systemMessages.length > 0 
            ? { parts: [{ text: systemMessages.map(m => m.content).join('\n') }] }
            : undefined;

        const requestBody: any = {
            contents: geminiContents,
        };
        if (systemInstruction) {
            requestBody.systemInstruction = systemInstruction;
        }

        const request: RequestUrlParam = {
            url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody),
            throw: false
        };

        try {
            const response = await requestUrl(request);
            if (response.status !== 200) {
                throw new Error(`Gemini API error: ${response.status} - ${JSON.stringify(response.json)}`);
            }
            if (response.json.candidates && response.json.candidates.length > 0) {
                return response.json.candidates[0].content.parts[0].text;
            }
            throw new Error("No response candidates returned from Gemini.");
        } catch (error) {
            console.error("LLMProvider Gemini Error:", error);
            throw new Error(`Failed to get response from Gemini: ${(error as Error).message}`);
        }
    }
}
