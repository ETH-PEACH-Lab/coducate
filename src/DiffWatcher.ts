import * as vscode from "vscode";
import * as Y from "yjs";

export class DiffWatcher {
    private fileYMap: Y.Map<Y.Text>;
    private diffButton: vscode.StatusBarItem;
    private diffFilesSet: Set<string> = new Set();
    private openDiffEditors: Map<string, vscode.TextDocument> = new Map(); // Tracks open diff editors
    private registeredCodeLensDocs: Set<string> = new Set(); // Tracks documents with registered CodeLens providers
    private context: vscode.ExtensionContext;
    private roomId: string;

    private disposables: vscode.Disposable[] = [];

    constructor(
        fileYMap: Y.Map<Y.Text>,
        context: vscode.ExtensionContext,
        roomId: string
    ) {
        this.fileYMap = fileYMap;
        this.context = context;
        this.roomId = roomId;

        // Create a status bar button for showing diffs
        this.diffButton = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            99
        );
        this.diffButton.text = `Show Diff`;
        this.diffButton.command = "coducate.showDiffFiles";
        this.diffButton.tooltip = "Show files with differences";
        this.diffButton.hide();

        // Load persisted files with differences
        this.loadDiffFiles();

        // Register the commands
        const showDiffFilesCommand = vscode.commands.registerCommand(
            "coducate.showDiffFiles",
            this.showDiffFiles.bind(this)
        );
        const acceptDiffCommand = vscode.commands.registerCommand(
            "coducate.acceptDiff",
            this.acceptDiff.bind(this)
        );
        const rejectDiffCommand = vscode.commands.registerCommand(
            "coducate.rejectDiff",
            this.rejectDiff.bind(this)
        );

        // Track disposables for cleanup in the dispose method
        this.disposables.push(this.diffButton);
        this.disposables.push(showDiffFilesCommand);
        this.disposables.push(acceptDiffCommand);
        this.disposables.push(rejectDiffCommand);

        context.subscriptions.push(...this.disposables);

