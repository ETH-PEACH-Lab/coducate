import * as vscode from "vscode";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import path from "path";
import * as fs from "fs";
import { Awareness } from "y-protocols/awareness";

const serverWsUrl = "ws://localhost:1234";
let disposableWebSocket: DisposableWebSocket | undefined;
const ROOM_ID_KEY = "coducateRoomId";
const EXCLUDED_DIRECTORIES = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".vscode",
    "coverage",
    "out",
    "tmp",
    "logs",
    ".cache",
]);

class DisposableWebSocket {
    private provider: WebsocketProvider;
    private yDoc: Y.Doc;
    private awareness: Awareness;
    private fileYMap: Y.Map<Y.Text>; // A shared map to store file names and their corresponding Y.Text objects

    constructor(url: string, roomId: string) {
        this.yDoc = new Y.Doc();
        this.provider = new WebsocketProvider(url, roomId, this.yDoc, {
            WebSocketPolyfill: require("ws"),
        });

        // Initialize awareness for the provider
        this.awareness = this.provider.awareness;

        // Initialize the shared file list in the Y.Doc
        this.fileYMap = this.yDoc.getMap("fileYMap");

        // Sync initial files from each workspace folder
        vscode.workspace.workspaceFolders?.forEach((folder) => {
            this.addAllFilesInDirectory(folder.uri.fsPath);
        });

        this.setupVSCodeListeners();
    }

    private getRelativeFilePath(filePath: string): string {
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(
            (folder) => filePath.startsWith(folder.uri.fsPath)
        );

        if (workspaceFolder) {
            const workspaceFolderPath = workspaceFolder.uri.fsPath;
            const relativePath = path.relative(workspaceFolderPath, filePath);
            return `${workspaceFolder.name}/${relativePath}`;
        }

        return filePath; // Return absolute path if file is not within any workspace folder
    }

