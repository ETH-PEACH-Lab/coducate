import * as vscode from "vscode";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

class DisposableWebSocket {
    private provider: WebsocketProvider;
    private text: Y.Text;

    constructor(url: string) {
        const doc = new Y.Doc();

        // Use 'ws' directly as the WebSocketPolyfill
        this.provider = new WebsocketProvider(url, "roomId", doc, {
            WebSocketPolyfill: require("ws"),
        });

        this.text = doc.getText("monaco");
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
        this.text.delete(0, this.text.length);
        this.text.insert(0, codeContent);
        console.log("VS Code document content synced to Yjs");
    }

    public dispose() {
        this.provider.disconnect();
        console.log("WebSocket provider disposed.");
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log("Your extension is now active!");

    const ws = new DisposableWebSocket("ws://localhost:1234"); // Same URL as used in App.tsx
    context.subscriptions.push(ws);
}

export function deactivate() {
    console.log("Extension is now deactivated.");
}
