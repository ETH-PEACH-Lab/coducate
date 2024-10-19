import * as vscode from "vscode";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

const serverWsUrl = "ws://localhost:1234";

class DisposableWebSocket {
    private provider: WebsocketProvider;
    private yText: Y.Text;

    constructor(url: string) {
        const yDoc = new Y.Doc();

        // Use 'ws' directly as the WebSocketPolyfill
        this.provider = new WebsocketProvider(url, "roomId", yDoc, {
            WebSocketPolyfill: require("ws"),
        });

        this.yText = yDoc.getText("monaco");
        this.setupVSCodeListeners();
    }

    private setupVSCodeListeners() {
        if (vscode.window.activeTextEditor) {
            const document = vscode.window.activeTextEditor.document;
            this.syncDocumentToYDoc(document); // Sync initial document content
        }

        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document === vscode.window.activeTextEditor?.document) {
                this.applyIncrementalChanges(event.contentChanges);
            }
        });

        vscode.workspace.onDidOpenTextDocument((document) => {
            this.syncDocumentToYDoc(document); // Sync document content on open
        });
    }

    // Accept readonly array of content changes from VS Code
    private applyIncrementalChanges(
        contentChanges: readonly vscode.TextDocumentContentChangeEvent[]
    ) {
        contentChanges.forEach((change) => {
            const start = change.rangeOffset;
            const length = change.rangeLength;

            if (length > 0) {
                // If there are characters to delete, remove them from yText
                this.yText.delete(start, length);
            }

            if (change.text.length > 0) {
                // If there are characters to insert, add them at the appropriate position
                this.yText.insert(start, change.text);
            }
        });
        console.log("Incremental changes applied to Yjs document");
    }

    // Sync entire document initially (e.g., when opening a file)
    private syncDocumentToYDoc(document: vscode.TextDocument) {
        const codeContent = document.getText();
        this.yText.delete(0, this.yText.length); // Clear the existing content in yText
        this.yText.insert(0, codeContent); // Insert the current VS Code document content
        console.log("VS Code entire document content synced to Yjs");
    }

    public dispose() {
        this.provider.disconnect();
        console.log("WebSocket provider disposed.");
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log("Your extension is now active!");

    const ws = new DisposableWebSocket(serverWsUrl); // Same URL as used in App.tsx
    context.subscriptions.push(ws);
}

export function deactivate() {
    console.log("Extension is now deactivated.");
}
