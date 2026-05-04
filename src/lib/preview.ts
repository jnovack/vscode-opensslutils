import { OpenSSLTextDocumentContentProvider } from './providers';
import * as vscode from 'vscode';


let currentPreviewDocument: vscode.TextDocument | null = null;


const previewUri = vscode.Uri.parse('openssl-preview://authority/OpenSSL%20Preview');
const inlineDetailPreviewUri = vscode.Uri.parse('openssl-preview://authority/OpenSSL%20Inline%20Preview');

let provider = new OpenSSLTextDocumentContentProvider();

type PreviewKind = 'certificate' | 'csr';

interface PreviewBlock {
    index: number;
    startLine: number;
    endLine: number;
    text: string;
    kind: PreviewKind;
}

interface ParsedInlinePreview {
    fullText: string;
    summaryText: string;
}

interface InlinePreviewState {
    blocks: PreviewBlock[];
    expanded: Set<number>;
    renderedPreviews: Map<number, ParsedInlinePreview>;
    autoLoaded: Set<number>;
}

interface PreviewCommandArgs {
    uri?: string;
    index?: number;
}

const inlinePreviewStates = new Map<string, InlinePreviewState>();

const inlineCodeLensEmitter = new vscode.EventEmitter<void>();

const inlineCodeLensProvider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: inlineCodeLensEmitter.event,
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const state = inlinePreviewStates.get(document.uri.toString());
        if (!state) {
            return [];
        }

        const lenses: vscode.CodeLens[] = [];
        const maxCertificates = getInlineMaxCertificates();

        state.blocks.forEach(block => {
            const range = new vscode.Range(block.startLine, 0, block.startLine, 0);
            const isRendered = block.index < maxCertificates || state.expanded.has(block.index);
            if (!isRendered) {
                lenses.push(new vscode.CodeLens(range, {
                    title: `Show preview`,
                    command: 'opensslutils.expandInlineOpenSSLPreview',
                    arguments: [{ uri: document.uri.toString(), index: block.index }]
                }));
                return;
            }

            const parsedPreview = state.renderedPreviews.get(block.index);
            if (!parsedPreview) {
                lenses.push(new vscode.CodeLens(range, {
                    title: 'Load Preview',
                    command: 'opensslutils.refreshInlineOpenSSLPreview',
                    arguments: [{ uri: document.uri.toString(), index: block.index }]
                }));
                return;
            }

            lenses.push(new vscode.CodeLens(range, {
                title: parsedPreview.summaryText,
                command: 'opensslutils.openInlineOpenSSLPreview',
                arguments: [{ uri: document.uri.toString(), index: block.index }]
            }));
            lenses.push(new vscode.CodeLens(range, {
                title: `$(refresh) Refresh`,
                command: 'opensslutils.refreshInlineOpenSSLPreview',
                arguments: [{ uri: document.uri.toString(), index: block.index }]
            }));
            lenses.push(new vscode.CodeLens(range, {
                title: 'Open Details',
                command: 'opensslutils.openInlineOpenSSLPreview',
                arguments: [{ uri: document.uri.toString(), index: block.index }]
            }));
        });

        return lenses;
    }
};

vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
    if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
        provider.update(previewUri);
    }
});
vscode.window.onDidChangeActiveTextEditor((e: vscode.TextEditor | undefined) => {
    if (vscode.window.activeTextEditor && e && e.document === vscode.window.activeTextEditor.document) {
        if (e.document === currentPreviewDocument) {
            return;
        }
        provider.update(previewUri);
        maybeAutoShowInlinePreview(e);
    }
});
vscode.window.onDidChangeTextEditorVisibleRanges((e: vscode.TextEditorVisibleRangesChangeEvent) => {
    maybeAutoShowInlinePreview(e.textEditor);
});
vscode.workspace.onDidCloseTextDocument((e: vscode.TextDocument) => {
    if (e === currentPreviewDocument) {
        currentPreviewDocument = null;
    }
    if (inlinePreviewStates.has(e.uri.toString())) {
        inlinePreviewStates.delete(e.uri.toString());
        inlineCodeLensEmitter.fire();
    }
});