    private setupVSCodeListeners() {
        // Listen to file renames
        vscode.workspace.onDidRenameFiles(async (event) => {
            for (const { oldUri, newUri } of event.files) {
                const oldFilePath = oldUri.fsPath;
                const newFilePath = newUri.fsPath;
                const oldRelativePath = this.getRelativeFilePath(oldFilePath);
                const newRelativePath = this.getRelativeFilePath(newFilePath);

                // Check if it's a file or a directory
                const fileStat = await vscode.workspace.fs.stat(newUri);
                if (fileStat.type === vscode.FileType.File) {
                    // Rename single file in fileYMap
                    await this.renameFileInYMap(
                        oldRelativePath,
                        newRelativePath
                    );
                } else if (fileStat.type === vscode.FileType.Directory) {
                    // Rename folder and all files within it
                    console.log(
                        `Folder renamed: ${oldRelativePath} -> ${newRelativePath}`
                    );
                    await this.renameAllFilesInDirectory(
                        oldRelativePath,
                        newRelativePath
                    );
                }
            }
        });

        // Listen to workspace folder changes
        vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
            console.log("Workspace folders changed.");

            // Handle added workspace folders
            for (const addedFolder of event.added) {
                const folderPath = addedFolder.uri.fsPath;
                console.log("Workspace folder added: " + folderPath);

                // Add all files in the new folder to fileYMap
                await this.addAllFilesInDirectory(folderPath);
            }

            // Handle removed workspace folders
            for (const removedFolder of event.removed) {
                const folderPath = removedFolder.uri.fsPath;
                console.log("Workspace folder removed: " + folderPath);

                // Remove all files in the folder from fileYMap
                this.removeAllFilesInDirectory(folderPath, removedFolder.name);
            }
        });

        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document === vscode.window.activeTextEditor?.document) {
                this.applyIncrementalChanges(
                    event.document.fileName,
                    event.contentChanges
                );
            }
        });

        // Listen to cursor movement and selection changes
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (event.textEditor === vscode.window.activeTextEditor) {
                const relativeFilePath = this.getRelativeFilePath(
                    event.textEditor.document.fileName
                );
                const position = event.selections[0].active;
                const selection = event.selections[0];
                const clientState = {
                    filePath: relativeFilePath,
                    cursorPosition: {
                        line: position.line,
                        column: position.character,
                    },
                    selectionRange: {
                        start: {
                            line: selection.start.line,
                            column: selection.start.character,
                        },
                        end: {
                            line: selection.end.line,
                            column: selection.end.character,
                        },
                    },
                };
                this.awareness.setLocalStateField("vsCodeClient", clientState);
            }
        });

        // Clean up awareness state when editor is closed or session ends
        vscode.workspace.onDidCloseTextDocument(() => {
            this.awareness.setLocalStateField("vsCodeClient", null);
        });

        // Listen to file creation
        vscode.workspace.onDidCreateFiles(async (event) => {
            for (const file of event.files) {
                const filePath = file.fsPath;
                const relativeFilePath = this.getRelativeFilePath(filePath);

                // Check if it's a file or a directory
                const fileStat = await vscode.workspace.fs.stat(file);
                if (fileStat.type === vscode.FileType.File) {
                    // Add single file to fileYMap
                    await this.addFileToYMap(filePath, relativeFilePath);
                } else if (fileStat.type === vscode.FileType.Directory) {
                    // Folder detected - add all files within this folder to fileYMap
                    console.log(`Folder created: ${relativeFilePath}`);
                    await this.addAllFilesInDirectory(filePath);
                }
            }
        });

        // Listen to file deletion
        vscode.workspace.onDidDeleteFiles(async (event) => {
            for (const file of event.files) {
                const filePath = file.fsPath;
                const relativeFilePath = this.getRelativeFilePath(filePath);

                // Check if any entries in fileYMap start with the folder path
                const isFolder = Array.from(this.fileYMap.keys()).some((key) =>
                    key.startsWith(relativeFilePath + path.sep)
                );

                if (isFolder) {
                    // If it's a folder, delete all entries within that path
                    console.log(`Folder deleted: ${relativeFilePath}`);
                    for (const key of Array.from(this.fileYMap.keys())) {
                        if (key.startsWith(relativeFilePath + path.sep)) {
                            this.fileYMap.delete(key);
                            console.log(
                                `File deleted from folder in fileYMap: ${key}`
                            );
                        }
                    }
                } else {
                    // If it's a single file, delete only that specific entry
                    if (this.fileYMap.has(relativeFilePath)) {
                        this.fileYMap.delete(relativeFilePath);
                        console.log(
                            `File deleted from fileYMap: ${relativeFilePath}`
                        );
                    }
                }
            }
        });
    }

    // Public wrapper to expose adding a file to the Y map
    public async addFileToSharedMap(
        filePath: string,
        relativeFilePath: string
    ) {
        await this.addFileToYMap(filePath, relativeFilePath);
    }

    // Function to add a single file to fileYMap
    private async addFileToYMap(filePath: string, relativeFilePath: string) {
        if (!this.fileYMap.has(relativeFilePath)) {
            const yText = new Y.Text();
            this.fileYMap.set(relativeFilePath, yText);

            try {
                const document = await vscode.workspace.openTextDocument(
                    filePath
                );
                const content = document.getText();
                yText.insert(0, content);

                console.log(`File added to fileYMap: ${relativeFilePath}`);
            } catch (error) {
                console.log(
                    `Error opening file: ${relativeFilePath}. Probably binary.`
                );
            }
        }
    }

    // Function to add all files within a directory to fileYMap
    private async addAllFilesInDirectory(folderPath: string) {
        // Find all files in the created directory
        const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folderPath, "**/*")
        );

        for (const file of files) {
            const filePath = file.fsPath;
            const relativeFilePath = this.getRelativeFilePath(filePath);

            // Skip files in excluded directories
            if (this.isExcludedDirectory(filePath)) {
                continue;
            }

            const fileStat = await vscode.workspace.fs.stat(file);
            if (fileStat.type === vscode.FileType.File) {
                await this.addFileToYMap(filePath, relativeFilePath);
            }
        }
    }

    // Helper function to check if a file is within an excluded directory
    private isExcludedDirectory(filePath: string): boolean {
        const pathSegments = filePath.split(path.sep);
        return pathSegments.some((segment) =>
            EXCLUDED_DIRECTORIES.has(segment)
        );
    }

    // Function to remove all files within a directory from fileYMap
    private removeAllFilesInDirectory(folderPath: string, folderName: string) {
        // Identify files in fileYMap that are within the specified folder path
        for (const key of Array.from(this.fileYMap.keys())) {
            if (key.startsWith(`${folderName}/`)) {
                this.fileYMap.delete(key);
                console.log(`File removed from fileYMap: ${key}`);
            }
        }
    }

    // Method to handle renaming of files or directories with added safety checks
    private async renameFileInYMap(
        oldRelativePath: string,
        newRelativePath: string
    ) {
        // Check if the old path exists in fileYMap
        const oldYText = this.fileYMap.get(oldRelativePath);

        if (oldYText) {
            // Create a new Y.Text instance if necessary for the new path
            const newYText = this.fileYMap.has(newRelativePath)
                ? this.fileYMap.get(newRelativePath)
                : new Y.Text();

            // Copy the content from the old Y.Text instance to the new one
            if (newYText && oldYText.toString()) {
                newYText.insert(0, oldYText.toString());
            }

            // Remove the old entry and add the new one
            this.fileYMap.delete(oldRelativePath);
            this.fileYMap.set(newRelativePath, newYText!);

            console.log(`Renamed: ${oldRelativePath} -> ${newRelativePath}`);
        } else {
            console.log(
                `Rename error: ${oldRelativePath} not found in fileYMap.`
            );
        }
    }

    // Function to rename all files within a directory in fileYMap
    private async renameAllFilesInDirectory(
        oldRelativePath: string,
        newRelativePath: string
    ) {
        // Find all entries in fileYMap that start with the old folder path
        const keysToRename = Array.from(this.fileYMap.keys()).filter((key) =>
            key.startsWith(oldRelativePath + path.sep)
        );

        for (const oldKey of keysToRename) {
            const newKey = oldKey.replace(oldRelativePath, newRelativePath);
            // Reuse renameFileInYMap to handle each file rename
            await this.renameFileInYMap(oldKey, newKey);
        }
    }

    private applyIncrementalChanges(
        fileName: string,
        contentChanges: readonly vscode.TextDocumentContentChangeEvent[]
    ) {
        const relativeFileName = this.getRelativeFilePath(fileName);

        const yText = this.fileYMap.get(relativeFileName);
        if (!yText) {
            return;
        }

        contentChanges.forEach((change) => {
            const start = change.rangeOffset;
            const length = change.rangeLength;

            if (length > 0) {
                yText.delete(start, length);
            }

            if (change.text.length > 0) {
                yText.insert(start, change.text);
            }
        });
    }

    public dispose() {
        this.provider.destroy();
        this.yDoc.destroy();
        this.awareness.setLocalState(null);
    }
}

