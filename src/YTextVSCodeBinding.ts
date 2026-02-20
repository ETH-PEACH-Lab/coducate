import * as vscode from "vscode";
import * as Y from "yjs";

/**
 * Bidirectional binding between a VS Code TextDocument and a Y.Text object.
 *
 * Design:
 * - Remote Y.Text changes are debounced and applied as a single atomic
 *   full-content replacement after a short quiet period (100ms). This avoids
 *   broken intermediate states from incremental deltas with stale offsets.
 * - Echo-back prevention uses TWO layers:
 *   1. `isApplyingRemote` flag: set while we're applying a remote change,
 *      suppresses all onDidChangeTextDocument events.
 *   2. `suppressUpToVersion`: version-based suppression catches any events
 *      that fire after the flag is cleared.
 * - VS Code -> Y.Text (instructor edits) uses incremental operations.
 */
export class YTextVSCodeBinding {
    private disposables: vscode.Disposable[] = [];
    private isUpdatingFromVSCode = false;
    private yTextObserver: ((event: Y.YTextEvent) => void) | null = null;
    private onClientChangeCallback:
        | ((relativePath: string, content: string) => void)
        | null = null;

    // Echo-back suppression
    private isApplyingRemote = false;
    private suppressUpToVersion = -1;

    // Debounce timer for remote changes
    private syncTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly SYNC_DELAY_MS = 100;

    constructor(
        private ytext: Y.Text,
        private document: vscode.TextDocument,
        private relativePath: string,
        onClientChange?: (relativePath: string, content: string) => void
    ) {
        this.onClientChangeCallback = onClientChange || null;
        this.setupBindings();
    }

    private setupBindings() {
        // Y.Text -> VS Code: Listen to remote changes, debounce into a
        // single atomic update
        this.yTextObserver = (event: Y.YTextEvent) => {
            if (
                this.isUpdatingFromVSCode ||
                event.transaction.origin === "vscode-instructor"
            ) {
                return;
            }

            this.scheduleSyncToVSCode();

            if (this.onClientChangeCallback) {
                this.onClientChangeCallback(
                    this.relativePath,
                    this.ytext.toString()
                );
            }
        };

        this.ytext.observe(this.yTextObserver);

        // VS Code -> Y.Text: Listen to local document changes (instructor edits)
        const changeDisposable = vscode.workspace.onDidChangeTextDocument(
            (event) => {
                if (event.document !== this.document) {
                    return;
                }

                // Layer 1: Suppress while applying remote changes.
                if (this.isApplyingRemote) {
                    return;
                }

                // Layer 2: Version-based suppression for late-arriving events.
                if (event.document.version <= this.suppressUpToVersion) {
                    return;
                }

                this.isUpdatingFromVSCode = true;
                this.applyVSCodeChangesToYText(event.contentChanges);
                this.isUpdatingFromVSCode = false;
            }
        );

        this.disposables.push(changeDisposable);
    }

    /**
     * Schedule a debounced sync from Y.Text to VS Code.
     * Each new remote change resets the timer. When typing stops (or pauses
     * for SYNC_DELAY_MS), we apply one atomic full-content replacement.
     */
    private scheduleSyncToVSCode() {
        if (this.syncTimer) {
            clearTimeout(this.syncTimer);
        }

        this.syncTimer = setTimeout(() => {
            this.syncTimer = null;
            this.applyYTextToVSCode();
        }, YTextVSCodeBinding.SYNC_DELAY_MS);
    }

    /**
     * Apply Y.Text content to VS Code as a single atomic replacement.
     * The document jumps from its current state directly to the correct state
     * — no broken intermediate states visible to the user.
     */
    private async applyYTextToVSCode() {
        const ytextContent = this.ytext.toString();
        const vscodeContent = this.document.getText();

        if (ytextContent === vscodeContent) {
            return;
        }

        this.isApplyingRemote = true;

        try {
            const fullRange = new vscode.Range(
                this.document.positionAt(0),
                this.document.positionAt(vscodeContent.length)
            );

            const edit = new vscode.WorkspaceEdit();
            edit.replace(this.document.uri, fullRange, ytextContent);

            this.suppressUpToVersion = this.document.version + 1;
            const success = await vscode.workspace.applyEdit(edit);

            if (!success) {
                console.error(
                    `Failed to sync Y.Text to VS Code for ${this.relativePath}`
                );
            }
        } catch (error) {
            console.error(
                `Error syncing Y.Text to VS Code for ${this.relativePath}:`,
                error
            );
        } finally {
            this.isApplyingRemote = false;
        }
    }

    /**
     * Apply VS Code document changes to Y.Text (instructor edits)
     */
    private applyVSCodeChangesToYText(
        contentChanges: readonly vscode.TextDocumentContentChangeEvent[]
    ) {
        try {
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
            }, "vscode-instructor");
        } catch (error) {
            console.error(
                `Error applying VS Code changes to Y.Text for ${this.relativePath}:`,
                error
            );
        }
    }

    /**
     * Synchronize the current state: update VS Code from Y.Text.
     */
    public async syncFromYText() {
        await this.applyYTextToVSCode();
    }

    public getYTextSnapshot(): string {
        return this.ytext.toString();
    }

    public getVSCodeContent(): string {
        return this.document.getText();
    }

    public isInSync(): boolean {
        return this.ytext.toString() === this.document.getText();
    }

    public getRelativePath(): string {
        return this.relativePath;
    }

    public getDocument(): vscode.TextDocument {
        return this.document;
    }

    public dispose() {
        if (this.syncTimer) {
            clearTimeout(this.syncTimer);
            this.syncTimer = null;
        }
        if (this.yTextObserver) {
            this.ytext.unobserve(this.yTextObserver);
            this.yTextObserver = null;
        }
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
    }
}