function previewDocument() {
    provider.clearContent(previewUri);
    vscode.workspace.openTextDocument(previewUri).then(doc => {
        currentPreviewDocument = doc;
        vscode.window.showTextDocument(doc, {
            preserveFocus: true,
            preview: false,
            viewColumn: vscode.ViewColumn.Two
        });
    }, (reason) => {
        vscode.window.showErrorMessage(reason);
    });
}

function showOpenSSLPreview() {
    previewDocument();
}

function showInlinePreview() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
    }

    renderInlinePreviewForEditor(editor);
}

function renderInlinePreviewForEditor(editor: vscode.TextEditor) {
    if (editor.document === currentPreviewDocument) {
        return;
    }

    const blocks = extractPreviewBlocks(editor.document.getText());
    if (!blocks.length) {
        clearInlinePreview(editor.document.uri);
        return;
    }

    const state = getOrCreateInlineState(editor.document.uri.toString(), blocks);
    state.blocks = blocks;
    const maxCertificates = getInlineMaxCertificates();
    const nextRendered = new Map<number, ParsedInlinePreview>();
    state.renderedPreviews.forEach((value, index) => {
        if (index < maxCertificates || state.expanded.has(index)) {
            nextRendered.set(index, value);
        }
    });
    state.renderedPreviews = nextRendered;

    maybeAutoLoadVisibleBlocks(editor, state);

    inlineCodeLensEmitter.fire();
}

function maybeAutoShowInlinePreview(editor: vscode.TextEditor) {
    if (!isInlineCodeLensEnabled()) {
        return;
    }

    const uri = editor.document.uri.toString();
    if (inlinePreviewStates.has(uri)) {
        const state = inlinePreviewStates.get(uri);
        if (state) {
            maybeAutoLoadVisibleBlocks(editor, state);
        }
        inlineCodeLensEmitter.fire();
        return;
    }

    if (!extractPreviewBlocks(editor.document.getText()).length) {
        return;
    }

    renderInlinePreviewForEditor(editor);
}

function refreshInlinePreview(args?: PreviewCommandArgs) {
    const editor = getTargetEditor(args);
    if (!editor) {
        return;
    }

    const uri = editor.document.uri.toString();
    const state = inlinePreviewStates.get(uri);
    if (!state) {
        showInlinePreview();
        return;
    }

    const blocks = extractPreviewBlocks(editor.document.getText());
    if (!blocks.length) {
        clearInlinePreview(editor.document.uri);
        vscode.window.showInformationMessage('Preview not available');
        return;
    }

    state.blocks = blocks;
    if (typeof args !== 'undefined' && typeof args.index === 'number') {
        const block = findBlock(state.blocks, args.index);
        if (!block) {
            return;
        }
        const maxCertificates = getInlineMaxCertificates();
        if (block.index >= maxCertificates && !state.expanded.has(block.index)) {
            return;
        }
        state.renderedPreviews.set(block.index, renderInlinePreview(block));
    } else {
        state.renderedPreviews.clear();
        const maxCertificates = getInlineMaxCertificates();
        state.blocks.forEach(block => {
            if (block.index < maxCertificates || state.expanded.has(block.index)) {
                state.renderedPreviews.set(block.index, renderInlinePreview(block));
            }
        });
    }

    inlineCodeLensEmitter.fire();
}

function expandInlinePreview(args?: PreviewCommandArgs) {
    const editor = getTargetEditor(args);
    if (!editor || typeof args === 'undefined' || typeof args.index !== 'number') {
        return;
    }

    const blocks = extractPreviewBlocks(editor.document.getText());
    if (!blocks.length) {
        clearInlinePreview(editor.document.uri);
        return;
    }

    const state = getOrCreateInlineState(editor.document.uri.toString(), blocks);
    state.blocks = blocks;
    state.expanded.add(args.index);
    const block = findBlock(blocks, args.index);
    if (!block) {
        return;
    }

    state.renderedPreviews.set(block.index, renderInlinePreview(block));
    inlineCodeLensEmitter.fire();
}

