import * as vscode from "vscode";

interface INote {
    line: number;
    code: string;
    title: string;
}

export class NotesCodeLensProvider implements vscode.CodeLensProvider {
    public storedNotes: { [filePath: string]: INote[] } = {};
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    private context: vscode.ExtensionContext;
    private roomId: string;
    private getRelativeFilePath: (filePath: string) => string;

    constructor(
        context: vscode.ExtensionContext,
        roomId: string,
        getRelativeFilePath: (filePath: string) => string
    ) {
        this.context = context;
        this.roomId = roomId;
        this.getRelativeFilePath = getRelativeFilePath;

        // Load notes on initialization
        this.loadNotes();
    }

    public refresh() {
        this._onDidChangeCodeLenses.fire();
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
                command: "coducate.handleNoteAction",
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

    public removeAllNotesInFile(filePath: string): void {
        if (this.storedNotes[filePath]) {
            delete this.storedNotes[filePath];
            this.saveNotes();
            this.refresh();
            vscode.window.showInformationMessage(
                `All notes removed from the file: ${this.getRelativeFilePath(
                    filePath
                )}`
            );
        } else {
            vscode.window.showInformationMessage(
                "No notes found in the specified file."
            );
        }
    }

    public removeAllNotesInWorkspace(): void {
        const noteCount = Object.keys(this.storedNotes).length;
        if (noteCount > 0) {
            this.storedNotes = {};
            this.saveNotes();
            this.refresh();
            vscode.window.showInformationMessage(
                `All notes removed from the workspace (${noteCount} file(s)).`
            );
        } else {
            vscode.window.showInformationMessage(
                "No notes found in the workspace."
            );
        }
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
