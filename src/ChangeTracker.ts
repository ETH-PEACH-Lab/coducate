import * as vscode from "vscode";
import * as Y from "yjs";
import { showTmpNotification } from "./tmpNotifications";

/**
 * Tracks changes made by web clients vs instructor.
 * Stores snapshots of the "last known good state" (last accepted version).
 * Uses CodeLens in diff view for accept/rollback actions.
 */
export class ChangeTracker {
    private instructorSnapshots: Map<string, string> = new Map();
    private filesWithChanges: Set<string> = new Set();
    private statusBarItem: vscode.StatusBarItem;
    private context: vscode.ExtensionContext;
    private roomId: string;
    private openDiffEditors: Map<string, vscode.TextDocument> = new Map(); // Instructor snapshots
    private registeredCodeLensDocs: Set<string> = new Set();
    private codeLensDisposables: Map<string, vscode.Disposable> = new Map();
    private disposables: vscode.Disposable[] = [];
    private getFileUriCallback?: (relativePath: string) => Promise<vscode.Uri | null>;

    public readonly ready: Promise<void>;

    constructor(
        context: vscode.ExtensionContext,
        roomId: string,
        statusBarItem: vscode.StatusBarItem
    ) {
        this.context = context;
        this.roomId = roomId;
        this.statusBarItem = statusBarItem;

        this.ready = this.loadState().then(() => this.updateStatusBar());
        this.registerCommands();
    }

    public setGetFileUri(callback: (relativePath: string) => Promise<vscode.Uri | null>) {
        this.getFileUriCallback = callback;
    }

    private registerCommands() {
        const acceptCommand = vscode.commands.registerCommand(
            "coducate.acceptCurrentVersion",
            (relativePath: string) => this.acceptCurrentVersion(relativePath)
        );

        const rollbackCommand = vscode.commands.registerCommand(
            "coducate.rollbackChanges",
            (relativePath: string) => this.rollbackChanges(relativePath)
        );

        this.disposables.push(acceptCommand, rollbackCommand);
        this.context.subscriptions.push(acceptCommand, rollbackCommand);
    }

    /**
     * Only update snapshot if no changes are pending
     */
    public recordInstructorEdit(relativePath: string, content: string) {
        if (!this.filesWithChanges.has(relativePath)) {
            this.instructorSnapshots.set(relativePath, content);
            this.saveState();
        }
    }

    /**
     * Force update after accept/rollback
     */
    public forceUpdateInstructorSnapshot(relativePath: string, content: string) {
        this.instructorSnapshots.set(relativePath, content);
        this.filesWithChanges.delete(relativePath);
        this.saveState();
        this.updateStatusBar();
    }

    public recordChange(relativePath: string, currentContent?: string) {
        const snapshot = this.instructorSnapshots.get(relativePath);
        if (snapshot === undefined) {
            return;
        }

        // If current content matches the snapshot, remove from changes
        if (currentContent !== undefined && currentContent === snapshot) {
            if (this.filesWithChanges.has(relativePath)) {
                this.filesWithChanges.delete(relativePath);
                this.saveState();
                this.updateStatusBar();
            }
            return;
        }

        this.filesWithChanges.add(relativePath);
        this.saveState();
        this.updateStatusBar();
    }

    /**
     * Shows diff between instructor snapshot and current version
     */
    public async showDiff(relativePath: string) {
        const instructorSnapshot = this.instructorSnapshots.get(relativePath);
        if (!instructorSnapshot) {
            vscode.window.showErrorMessage("No instructor snapshot found.");
            return;
        }

        // Get the actual file URI
        if (!this.getFileUriCallback) {
            vscode.window.showErrorMessage("File URI resolver not set.");
            return;
        }

        const fileUri = await this.getFileUriCallback(relativePath);
        if (!fileUri) {
            vscode.window.showErrorMessage("Could not find file.");
            return;
        }

        // Open the existing document (current version)
        const originalDocument = await vscode.workspace.openTextDocument(fileUri);

        const fileName = relativePath.split('/').pop() || relativePath;

        // Create or reuse instructor snapshot document (untitled)
        let instructorDoc = this.openDiffEditors.get(relativePath);
        if (!instructorDoc || !vscode.workspace.textDocuments.includes(instructorDoc)) {
            instructorDoc = await vscode.workspace.openTextDocument({
                content: instructorSnapshot
            });
            this.openDiffEditors.set(relativePath, instructorDoc);

            // Set the language AFTER creation to match the original document
            await vscode.languages.setTextDocumentLanguage(
                instructorDoc,
                originalDocument.languageId
            );
        }

        const diffTitle = `${fileName}: Current Version ↔ Rollback Version`;
        
        await vscode.commands.executeCommand(
            "vscode.diff",
            fileUri,                // Left: current file
            instructorDoc.uri,      // Right: instructor snapshot (used for rollback)
            diffTitle
        );

        this.addCodeLensToDiffEditor(relativePath, instructorDoc);
    }