function openInlinePreview(args?: PreviewCommandArgs) {
    const editor = getTargetEditor(args);
    if (!editor || typeof args === 'undefined' || typeof args.index !== 'number') {
        return;
    }

    const state = inlinePreviewStates.get(editor.document.uri.toString());
    if (!state) {
        return;
    }

    const parsedPreview = state.renderedPreviews.get(args.index);
    if (!parsedPreview) {
        return;
    }

    provider.setContent(inlineDetailPreviewUri, parsedPreview.fullText);
    vscode.workspace.openTextDocument(inlineDetailPreviewUri).then(doc => {
        vscode.window.showTextDocument(doc, {
            preserveFocus: true,
            preview: false,
            viewColumn: vscode.ViewColumn.Two
        });
    }, (reason) => {
        vscode.window.showErrorMessage(reason);
    });
}

function isInlineCodeLensEnabled(): boolean {
    const configured = vscode.workspace.getConfiguration('opensslutils').get('preview.codeLensEnabled');
    if (typeof configured === 'boolean') {
        return configured;
    }
    return true;
}

function getInlineMaxCertificates(): number {
    const configured = vscode.workspace.getConfiguration('opensslutils').get('preview.maxCertificates');
    if (typeof configured === 'number' && configured > 0) {
        return configured;
    }
    return 5;
}

function getOrCreateInlineState(uri: string, blocks: PreviewBlock[]): InlinePreviewState {
    let state = inlinePreviewStates.get(uri);
    if (!state) {
        state = {
            blocks: blocks,
            expanded: new Set<number>(),
            renderedPreviews: new Map<number, ParsedInlinePreview>(),
            autoLoaded: new Set<number>()
        };
        inlinePreviewStates.set(uri, state);
    }
    return state;
}

function clearInlinePreview(uri: vscode.Uri) {
    inlinePreviewStates.delete(uri.toString());
    inlineCodeLensEmitter.fire();
}

function getTargetEditor(args?: PreviewCommandArgs): vscode.TextEditor | undefined {
    if (args && args.uri) {
        const match = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === args.uri);
        if (match) {
            return match;
        }
    }
    return vscode.window.activeTextEditor;
}

function findBlock(blocks: PreviewBlock[], index: number): PreviewBlock | undefined {
    return blocks.find(block => block.index === index);
}

function extractPreviewBlocks(text: string): PreviewBlock[] {
    const lines = text.split(/\r?\n/);
    const blocks: PreviewBlock[] = [];
    let currentStart = -1;
    let currentKind: PreviewKind | null = null;

    lines.forEach((line, lineIndex) => {
        const trimmed = line.trim();
        if (currentKind === null) {
            if (trimmed === '-----BEGIN CERTIFICATE-----') {
                currentKind = 'certificate';
                currentStart = lineIndex;
            } else if (trimmed === '-----BEGIN CERTIFICATE REQUEST-----' || trimmed === '-----BEGIN NEW CERTIFICATE REQUEST-----') {
                currentKind = 'csr';
                currentStart = lineIndex;
            }
            return;
        }

        const isCertificateEnd = currentKind === 'certificate' && trimmed === '-----END CERTIFICATE-----';
        const isCsrEnd = currentKind === 'csr' && (trimmed === '-----END CERTIFICATE REQUEST-----' || trimmed === '-----END NEW CERTIFICATE REQUEST-----');
        if (!isCertificateEnd && !isCsrEnd) {
            return;
        }

        blocks.push({
            index: blocks.length,
            startLine: currentStart,
            endLine: lineIndex,
            text: lines.slice(currentStart, lineIndex + 1).join('\n') + '\n',
            kind: currentKind
        });
        currentStart = -1;
        currentKind = null;
    });

    return blocks;
}

