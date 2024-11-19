import * as vscode from "vscode";

interface INote {
    line: number;
    code: string;
    title: string;
}

export class NotesCodeLensProvider implements vscode.CodeLensProvider {
    public storedNotes: { [filePath: string]: INote[] } = {};
    private onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses =
        this.onDidChangeCodeLensesEmitter.event;

    public refresh() {
        this.onDidChangeCodeLensesEmitter.fire();
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const filePath = document.uri.fsPath;
        const notes = this.storedNotes[filePath];
        if (!notes) {
            return [];
        }

        const codeLenses: vscode.CodeLens[] = [];
        for (const note of notes) {
            const range = new vscode.Range(note.line, 0, note.line, 0);
            const command: vscode.Command = {
                title: note.title,
                command: "coducate.restoreNote",
                arguments: [filePath, note.line],
            };
            codeLenses.push(new vscode.CodeLens(range, command));
        }
        return codeLenses;
    }
}
