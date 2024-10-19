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
            this.syncDocumentToYDoc(document);
        }

        vscode.workspace.onDidChangeTextDocument((event) => {
            this.syncDocumentToYDoc(event.document);
        });

        vscode.workspace.onDidOpenTextDocument((document) => {
            this.syncDocumentToYDoc(document);
        });
    }

    public syncDocumentToYDoc(document: vscode.TextDocument) {
        const codeContent = document.getText();
        this.yText.delete(0, this.yText.length);
        this.yText.insert(0, codeContent);
        console.log("VS Code document content synced to Yjs");
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
