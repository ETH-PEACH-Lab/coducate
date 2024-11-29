import * as vscode from "vscode";

interface Note {
    line: number;
    code: string;
    title: string;
}

export class NotesCodeLensProvider implements vscode.CodeLensProvider {
    public storedNotes: { [filePath: string]: Note[] } = {};
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    private isUndoing = false;

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

        // Listen for text document changes
        vscode.workspace.onDidChangeTextDocument(
            this.onDocumentChanged.bind(this)
        );

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

    public addNote(filePath: string, note: Note) {
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
                `All notes removed from the workspace (${noteCount} file/s).`
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
            [filePath: string]: Note[];
        }>(key, {});
        this.storedNotes = savedNotes || {};
    }

    private async onDocumentChanged(event: vscode.TextDocumentChangeEvent) {
        if (this.isUndoing) {
            return;
        }

        const filePath = event.document.uri.fsPath;
        const notes = this.storedNotes[filePath];
        if (!notes) {
            return;
        }

        // Sort notes by line number to ensure correct processing
        notes.sort((a, b) => a.line - b.line);

        for (const change of event.contentChanges) {
            const startLine = change.range.start.line;
            const endLine = change.range.end.line;
            const linesRemoved = endLine - startLine;
            const linesAdded = change.text.split("\n").length - 1;
            const lineDelta = linesAdded - linesRemoved;

            // Simulate note positions based on specified shift logic
            const simulatedNotes = notes.map((note) => {
                const newNote = { ...note };
                if (newNote.line > startLine) {
                    if (lineDelta > 0) {
                        newNote.line += lineDelta;
                    } else if (
                        newNote.line !== startLine + 1 &&
                        lineDelta < 0
                    ) {
                        newNote.line += lineDelta;
                    }
                }
                return newNote;
            });

            // Check for overlaps
            for (let i = 1; i < simulatedNotes.length; i++) {
                if (simulatedNotes[i - 1].line === simulatedNotes[i].line) {
                    // Conflict detected, trigger UNDO and warn the user
                    this.isUndoing = true;
                    await vscode.commands.executeCommand("undo");
                    this.isUndoing = false;

                    vscode.window.showWarningMessage(
                        "Conflict detected: Two notes cannot be on the same line. The last change has been undone.",
                        { modal: false },
                        "Ok"
                    );

                    return;
                }
            }

            // Apply the actual line shifts
            for (const note of notes) {
                if (note.line > startLine) {
                    if (lineDelta > 0) {
                        note.line += lineDelta;
                    } else if (note.line !== startLine + 1 && lineDelta < 0) {
                        note.line += lineDelta;
                    }
                }
            }
        }

        this.saveNotes();
        this.refresh();
    }
}
