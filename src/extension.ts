import * as vscode from "vscode";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

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

    // Function to gather files and add them to the shared Yjs map
    private async setupFileSync() {
        const files = await vscode.workspace.findFiles("**/*"); // Get all files in the workspace
        files.forEach(async (file) => {
            const filePath = file.fsPath;

            // Create a new Y.Text for each file if it doesn't exist yet
            if (!this.fileYMap.has(filePath)) {
                const yText = new Y.Text();
                this.fileYMap.set(filePath, yText);

                // Open the file and sync its content to Y.Text
                const document = await vscode.workspace.openTextDocument(
                    filePath
                );
                const content = document.getText();

                // Populate Y.Text with the file's content
                yText.insert(0, content);
            }
        });
    }

    private setupVSCodeListeners() {
        if (vscode.window.activeTextEditor) {
            const document = vscode.window.activeTextEditor.document;
            this.syncDocumentToYText(document.fileName, document.getText());
        }

        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document === vscode.window.activeTextEditor?.document) {
                this.applyIncrementalChanges(
                    event.document.fileName,
                    event.contentChanges
                );
            }
        });

        vscode.workspace.onDidOpenTextDocument((document) => {
            this.syncDocumentToYText(document.fileName, document.getText());
        });
    }

    private syncDocumentToYText(fileName: string, content: string) {
        const yText = this.fileYMap.get(fileName);
        if (!yText) {
            return;
        }

        yText.delete(0, yText.length); // Clear existing content
        yText.insert(0, content); // Insert new content
    }

    private applyIncrementalChanges(
        fileName: string,
        contentChanges: readonly vscode.TextDocumentContentChangeEvent[]
    ) {
        const yText = this.fileYMap.get(fileName);
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
status.text = "$(sync-ignored) Live Coding";
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
                    command: "live-coding.showCode",
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
    status.text = "$(sync-ignored) Live Coding";

    const startCommand = vscode.commands.registerCommand(
        "live-coding.startSession",
        () => {
            // Generate a random roomId
            const roomId = Math.random().toString(36).substring(2, 10);

            if (!disposableWebSocket) {
                disposableWebSocket = new DisposableWebSocket(
                    serverWsUrl,
                    roomId
                );
                context.subscriptions.push(disposableWebSocket);
                status.text = "$(sync) Live Coding";
                console.log("Live coding session started.");
                vscode.window.showInformationMessage(
                    "Live coding session started. Room ID: " + roomId
                );

                // Show the roomId in the status bar, make it large on hover
                status.tooltip = roomId;
                status.command = {
                    title: "Copy Room ID",
                    command: "live-coding.copyRoomId",
                    arguments: [roomId],
                };
            } else {
                console.log("Live coding session is already running.");
            }
        }
    );

    const endCommand = vscode.commands.registerCommand(
        "live-coding.endSession",
        () => {
            if (disposableWebSocket) {
                disposableWebSocket.dispose();
                disposableWebSocket = undefined;
                status.text = "$(sync-ignored) Live Coding"; // Update status bar to inactive state
                console.log("Live coding session ended.");
            } else {
                console.log("No live coding session is running.");
            }
        }
    );

    // Command to hide selected code
    const hideCodeCommand = vscode.commands.registerCommand(
        "live-coding.hideCode",
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
        "live-coding.showCode",
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
        "live-coding.copyRoomId",
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
    status.text = "$(sync-ignored) Live Coding"; // Reset status bar to default when deactivated
    console.log("Extension is now deactivated.");
}