    private addCodeLensToDiffEditor(relativePath: string, diffDoc: vscode.TextDocument) {
        const docUriString = diffDoc.uri.toString();
        
        if (this.registeredCodeLensDocs.has(docUriString)) {
            this.removeCodeLensForDocument(docUriString);
        }

        const provider: vscode.CodeLensProvider = {
            provideCodeLenses: async (document: vscode.TextDocument) => {
                if (document.uri.toString() !== diffDoc.uri.toString()) {
                    return [];
                }

                return [
                    new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                        title: "✓ Accept Current Version (left)",
                        command: "coducate.acceptCurrentVersion",
                        arguments: [relativePath],
                    }),
                    new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                        title: "✘ Restore Rollback Version (right)",
                        command: "coducate.rollbackChanges",
                        arguments: [relativePath],
                    }),
                ];
            },
        };

        const providerDisposable = vscode.languages.registerCodeLensProvider(
            { pattern: "**", scheme: diffDoc.uri.scheme },
            provider
        );

        this.codeLensDisposables.set(docUriString, providerDisposable);
        this.registeredCodeLensDocs.add(docUriString);
        this.disposables.push(providerDisposable);
        this.context.subscriptions.push(providerDisposable);
    }

    private removeCodeLensForDocument(docUriString: string) {
        this.registeredCodeLensDocs.delete(docUriString);
        
        const disposable = this.codeLensDisposables.get(docUriString);
        if (disposable) {
            disposable.dispose();
            this.codeLensDisposables.delete(docUriString);
        }
    }

    public getFilesWithChanges(): string[] {
        return Array.from(this.filesWithChanges);
    }

    public getInstructorSnapshot(relativePath: string): string | undefined {
        return this.instructorSnapshots.get(relativePath);
    }

    public hasChanges(relativePath: string): boolean {
        return this.filesWithChanges.has(relativePath);
    }

    public async acceptCurrentVersion(relativePath: string) {
        if (this.onAcceptCallback) {
            await this.onAcceptCallback(relativePath);
        }

        await this.closeDiffEditor(relativePath);
        showTmpNotification(`Accepted changes in ${relativePath}`);
    }

    public async rollbackChanges(relativePath: string) {
        if (this.onRollbackCallback) {
            await this.onRollbackCallback(relativePath);
        }

        await this.closeDiffEditor(relativePath);
        showTmpNotification(`Reverted ${relativePath} to instructor version`);
    }

    /**
     * Close the diff editor and clean up the temporary instructor snapshot document
     */
    private async closeDiffEditor(relativePath: string) {
        const instructorDoc = this.openDiffEditors.get(relativePath);

        // Remove CodeLens for instructor doc
        if (instructorDoc) {
            const docUriString = instructorDoc.uri.toString();
            this.removeCodeLensForDocument(docUriString);
        }

        // Close the diff editor without saving
        await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");

        // Clean up our tracking
        this.openDiffEditors.delete(relativePath);
    }

    private onAcceptCallback?: (relativePath: string) => Promise<void>;
    private onRollbackCallback?: (relativePath: string) => Promise<void>;

    public setOnAccept(callback: (relativePath: string) => Promise<void>) {
        this.onAcceptCallback = callback;
    }

    public setOnRollback(callback: (relativePath: string) => Promise<void>) {
        this.onRollbackCallback = callback;
    }

    public removeFile(relativePath: string) {
        this.instructorSnapshots.delete(relativePath);
        this.filesWithChanges.delete(relativePath);
        
        const instructorDoc = this.openDiffEditors.get(relativePath);
        if (instructorDoc) {
            this.removeCodeLensForDocument(instructorDoc.uri.toString());
            this.openDiffEditors.delete(relativePath);
        }
        
        this.saveState();
        this.updateStatusBar();
    }

    public renameFile(oldPath: string, newPath: string) {
        const snapshot = this.instructorSnapshots.get(oldPath);
        if (snapshot) {
            this.instructorSnapshots.delete(oldPath);
            this.instructorSnapshots.set(newPath, snapshot);
        }

        if (this.filesWithChanges.has(oldPath)) {
            this.filesWithChanges.delete(oldPath);
            this.filesWithChanges.add(newPath);
        }

        const instructorDoc = this.openDiffEditors.get(oldPath);
        if (instructorDoc) {
            this.removeCodeLensForDocument(instructorDoc.uri.toString());
            this.openDiffEditors.delete(oldPath);
        }

        this.saveState();
    }

    private updateStatusBar() {
        const count = this.filesWithChanges.size;
        
        if (count > 0) {
            this.statusBarItem.text = `$(warning) ${count} Change${count > 1 ? 's' : ''}`;
            this.statusBarItem.tooltip = `${count} file${count > 1 ? 's have' : ' has'} changes. Click to review.`;
            this.statusBarItem.command = "coducate.reviewChanges";
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
    }

    private saveState() {
        const dir = this.context.globalStorageUri;
        const fileUri = vscode.Uri.joinPath(dir, `changeTracker-${this.roomId}.json`);
        const data = {
            instructorSnapshots: Array.from(this.instructorSnapshots.entries()),
            filesWithChanges: Array.from(this.filesWithChanges)
        };
        vscode.workspace.fs.createDirectory(dir).then(() =>
            vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(data), "utf8"))
        );
    }

    private async loadState() {
        const dir = this.context.globalStorageUri;
        const fileUri = vscode.Uri.joinPath(dir, `changeTracker-${this.roomId}.json`);
        try {
            const raw = await vscode.workspace.fs.readFile(fileUri);
            const saved = JSON.parse(Buffer.from(raw).toString("utf8"));
            if (saved) {
                this.instructorSnapshots = new Map(saved.instructorSnapshots);
                this.filesWithChanges = new Set(saved.filesWithChanges);
            }
        } catch {
            // No saved state
        }
    }

    public clear() {
        this.instructorSnapshots.clear();
        this.filesWithChanges.clear();
        
        for (const [_, instructorDoc] of this.openDiffEditors) {
            this.removeCodeLensForDocument(instructorDoc.uri.toString());
        }
        this.openDiffEditors.clear();
        
        this.saveState();
        this.updateStatusBar();
    }

    public dispose() {
        for (const disposable of this.codeLensDisposables.values()) {
            disposable.dispose();
        }
        this.codeLensDisposables.clear();
        this.registeredCodeLensDocs.clear();

        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];

        this.statusBarItem.dispose();
    }
}