// Create a status bar item
const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
);
status.text = "$(sync-ignored) Coducate";
status.color = "#fff";
status.show();

// CodeLens Provider for hiding code
class HideCodeLensProvider implements vscode.CodeLensProvider {
    private hiddenCodeMap: Map<vscode.Range, string> = new Map(); // Track hidden ranges and their code
    private decorations: vscode.TextEditorDecorationType[] = [];

    public provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.CodeLens[] {
        const lenses: vscode.CodeLens[] = [];

        this.hiddenCodeMap.forEach((_, range) => {
            lenses.push(
                new vscode.CodeLens(range, {
                    title: "Show Hidden Code",
                    command: "coducate.showCode",
                    arguments: [range],
                })
            );
        });

        return lenses;
    }

    public hideCode(
        range: vscode.Range,
        code: string,
        editor: vscode.TextEditor
    ) {
        this.hiddenCodeMap.set(range, code);

        // Create a decoration to indicate hidden code
        const decoration = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: "/* Hidden Code */",
                color: "#999999",
                fontStyle: "italic",
            },
        });

        editor.setDecorations(decoration, [range]);
        this.decorations.push(decoration);
    }

    public showCode(range: vscode.Range): string | undefined {
        const code = this.hiddenCodeMap.get(range);
        this.hiddenCodeMap.delete(range);
        return code;
    }

    // Getter method to access the hidden code
    public getHiddenCode(range: vscode.Range): string | undefined {
        return this.hiddenCodeMap.get(range);
    }

    // Method to retrieve all hidden ranges
    public getHiddenRanges(): vscode.Range[] {
        return Array.from(this.hiddenCodeMap.keys());
    }

    public clearDecorations(editor: vscode.TextEditor) {
        this.decorations.forEach((decoration) => {
            editor.setDecorations(decoration, []);
        });
        this.decorations = [];
    }
}