        // Observe changes in Y.Text objects
        this.observeYMapChanges();
    }

    private observeYMapChanges() {
        this.fileYMap.observeDeep(async (events) => {
            for (const event of events) {
                if (event.target instanceof Y.Text) {
                    const relativePath = event.path[0] as string;
                    const yText = event.target;

                    const document = await this.getDocument(relativePath);
                    if (!document) {
                        continue;
                    }

                    const fileContent = document.getText();
                    const yTextContent = yText.toString();

                    if (fileContent !== yTextContent) {
                        this.diffFilesSet.add(relativePath);
                        this.refreshOpenDiffEditor(relativePath);
                    } else {
                        this.diffFilesSet.delete(relativePath);
                    }

                    this.updateDiffButtonVisibility();
                    this.saveDiffFiles();
                }
            }
        });
    }

    private async showDiffFiles() {
        const files = Array.from(this.diffFilesSet);
        if (files.length === 0) {
            vscode.window.showInformationMessage("No differences found.");
            return;
        }

        const selectedFile = await vscode.window.showQuickPick(files, {
            placeHolder: "Select a file to view the diff",
        });

        if (selectedFile) {
            this.openDiffEditor(selectedFile);
        }
    }

    private async openDiffEditor(relativePath: string) {
        const yText = this.fileYMap.get(relativePath);
        if (!yText) {
            return;
        }

        const yTextContent = yText.toString();
        const fileUri = await this.getFileUri(relativePath);
        if (!fileUri) {
            return;
        }

        // Open the existing document
        const originalDocument = await vscode.workspace.openTextDocument(
            fileUri
        );

        // Create or reuse a temporary document with the Y.Text content
        let yTextDocument = this.openDiffEditors.get(relativePath);
        if (!yTextDocument) {
            yTextDocument = await vscode.workspace.openTextDocument({
                content: yTextContent,
            });

            // Track this open diff editor
            this.openDiffEditors.set(relativePath, yTextDocument);

            // Set the language of the temporary document to match the original document
            await vscode.languages.setTextDocumentLanguage(
                yTextDocument,
                originalDocument.languageId
            );
        } else {
            // Refresh the content of the existing diff editor
            await this.refreshOpenDiffEditor(relativePath);
        }

        const diffEditorTitle = `VS Code ↔ Client Diff: ${relativePath}`;
        await vscode.commands.executeCommand(
            "vscode.diff",
            fileUri,
            yTextDocument.uri,
            diffEditorTitle
        );

        this.addCodeLensToDiffEditor(relativePath);
    }

    private addCodeLensToDiffEditor(relativePath: string) {
        const diffDoc = this.openDiffEditors.get(relativePath);
        if (!diffDoc) {
            // console.error(
            //     `No open modified document found for ${relativePath}`
            // );
            return;
        }

        // Check if CodeLens is already added for this document
        const docUriString = diffDoc.uri.toString();
        if (this.registeredCodeLensDocs.has(docUriString)) {
            return;
        }

        const provider: vscode.CodeLensProvider = {
            provideCodeLenses: async (document: vscode.TextDocument) => {
                if (document.uri.toString() !== diffDoc.uri.toString()) {
                    return [];
                }

                // Provide CodeLens options
                return [
                    new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                        title: "✔ Accept Changes",
                        command: "coducate.acceptDiff",
                        arguments: [relativePath],
                    }),
                    new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                        title: "✘ Reject Changes",
                        command: "coducate.rejectDiff",
                        arguments: [relativePath],
                    }),
                ];
            },
        };

        // Use an explicit glob pattern to match files correctly
        const providerDisposable = vscode.languages.registerCodeLensProvider(
            { pattern: "**", scheme: diffDoc.uri.scheme },
            provider
        );

        // Mark the document as registered
        this.registeredCodeLensDocs.add(docUriString);

        this.disposables.push(providerDisposable);
        this.context.subscriptions.push(providerDisposable);
    }

    private async removeDocumentFromTracking(relativePath: string) {
        const diffDoc = this.openDiffEditors.get(relativePath);
        if (diffDoc) {
            this.registeredCodeLensDocs.delete(diffDoc.uri.toString());
            this.openDiffEditors.delete(relativePath);
        }
    }

    private async refreshOpenDiffEditor(relativePath: string) {
        const yText = this.fileYMap.get(relativePath);
        const yTextDocument = this.openDiffEditors.get(relativePath);

        if (yText && yTextDocument) {
            const yTextContent = yText.toString();
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                yTextDocument.uri,
                new vscode.Range(0, 0, yTextDocument.lineCount, 0),
                yTextContent
            );
            await vscode.workspace.applyEdit(edit);
        }
    }

    private async acceptDiff(relativePath: string) {
        const yText = this.fileYMap.get(relativePath);
        if (!yText) {
            return;
        }

        const fileUri = await this.getFileUri(relativePath);
        if (!fileUri) {
            return;
        }

        const document = await vscode.workspace.openTextDocument(fileUri);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            fileUri,
            new vscode.Range(0, 0, document.lineCount, 0),
            yText.toString()
        );
        await vscode.workspace.applyEdit(edit);

        // Automatically save the document after applying the changes
        await document.save();

        vscode.window.showInformationMessage(
            `Accepted changes for ${relativePath}`
        );

        // Remove the file from the diff set and save state
        this.diffFilesSet.delete(relativePath);
        this.openDiffEditors.delete(relativePath);
        this.updateDiffButtonVisibility();
        this.saveDiffFiles();
        await this.removeDocumentFromTracking(relativePath);

        // Close the diff editor without saving
        await vscode.commands.executeCommand(
            "workbench.action.revertAndCloseActiveEditor"
        );
    }

    private async rejectDiff(relativePath: string) {
        const yText = this.fileYMap.get(relativePath);
        if (!yText) {
            return;
        }

        const document = await this.getDocument(relativePath);
        if (!document) {
            return;
        }

        yText.delete(0, yText.length);
        yText.insert(0, document.getText());

        vscode.window.showInformationMessage(
            `Rejected changes for ${relativePath}`
        );

        // Remove the file from the diff set and save state
        this.diffFilesSet.delete(relativePath);
        this.openDiffEditors.delete(relativePath);
        this.updateDiffButtonVisibility();
        this.saveDiffFiles();
        await this.removeDocumentFromTracking(relativePath);

        // Close the diff editor without saving
        await vscode.commands.executeCommand(
            "workbench.action.revertAndCloseActiveEditor"
        );
    }

    private updateDiffButtonVisibility() {
        const diffCount = this.diffFilesSet.size;

        if (diffCount > 0) {
            // Update the button text to show the number of changed files
            this.diffButton.text = `Show Diff (${diffCount})`;
            this.diffButton.show();
        } else {
            this.diffButton.hide();
        }
    }

    // Save the set of files with differences to workspaceState, scoped by roomId
    private saveDiffFiles() {
        const key = `diffFilesSet-${this.roomId}`;
        this.context.workspaceState.update(key, Array.from(this.diffFilesSet));
    }

    // Load the set of files with differences from workspaceState, scoped by roomId
    private loadDiffFiles() {
        const key = `diffFilesSet-${this.roomId}`;
        const savedFiles = this.context.workspaceState.get<string[]>(key, []);
        this.diffFilesSet = new Set(savedFiles);
        this.updateDiffButtonVisibility();
    }

    private async getDocument(
        relativePath: string
    ): Promise<vscode.TextDocument | null> {
        const fileUri = await this.getFileUri(relativePath);
        if (!fileUri) {
            return null;
        }

        try {
            return await vscode.workspace.openTextDocument(fileUri);
        } catch (error) {
            // console.error("Error opening document:", error);
            return null;
        }
    }

    private async getFileUri(relativePath: string): Promise<vscode.Uri | null> {
        const slashIndex = relativePath.indexOf("/");
        if (slashIndex === -1) {
            return null;
        }

        const workspaceFolderName = relativePath.substring(0, slashIndex);
        const filePath = relativePath.substring(slashIndex + 1);

        for (const folder of vscode.workspace.workspaceFolders || []) {
            if (folder.name === workspaceFolderName) {
                const fileUri = vscode.Uri.joinPath(folder.uri, filePath);
                try {
                    await vscode.workspace.fs.stat(fileUri);
                    return fileUri;
                } catch (error) {
                    continue;
                }
            }
        }
        return null;
    }

    dispose() {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }
}