function renderInlinePreview(block: PreviewBlock): ParsedInlinePreview {
    try {
        const parsed = block.kind === 'certificate' ? provider.parsePemText(block.text) : provider.parseCsrText(block.text);
        return {
            fullText: parsed,
            summaryText: summarizeInlinePreview(parsed, block.kind)
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to parse OpenSSL preview';
        return {
            fullText: `OpenSSL Preview Error\n${message}\n`,
            summaryText: 'OpenSSL Preview Error'
        };
    }
}

function maybeAutoLoadVisibleBlocks(editor: vscode.TextEditor, state: InlinePreviewState) {
    if (!shouldAutoLoadInline(editor, state)) {
        return;
    }

    const visibleRanges = editor.visibleRanges;
    if (!visibleRanges.length) {
        return;
    }

    const maxAutoLoadCertificates = getInlineMaxAutoLoadCertificates();
    let autoLoadedCount = state.autoLoaded.size;
    state.blocks.forEach(block => {
        if (autoLoadedCount >= maxAutoLoadCertificates) {
            return;
        }
        if (block.index >= getInlineMaxCertificates() && !state.expanded.has(block.index)) {
            return;
        }
        if (state.renderedPreviews.has(block.index) || state.autoLoaded.has(block.index)) {
            return;
        }
        if (!isBlockVisible(block, visibleRanges)) {
            return;
        }

        state.renderedPreviews.set(block.index, renderInlinePreview(block));
        state.autoLoaded.add(block.index);
        autoLoadedCount += 1;
    });
}

function shouldAutoLoadInline(editor: vscode.TextEditor, state: InlinePreviewState): boolean {
    if (!isInlineCodeLensEnabled()) {
        return false;
    }

    const configured = vscode.workspace.getConfiguration('opensslutils').get('preview.autoLoadInline');
    const autoLoadInline = typeof configured === 'boolean' ? configured : true;
    if (!autoLoadInline) {
        return false;
    }

    if (state.blocks.length > getInlineMaxAutoLoadCertificates()) {
        return false;
    }

    const maxBytes = getInlineMaxAutoLoadBytes();
    if (editor.document.getText().length > maxBytes) {
        return false;
    }

    return true;
}

function isBlockVisible(block: PreviewBlock, visibleRanges: readonly vscode.Range[]): boolean {
    return visibleRanges.some(range => block.startLine <= range.end.line && block.endLine >= range.start.line);
}

function getInlineMaxAutoLoadCertificates(): number {
    const configured = vscode.workspace.getConfiguration('opensslutils').get('preview.maxAutoLoadCertificates');
    if (typeof configured === 'number' && configured > 0) {
        return configured;
    }
    return 3;
}

function getInlineMaxAutoLoadBytes(): number {
    const configured = vscode.workspace.getConfiguration('opensslutils').get('preview.maxAutoLoadBytes');
    if (typeof configured === 'number' && configured > 0) {
        return configured;
    }
    return 131072;
}

function summarizeInlinePreview(text: string, kind: PreviewKind): string {
    const subject = matchPreviewField(text, 'Subject:') || 'unknown subject';
    const issuer = matchPreviewField(text, 'Issuer:') || 'unknown issuer';
    const notAfter = matchPreviewField(text, 'Not After :') || matchPreviewField(text, 'Not After:') || 'unknown expiry';
    const label = kind === 'certificate' ? 'Certificate' : 'CSR';

    if (kind === 'csr') {
        return `${label}: ${truncateSummary(subject)}`;
    }

    return `${label}: ${truncateSummary(subject)} | Issuer: ${truncateSummary(issuer)} | Expires: ${truncateSummary(notAfter)}`;
}

function matchPreviewField(text: string, field: string): string | undefined {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`^\\s*${escaped}\\s*(.+)$`, 'm'));
    if (!match) {
        return undefined;
    }
    return match[1].trim();
}

function truncateSummary(text: string): string {
    if (text.length <= 60) {
        return text;
    }
    return `${text.slice(0, 57)}...`;
}

const preview = {
    command: showOpenSSLPreview,
    refreshInlineCommand: refreshInlinePreview,
    expandInlineCommand: expandInlinePreview,
    openInlineCommand: openInlinePreview,
    disposable: vscode.Disposable.from(
        vscode.workspace.registerTextDocumentContentProvider('openssl-preview', provider),
        vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'untitled' }], inlineCodeLensProvider)
    )
};

setTimeout(() => {
    if (vscode.window.activeTextEditor && isInlineCodeLensEnabled()) {
        maybeAutoShowInlinePreview(vscode.window.activeTextEditor);
    }
}, 0);

export default preview;
