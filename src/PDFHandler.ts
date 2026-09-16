import { App, TFile, loadPdfJs } from 'obsidian';

export interface AttachmentData {
    name: string;
    mimeType: string;
    data: ArrayBuffer;
}

export class PDFHandler {
    /**
     * Reads an existing vault file as an ArrayBuffer using Obsidian's API.
     */
    static async readVaultFile(app: App, file: TFile): Promise<AttachmentData> {
        const arrayBuffer = await app.vault.readBinary(file);
        let mimeType = 'application/octet-stream';
        const extension = file.extension.toLowerCase();
        
        if (extension === 'pdf') mimeType = 'application/pdf';
        else if (extension === 'md') mimeType = 'text/markdown';
        else if (extension === 'txt') mimeType = 'text/plain';
        else if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) mimeType = `image/${extension === 'jpg' ? 'jpeg' : extension}`;

        return {
            name: file.name,
            mimeType,
            data: arrayBuffer
        };
    }

    /**
     * Extracts plain text from a PDF ArrayBuffer using Obsidian's bundled pdf.js.
     * Text only — no image extraction — keeping it lightweight and safe for iPadOS.
     */
    static async extractPdfText(data: ArrayBuffer): Promise<string> {
        let pdfjsLib;
        try {
            pdfjsLib = await loadPdfJs();
        } catch (error) {
            console.error("Failed to load pdf.js:", error);
            throw new Error('Failed to load pdf.js. Cannot extract PDF text.');
        }

        if (!pdfjsLib) {
            throw new Error(
                'pdf.js (pdfjsLib) is not available in this Obsidian environment. ' +
                'Cannot extract PDF text for OpenAI. Try using a Gemini model instead.'
            );
        }

        // getDocument accepts { data: ArrayBuffer } directly — no file path needed,
        // which satisfies the mobile/iOS constraint (AGENTS.md rule 8).
        const loadingTask = pdfjsLib.getDocument({ data });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pdf: any = await loadingTask.promise;

        const pageTexts: string[] = [];
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const page: any = await pdf.getPage(pageNum);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const content: any = await page.getTextContent();
            // pdf.js items expose `hasEOL` — use it to preserve line breaks so
            // bullet points and paragraph breaks are not collapsed into a single
            // run-on sentence (which would cause the linking LLM to lose structure).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rawPageText: string = content.items
                .map((item: any) => item.str + (item.hasEOL ? '\n' : ' '))
                .join('');

            const pageText = rawPageText;

            pageTexts.push(pageText.trimEnd());
        }

        // Separate pages with a blank line so heading structure is preserved
        return pageTexts.join('\n\n');
    }

    /**
     * Opens a native file picker dialogue and reads the selected file as an ArrayBuffer.
     * This works on mobile (iOS/Android) and desktop by relying on standard web APIs
     * and avoiding any `fs` or `file.path` dependencies.
     */
    static async selectAndReadFile(): Promise<AttachmentData | null> {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            // Allow PDF, MD, TXT, and common images
            input.accept = '.pdf,.md,.txt,image/*';
            input.multiple = false;

            input.onchange = async (e: Event) => {
                const target = e.target as HTMLInputElement;
                if (!target.files || target.files.length === 0) {
                    resolve(null);
                    return;
                }

                const file = target.files[0];
                const reader = new FileReader();

                reader.onload = async (e) => {
                    const arrayBuffer = e.target?.result as ArrayBuffer;
                    let mimeType = file.type;
                    
                    // Fallback for missing MIME types
                    if (!mimeType) {
                        if (file.name.endsWith('.pdf')) mimeType = 'application/pdf';
                        else if (file.name.endsWith('.md')) mimeType = 'text/markdown';
                        else if (file.name.endsWith('.txt')) mimeType = 'text/plain';
                        else mimeType = 'application/octet-stream';
                    }

                    resolve({
                        name: file.name,
                        mimeType: mimeType,
                        data: arrayBuffer
                    });
                };

                reader.onerror = () => {
                    console.error("Failed to read file");
                    resolve(null);
                };

                reader.readAsArrayBuffer(file);
            };

            // Trigger the file picker
            input.click();
        });
    }
}
