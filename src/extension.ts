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

    context.subscriptions.push(startCommand);
    context.subscriptions.push(endCommand);
}

export function deactivate() {
    if (disposableWebSocket) {
        disposableWebSocket.dispose();
        disposableWebSocket = undefined;
    }
    status.text = "$(sync-ignored) Live Coding"; // Reset status bar to default when deactivated
    console.log("Extension is now deactivated.");
}
