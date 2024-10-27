import * as vscode from "vscode";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import path from "path";

const serverWsUrl = "ws://localhost:1234";
let disposableWebSocket: DisposableWebSocket | undefined;
const ROOM_ID_KEY = "coducateRoomId";

class DisposableWebSocket {
    private provider: WebsocketProvider;
    private yDoc: Y.Doc;
    private fileYMap: Y.Map<Y.Text>; // A shared map to store file names and their corresponding Y.Text objects

    constructor(url: string, roomId: string) {
        this.yDoc = new Y.Doc();
        this.provider = new WebsocketProvider(url, roomId, this.yDoc, {
            WebSocketPolyfill: require("ws"),
        });

        // Initialize the shared file list in the Y.Doc
        this.fileYMap = this.yDoc.getMap("fileYMap");

        // Sync initial files from the workspace
        this.addAllFilesInDirectory("");

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

            const fileStat = await vscode.workspace.fs.stat(file);
            if (fileStat.type === vscode.FileType.File) {
                await this.addFileToYMap(filePath, relativeFilePath);
            }
        }
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
        () => {
            // Generate a new roomId
            let roomId = Math.random().toString(36).substring(2, 10);
            context.globalState.update(ROOM_ID_KEY, roomId); // Store the new roomId in globalState

            if (!disposableWebSocket) {
                disposableWebSocket = new DisposableWebSocket(
                    serverWsUrl,
                    roomId
                );
                context.subscriptions.push(disposableWebSocket);
                status.text = "$(sync) Coducate";
                console.log("Live coding session started.");
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
            } else {
                console.log("Live coding session is already running.");
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
