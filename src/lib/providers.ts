import openssl from './openssl';
import * as vscode from 'vscode';


export class OpenSSLTextDocumentContentProvider implements vscode.TextDocumentContentProvider {
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
        private overrides = new Map<string, string>();

		public provideTextDocumentContent(uri: vscode.Uri): string {
            const override = this.overrides.get(uri.toString());
            if (typeof override === 'string') {
                return override;
            }
            return this.processDocument();
            
		}

		get onDidChange(): vscode.Event<vscode.Uri> {
			return this._onDidChange.event;
		}

		public update(uri: vscode.Uri) {
			this._onDidChange.fire(uri);
		}

        public setContent(uri: vscode.Uri, content: string) {
            this.overrides.set(uri.toString(), content);
            this.update(uri);
        }

        public clearContent(uri: vscode.Uri) {
            this.overrides.delete(uri.toString());
            this.update(uri);
        }

        private processDocument(): string {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return 'no editor';
            }
            const text = editor.document.getText().trim();
            if (text.startsWith('-----BEGIN CERTIFICATE-----')) {
                return this.parsePemText(text);
            } else if (text.startsWith('-----BEGIN CERTIFICATE REQUEST-----') || text.startsWith('-----BEGIN NEW CERTIFICATE REQUEST-----')) {
                return this.parseCsrText(text);			
			}
            return 'Preview not available';
        }

        public parsePemText(text: string): string {
            return openssl.parsePem(text);
        }

        public parseCsrText(text: string): string {
            return openssl.parseCsr(text);
        }
	}
