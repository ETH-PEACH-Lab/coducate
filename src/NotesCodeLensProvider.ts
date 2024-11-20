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

    private context: vscode.ExtensionContext;
    private roomId: string;

    constructor(context: vscode.ExtensionContext, roomId: string) {
        this.context = context;
        this.roomId = roomId;

        // Load notes on initialization
        this.loadNotes();
    }

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

    public addNote(filePath: string, note: INote) {
        if (!this.storedNotes[filePath]) {
            this.storedNotes[filePath] = [];
        }
        this.storedNotes[filePath].push(note);
        this.saveNotes();
        this.refresh();
    }

    public removeNote(filePath: string, line: number) {
        if (!this.storedNotes[filePath]) {
            return;
        }
        this.storedNotes[filePath] = this.storedNotes[filePath].filter(
            (note) => note.line !== line
        );

        if (this.storedNotes[filePath].length === 0) {
            delete this.storedNotes[filePath];
        }

        this.saveNotes();
        this.refresh();
    }

    private saveNotes() {
        const key = `storedNotes-${this.roomId}`;
        this.context.workspaceState.update(key, this.storedNotes);
    }

    private loadNotes() {
        const key = `storedNotes-${this.roomId}`;
        const savedNotes = this.context.workspaceState.get<{
            [filePath: string]: INote[];
        }>(key, {});
        this.storedNotes = savedNotes || {};
    }
}
