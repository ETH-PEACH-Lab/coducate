import * as vscode from "vscode";
import * as Y from "yjs";

/**
 * Bidirectional binding between a VS Code TextDocument and a Y.Text object.
 * This ensures perfect synchronization while tracking changes from different sources.
 */
export class YTextVSCodeBinding {
    private disposables: vscode.Disposable[] = [];
    private isUpdatingFromYjs = false;
    private isUpdatingFromVSCode = false;
    private yTextObserver: ((event: Y.YTextEvent) => void) | null = null;
    private onClientChangeCallback: ((relativePath: string) => void) | null = null;

    constructor(
        private ytext: Y.Text,
        private document: vscode.TextDocument,
        private relativePath: string,
        onClientChange?: (relativePath: string) => void
    ) {
        this.onClientChangeCallback = onClientChange || null;
        this.setupBindings();
    }

    /**
     * Set up bidirectional synchronization between Y.Text and VS Code document
     */
    private setupBindings() {
        // Y.Text -> VS Code: Listen to remote changes
        this.yTextObserver = (event: Y.YTextEvent) => {
            // Ignore updates that originated from this VS Code instance (instructor)
            if (this.isUpdatingFromVSCode || event.transaction.origin === 'vscode-instructor') {
                return;
            }

            // This is a change from a web client
            this.isUpdatingFromYjs = true;
            this.applyYTextChangesToVSCode(event);
            
            // Notify that a web client made a change
            if (this.onClientChangeCallback && event.transaction.origin !== 'vscode-instructor') {
                this.onClientChangeCallback(this.relativePath);
            }
        };

        this.ytext.observe(this.yTextObserver);

        // VS Code -> Y.Text: Listen to local document changes (instructor edits)
        const changeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document !== this.document || this.isUpdatingFromYjs) {
                return;
            }

            this.isUpdatingFromVSCode = true;
            this.applyVSCodeChangesToYText(event.contentChanges);
            this.isUpdatingFromVSCode = false;
        });

        this.disposables.push(changeDisposable);
    }

    /**
     * Apply Y.Text changes to the VS Code document
     */
    private async applyYTextChangesToVSCode(event: Y.YTextEvent) {
        try {
            const editor = vscode.window.visibleTextEditors.find(
                (e) => e.document === this.document
            );

            if (!editor) {
                // Document is not currently visible
                this.isUpdatingFromYjs = false;
                return;
            }

            // Calculate the changes from the Y.Text delta
            const success = await editor.edit(
                (editBuilder) => {
                    let index = 0;

                    event.delta.forEach((op) => {
                        if (op.retain !== undefined) {
                            index += op.retain;
                        } else if (op.insert !== undefined) {
                            const insertText = typeof op.insert === 'string' ? op.insert : '';
                            const position = this.document.positionAt(index);
                            editBuilder.insert(position, insertText);
                            index += insertText.length;
                        } else if (op.delete !== undefined) {
                            const startPos = this.document.positionAt(index);
                            const endPos = this.document.positionAt(index + op.delete);
                            editBuilder.delete(new vscode.Range(startPos, endPos));
                        }
                    });
                },
                {
                    undoStopBefore: false,
                    undoStopAfter: false,
                }
            );

            if (!success) {
                console.error(`Failed to apply Y.Text changes to VS Code for ${this.relativePath}`);
            }
        } catch (error) {
            console.error(`Error applying Y.Text changes to VS Code for ${this.relativePath}:`, error);
        } finally {
            this.isUpdatingFromYjs = false;
        }
    }

    /**
     * Apply VS Code document changes to Y.Text (instructor edits)
     */
    private applyVSCodeChangesToYText(contentChanges: readonly vscode.TextDocumentContentChangeEvent[]) {
        try {
            // Apply changes within a Y.js transaction with 'vscode-instructor' origin
            this.ytext.doc?.transact(() => {
                contentChanges.forEach((change) => {
                    const start = change.rangeOffset;
                    const length = change.rangeLength;

                    if (length > 0) {
                        this.ytext.delete(start, length);
                    }

                    if (change.text.length > 0) {
                        this.ytext.insert(start, change.text);
                    }
                });
            }, 'vscode-instructor'); // Mark as instructor change
        } catch (error) {
            console.error(`Error applying VS Code changes to Y.Text for ${this.relativePath}:`, error);
        }
    }

    /**
     * Synchronize the current state: update VS Code from Y.Text
     */
    public async syncFromYText() {
        if (this.isUpdatingFromVSCode || this.isUpdatingFromYjs) {
            return;
        }

        const ytextContent = this.ytext.toString();
        const vscodeContent = this.document.getText();

        if (ytextContent !== vscodeContent) {
            this.isUpdatingFromYjs = true;
            
            try {
                const editor = vscode.window.visibleTextEditors.find(
                    (e) => e.document === this.document
                );

                if (editor) {
                    const fullRange = new vscode.Range(
                        this.document.positionAt(0),
                        this.document.positionAt(vscodeContent.length)
                    );

                    await editor.edit(
                        (editBuilder) => {
                            editBuilder.replace(fullRange, ytextContent);
                        },
                        {
                            undoStopBefore: false,
                            undoStopAfter: false,
                        }
                    );
                }
            } finally {
                this.isUpdatingFromYjs = false;
            }
        }
    }

    /**
     * Get a snapshot of the current Y.Text content
     */
    public getYTextSnapshot(): string {
        return this.ytext.toString();
    }

    /**
     * Get the current VS Code document content
     */
    public getVSCodeContent(): string {
        return this.document.getText();
    }

    /**
     * Check if the binding is currently in sync
     */
    public isInSync(): boolean {
        return this.ytext.toString() === this.document.getText();
    }

    /**
     * Get the relative path of the bound document
     */
    public getRelativePath(): string {
        return this.relativePath;
    }

    /**
     * Get the VS Code document
     */
    public getDocument(): vscode.TextDocument {
        return this.document;
    }

    /**
     * Clean up the binding
     */
    public dispose() {
        if (this.yTextObserver) {
            this.ytext.unobserve(this.yTextObserver);
            this.yTextObserver = null;
        }
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
    }
}
