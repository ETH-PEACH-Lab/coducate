import * as vscode from "vscode";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import path from "path";

const serverWsUrl = "ws://localhost:1234";
let disposableWebSocket: DisposableWebSocket | undefined;

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
        this.setupFileSync();

        this.setupVSCodeListeners();
    }

    private getRelativeFilePath(filePath: string): string {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (workspaceFolder) {
            const workspaceFolderPath = workspaceFolder.uri.fsPath;
            const workspaceFolderName = workspaceFolder.name;

            if (filePath.startsWith(workspaceFolderPath)) {
                const relativePath = filePath.substring(
                    workspaceFolderPath.length + 1
                );
                return `${workspaceFolderName}/${relativePath}`;
            }
        }

        return filePath;
    }

    // Function to gather files and add them to the shared Yjs map
    private async setupFileSync() {
        const files = await vscode.workspace.findFiles("**/*"); // Get all files in the workspace
        for (const file of files) {
            const filePath = file.fsPath;
            const relativeFilePath = this.getRelativeFilePath(filePath);

            // Check if it's a file, not a directory
            const fileStat = await vscode.workspace.fs.stat(file);
            if (fileStat.type === vscode.FileType.File) {
                if (!this.fileYMap.has(relativeFilePath)) {
                    const yText = new Y.Text();
                    this.fileYMap.set(relativeFilePath, yText);

                    // Open the file and sync its content to Y.Text
                    const document = await vscode.workspace.openTextDocument(
                        filePath
                    );
                    const content = document.getText();

                    yText.insert(0, content);
                }
            } else {
                console.log(`Skipped folder: ${relativeFilePath}`);
            }
        }
    }

    private setupVSCodeListeners() {
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

                // Check if it's a file, not a directory
                const fileStat = await vscode.workspace.fs.stat(file);
                if (fileStat.type === vscode.FileType.File) {
                    if (!this.fileYMap.has(relativeFilePath)) {
                        const yText = new Y.Text();
                        this.fileYMap.set(relativeFilePath, yText);

                        const document =
                            await vscode.workspace.openTextDocument(filePath);
                        const content = document.getText();

                        yText.insert(0, content);
                        console.log(`File created: ${relativeFilePath}`);
                    }
                } else if (fileStat.type === vscode.FileType.Directory) {
                    console.log(
                        `Folder created: ${relativeFilePath} - Skipping`
                    );
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

    const startCommand = vscode.commands.registerCommand(
        "coducate.startSession",
        () => {
            // Generate a random roomId
            const roomId = Math.random().toString(36).substring(2, 10);

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
            } else {
                console.log("No live coding session is running.");
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
        showCodeCommand
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