// HoverProvider for previewing hidden code on hover
class HideCodeHoverProvider implements vscode.HoverProvider {
    private hideCodeLensProvider: HideCodeLensProvider;

    constructor(hideCodeLensProvider: HideCodeLensProvider) {
        this.hideCodeLensProvider = hideCodeLensProvider;
    }

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        for (const range of this.hideCodeLensProvider.getHiddenRanges()) {
            if (range.contains(position)) {
                const hiddenCode =
                    this.hideCodeLensProvider.getHiddenCode(range);
                if (hiddenCode) {
                    const preview =
                        hiddenCode.length > 100
                            ? hiddenCode.substring(0, 100) + "..."
                            : hiddenCode;
                    return new vscode.Hover(
                        new vscode.MarkdownString(
                            "```" +
                                document.languageId +
                                "\n" +
                                preview +
                                "\n```"
                        )
                    );
                }
            }
        }
        return null;
    }
}

const hideCodeLensProvider = new HideCodeLensProvider();

export function activate(context: vscode.ExtensionContext) {
    status.text = "$(sync-ignored) Coducate";
    let roomId = context.globalState.get<string>(ROOM_ID_KEY);

    // Restore the live coding session if a roomId exists in globalState
    if (roomId) {
        disposableWebSocket = new DisposableWebSocket(serverWsUrl, roomId);
        context.subscriptions.push(disposableWebSocket);
        status.text = "$(sync) Coducate";
        vscode.window.showInformationMessage(
            "Live coding session restored. Room ID: " + roomId
        );

        // Show the roomId in the status bar, make it large on hover
        status.tooltip = roomId;
        status.command = {
            title: "Copy Room ID",
            command: "coducate.copyRoomId",
            arguments: [roomId],
        };
    }

    const startCommand = vscode.commands.registerCommand(
        "coducate.startSession",
        async () => {
            if (!disposableWebSocket) {
                // Prompt user for task description and learning goals
                const taskDescription = await vscode.window.showInputBox({
                    prompt: "Enter the task description",
                    placeHolder: "What is the main goal of this session?",
                });
                const learningGoalsInput = await vscode.window.showInputBox({
                    prompt: "Enter learning goals (comma-separated)",
                    placeHolder: "e.g., React, Input/Output, Unit Testing",
                });

                // Convert learning goals to an array
                const learningGoals = learningGoalsInput
                    ? learningGoalsInput.split(",").map((goal) => goal.trim())
                    : [];

                // Generate a new roomId
                let roomId = Math.random().toString(36).substring(2, 10);
                context.globalState.update(ROOM_ID_KEY, roomId); // Store the new roomId in globalState

                disposableWebSocket = new DisposableWebSocket(
                    serverWsUrl,
                    roomId
                );
                context.subscriptions.push(disposableWebSocket);
                status.text = "$(sync) Coducate";
                vscode.window.showInformationMessage(
                    "Live coding session started. Room ID: " + roomId
                );

                // Show the roomId in the status bar, make it large on hover
                status.tooltip = roomId;
                status.command = {
                    title: "Copy Room ID",
                    command: "coducate.copyRoomId",
                    arguments: [roomId],
                };

                // Path for coducateSetup.json file in the workspace
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    const workspaceFolder = workspaceFolders[0];
                    const setupFilePath = path.join(
                        workspaceFolder.uri.fsPath,
                        "coducateSetup.jsonc"
                    );

                    // Create JSON content with comments
                    const setupContent = `// This file contains the setup for task description and learning goals.
// If edited, a browser refresh is required to see the changes.

{
  "taskDescription": ${JSON.stringify(taskDescription)},
  "learningGoals": ${JSON.stringify(learningGoals)}
}`;

                    // Write the content to coducateSetup.jsonc
                    fs.writeFileSync(setupFilePath, setupContent);
                }
            } else {
                vscode.window.showInformationMessage(
                    "A live coding session is already running."
                );
                status.text = "$(sync) Coducate";
            }
        }
    );

    const endCommand = vscode.commands.registerCommand(
        "coducate.endSession",
        () => {
            if (disposableWebSocket) {
                disposableWebSocket.dispose();
                disposableWebSocket = undefined;
                status.text = "$(sync-ignored) Coducate"; // Update status bar to inactive state
                console.log("Live coding session ended.");

                // Clear the stored roomId from globalState
                context.globalState.update(ROOM_ID_KEY, undefined);
            } else {
                console.log("No live coding session is running.");
                status.text = "$(sync-ignored) Coducate";
            }
        }
    );

    // Command to hide selected code
    const hideCodeCommand = vscode.commands.registerCommand(
        "coducate.hideCode",
        () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const selection = editor.selection;
                if (!selection.isEmpty) {
                    // Create a range that includes entire lines, not just the selection
                    const startLine = selection.start.line;
                    const endLine = selection.end.line;

                    // Create a range that starts at the beginning of the first line and ends at the end of the last line
                    const range = new vscode.Range(
                        new vscode.Position(startLine, 0),
                        new vscode.Position(
                            endLine,
                            editor.document.lineAt(endLine).range.end.character
                        )
                    );

                    const selectedCode = editor.document.getText(range);

                    hideCodeLensProvider.hideCode(range, selectedCode, editor);

                    editor.edit((editBuilder) => {
                        editBuilder.delete(range); // Remove the entire lines from the editor
                    });
                    console.log("Code hidden");
                } else {
                    vscode.window.showInformationMessage("No code selected");
                }
            }
        }
    );

    // Command to show hidden code
    const showCodeCommand = vscode.commands.registerCommand(
        "coducate.showCode",
        (range: vscode.Range) => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const hiddenCode = hideCodeLensProvider.showCode(range);
                if (hiddenCode) {
                    editor.edit((editBuilder) => {
                        editBuilder.insert(range.start, hiddenCode); // Insert the hidden code back
                    });
                    hideCodeLensProvider.clearDecorations(editor); // Clear any remaining decorations
                    console.log("Code revealed");
                } else {
                    vscode.window.showInformationMessage("No code to reveal");
                }
            }
        }
    );

    // Command to copy the roomId to the clipboard
    const copyRoomIdCommand = vscode.commands.registerCommand(
        "coducate.copyRoomId",
        (roomId: string) => {
            vscode.env.clipboard.writeText(roomId);
            vscode.window.showInformationMessage("Room ID copied to clipboard");
        }
    );

    context.subscriptions.push(
        startCommand,
        endCommand,
        hideCodeCommand,
        showCodeCommand,
        copyRoomIdCommand
    );

    // Register CodeLens Provider
    const codeLensDisposable = vscode.languages.registerCodeLensProvider(
        "*",
        hideCodeLensProvider
    );
    context.subscriptions.push(codeLensDisposable);

    // Register Hover Provider for previewing hidden code
    const hoverProviderDisposable = vscode.languages.registerHoverProvider(
        "*",
        new HideCodeHoverProvider(hideCodeLensProvider)
    );
    context.subscriptions.push(hoverProviderDisposable);
}

export function deactivate() {
    if (disposableWebSocket) {
        disposableWebSocket.dispose();
        disposableWebSocket = undefined;
    }
    status.text = "$(sync-ignored) Coducate"; // Reset status bar to default when deactivated
    console.log("Extension is now deactivated.");
}
