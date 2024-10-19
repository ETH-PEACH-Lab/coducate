import * as vscode from "vscode";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

const serverWsUrl = "ws://localhost:1234";

class DisposableWebSocket {
    private provider: WebsocketProvider;
    private yText: Y.Text;

    constructor(url: string, context: vscode.ExtensionContext) {
        const yDoc = new Y.Doc();

        // If no clientId exists in globalState, we'll store the first one created
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
        this.yText.insert(0, codeContent);
        console.log("VS Code entire document content synced to Yjs");
    }

    public dispose() {
        this.provider.disconnect();
        console.log("WebSocket provider disposed.");
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log("Your extension is now active!");

    const ws = new DisposableWebSocket(serverWsUrl, context);
    context.subscriptions.push(ws);
}

export function deactivate() {
    console.log("Extension is now deactivated.");
}
