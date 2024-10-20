import * as vscode from "vscode";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

const serverWsUrl = "ws://localhost:1234";
let disposableWebSocket: DisposableWebSocket | undefined;

class DisposableWebSocket {
    private provider: WebsocketProvider;
    private yText: Y.Text;

    constructor(url: string, context: vscode.ExtensionContext) {
        const yDoc = new Y.Doc();

        this.provider = new WebsocketProvider(url, "roomId", yDoc, {
            WebSocketPolyfill: require("ws"),
        });

        const awareness = this.provider.awareness;

        this.yText = yDoc.getText("monaco");
        this.setupVSCodeListeners();
    }

    private setupVSCodeListeners() {
        if (vscode.window.activeTextEditor) {
            const document = vscode.window.activeTextEditor.document;
            console.log("DOC SYNC: Active document found:", document.fileName);
            this.syncDocumentToYDoc(document); // Sync initial document content
        }

        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document === vscode.window.activeTextEditor?.document) {
                console.log(
                    "DOC SYNC: Document changed:",
                    event.document.fileName
                );
                this.applyIncrementalChanges(event.contentChanges);
            }
        });

        vscode.workspace.onDidOpenTextDocument((document) => {
            console.log("DOC SYNC: Document opened:", document.fileName);
            this.syncDocumentToYDoc(document); // Sync document content on open
        });
    }

    private applyIncrementalChanges(
        contentChanges: readonly vscode.TextDocumentContentChangeEvent[]
    ) {
        contentChanges.forEach((change) => {
            const start = change.rangeOffset;
            const length = change.rangeLength;

            if (length > 0) {
                this.yText.delete(start, length);
            }

            if (change.text.length > 0) {
                this.yText.insert(start, change.text);
            }
        });
        console.log("Incremental changes applied to Yjs document");
    }

    private syncDocumentToYDoc(document: vscode.TextDocument) {
        const codeContent = document.getText();
        this.yText.delete(0, this.yText.length);
        console.log("VS Code entire document content synced to Yjs");
    }

    public dispose() {
        this.provider.disconnect();
        console.log("WebSocket provider disposed.");
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
        "live-coding.startLiveCoding",
        () => {
            if (!disposableWebSocket) {
                disposableWebSocket = new DisposableWebSocket(
                    serverWsUrl,
                    context
                );
                context.subscriptions.push(disposableWebSocket);
                status.text = "$(sync) Live Coding";
                console.log("Live coding session started.");
            } else {
                console.log("Live coding session is already running.");
            }
        }
    );

    const endCommand = vscode.commands.registerCommand(
        "live-coding.endLiveCoding",
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
                        new vscode.Position(startLine, 0), // Beginning of the start line
                        new vscode.Position(
                            endLine,
                            editor.document.lineAt(endLine).range.end.character
                        ) // End of the last line
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
