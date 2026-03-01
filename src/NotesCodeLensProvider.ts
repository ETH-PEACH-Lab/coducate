import * as vscode from "vscode";
import * as crypto from "crypto";
import { showTmpNotification } from "./tmpNotifications";

export interface Note {
    line: number;
    code: string;
    title: string;
}

export class NotesCodeLensProvider implements vscode.CodeLensProvider {
    public storedNotes: { [relativePath: string]: Note[] } = {};
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    private isUndoing = false;
    public isRestoringFiles = false;
    public isApplyingNotes = false;
    private isWritingCoducateJson = false;

    private context: vscode.ExtensionContext;
    private roomId: string;
    private getRelativeFilePath: (filePath: string) => string;
    private workspaceRootUri: vscode.Uri | undefined;
    private sessionName: string;
    private createdAt: string;

    private _onDidWriteCoducateJson = new vscode.EventEmitter<string>();
    public readonly onDidWriteCoducateJson = this._onDidWriteCoducateJson.event;

    constructor(
        context: vscode.ExtensionContext,
        roomId: string,
        getRelativeFilePath: (filePath: string) => string,
        workspaceRootUri: vscode.Uri | undefined,
        sessionName: string
    ) {
        this.context = context;
        this.roomId = roomId;
        this.getRelativeFilePath = getRelativeFilePath;
        this.workspaceRootUri = workspaceRootUri;
        this.sessionName = sessionName;
        this.createdAt = new Date().toISOString();

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

    /**
     * Converts a file path to a relative path if it is absolute.
     */
    public toRelative(filePath: string): string {
        // Already relative (doesn't start with / or a drive letter like C:\)
        if (!filePath.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(filePath)) {
            return filePath;
        }
        return this.getRelativeFilePath(filePath);
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const relativePath = this.toRelative(document.uri.fsPath);
        const notes = this.storedNotes[relativePath];
        if (!notes) {
            return [];
        }

        const codeLenses: vscode.CodeLens[] = [];
        for (const note of notes) {
            const range = new vscode.Range(note.line, 0, note.line, 0);
            const command: vscode.Command = {
                title: note.title,
                command: "coducate.handleNoteAction",
                arguments: [document.uri.fsPath, note.line],
            };
            codeLenses.push(new vscode.CodeLens(range, command));
        }
        return codeLenses;
    }

    public addNote(filePath: string, note: Note) {
        const relativePath = this.toRelative(filePath);
        if (!this.storedNotes[relativePath]) {
            this.storedNotes[relativePath] = [];
        }
        this.storedNotes[relativePath].push(note);
        this.saveNotes();
        this.refresh();
    }

    public removeNote(filePath: string, line: number) {
        const relativePath = this.toRelative(filePath);
        if (!this.storedNotes[relativePath]) {
            return;
        }
        this.storedNotes[relativePath] = this.storedNotes[relativePath].filter(
            (note) => note.line !== line
        );

        if (this.storedNotes[relativePath].length === 0) {
            delete this.storedNotes[relativePath];
        }

        this.saveNotes();
        this.refresh();
    }

    public removeAllNotesInFile(filePath: string): void {
        const relativePath = this.toRelative(filePath);
        if (this.storedNotes[relativePath]) {
            const noteCount = this.storedNotes[relativePath].length;
            delete this.storedNotes[relativePath];
            this.saveNotes();
            this.refresh();

            showTmpNotification(
                `All notes removed from ${relativePath} (${noteCount} note${noteCount === 1 ? "" : "s"}).`
            );
        } else {
            showTmpNotification(
                `No notes found in '${relativePath}'.`
            );
        }
    }

    public removeAllNotesInWorkspace(): void {
        const noteCount = Object.keys(this.storedNotes).length;
        if (noteCount > 0) {
            this.storedNotes = {};
            this.saveNotes();
            this.refresh();
            showTmpNotification(
                `All notes removed from the workspace (${noteCount} file${
                    noteCount === 1 ? "" : "s"
                }).`
            );
        } else {
            showTmpNotification("No notes found in the workspace.");
        }
    }

    /**
     * Returns a deep copy of all stored notes (with relative paths as keys).
     */
    public exportNotes(): { [relativePath: string]: Note[] } {
        return JSON.parse(JSON.stringify(this.storedNotes));
    }

    /**
     * Replaces all stored notes with the provided notes.
     */
    public importNotes(notes: { [relativePath: string]: Note[] }): void {
        this.storedNotes = notes;
        this.saveNotes();
        this.refresh();
    }

    /**
     * Reconstructs the complete file content by reinserting hidden note code.
     * The current content has empty placeholder lines where notes were applied.
     */
    public reconstructCompleteFileContent(
        relativePath: string,
        currentContent: string
    ): string {
        const notes = this.storedNotes[relativePath];
        if (!notes || notes.length === 0) {
            return currentContent;
        }

        const lines = currentContent.split("\n");
        const sortedDesc = [...notes].sort((a, b) => b.line - a.line);

        for (const note of sortedDesc) {
            const codeLines = note.code.split("\n");
            lines.splice(note.line, 1, ...codeLines);
        }

        return lines.join("\n");
    }

    /**
     * Returns notes with line numbers adjusted for the complete (unreduced) file.
     * In the applied state, each note's multi-line code was replaced by 1 empty line.
     * This computes the original line numbers in the complete file.
     */
    public getNotesForCompleteFile(
        relativePath: string
    ): Note[] {
        const notes = this.storedNotes[relativePath];
        if (!notes || notes.length === 0) {
            return [];
        }

        const sorted = [...notes].sort((a, b) => a.line - b.line);
        let offset = 0;

        return sorted.map((note) => {
            const adjustedLine = note.line + offset;
            const codeLineCount = note.code.split("\n").length;
            offset += codeLineCount - 1;
            return { ...note, line: adjustedLine };
        });
    }

    /**
     * Applies notes to a complete file: removes note code lines and replaces
     * each with an empty line. Returns modified content and notes with
     * adjusted applied-state line numbers.
     */
    public applyNotesToFile(
        completeContent: string,
        completeNotes: Note[]
    ): { content: string; appliedNotes: Note[] } {
        const lines = completeContent.split("\n");
        const sortedDesc = [...completeNotes].sort((a, b) => b.line - a.line);

        for (const note of sortedDesc) {
            const codeLineCount = note.code.split("\n").length;
            lines.splice(note.line, codeLineCount, "");
        }

        const sortedAsc = [...completeNotes].sort((a, b) => a.line - b.line);
        let offset = 0;
        const appliedNotes = sortedAsc.map((note) => {
            const appliedLine = note.line - offset;
            const codeLineCount = note.code.split("\n").length;
            offset += codeLineCount - 1;
            return { ...note, line: appliedLine };
        });

        return { content: lines.join("\n"), appliedNotes };
    }

    public setSessionName(name: string) {
        this.sessionName = name;
    }

    public setCreatedAt(createdAt: string) {
        this.createdAt = createdAt;
    }

    /**
     * Builds the .coducate.json content with notes in complete-file line numbers.
     * Returns the JSON string and its SHA-256 hash.
     */
    public buildCoducateJson(): { content: string; hash: string } {
        const completeNotes: { [filePath: string]: Note[] } = {};

        for (const relativePath of Object.keys(this.storedNotes)) {
            const notes = this.getNotesForCompleteFile(relativePath);
            if (notes.length > 0) {
                // Strip workspace folder prefix (e.g., "myProject/src/index.ts" -> "src/index.ts")
                const slashIndex = relativePath.indexOf("/");
                const strippedPath =
                    slashIndex !== -1
                        ? relativePath.substring(slashIndex + 1)
                        : relativePath;
                completeNotes[strippedPath] = notes;
            }
        }

        const data = {
            version: 1,
            name: this.sessionName,
            notes: completeNotes,
            metadata: {
                createdAt: this.createdAt,
            },
        };

        const content = JSON.stringify(data, null, 2);
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        return { content, hash };
    }

    /**
     * Writes .coducate.json to the workspace root. Best-effort, fire-and-forget.
     */
    private async writeCoducateJson() {
        if (!this.workspaceRootUri || this.isWritingCoducateJson) {
            return;
        }
        this.isWritingCoducateJson = true;
        try {
            const { content, hash } = this.buildCoducateJson();
            const coducateJsonUri = vscode.Uri.joinPath(
                this.workspaceRootUri,
                ".coducate.json"
            );
            await vscode.workspace.fs.writeFile(
                coducateJsonUri,
                Buffer.from(content, "utf8")
            );
            this._onDidWriteCoducateJson.fire(hash);
        } catch {
            // Best effort
        } finally {
            this.isWritingCoducateJson = false;
        }
    }

    /**
     * Public trigger for re-creating .coducate.json (e.g., after accidental deletion).
     */
    public triggerCoducateJsonWrite() {
        this.writeCoducateJson();
    }

    private saveNotes() {
        const key = `storedNotes-${this.roomId}`;
        this.context.globalState.update(key, this.storedNotes);
        this.writeCoducateJson();
    }

    private loadNotes() {
        const key = `storedNotes-${this.roomId}`;
        const savedNotes = this.context.globalState.get<{
            [filePath: string]: Note[];
        }>(key, {});

        if (!savedNotes) {
            this.storedNotes = {};
            return;
        }

        // Migrate absolute paths to relative paths
        const migrated: { [relativePath: string]: Note[] } = {};
        let needsMigration = false;
        for (const [filePath, notes] of Object.entries(savedNotes)) {
            const relativePath = this.toRelative(filePath);
            if (relativePath !== filePath) {
                needsMigration = true;
            }
            migrated[relativePath] = notes;
        }

        this.storedNotes = migrated;

        if (needsMigration) {
            this.saveNotes();
        }
    }

    private async onDocumentChanged(event: vscode.TextDocumentChangeEvent) {
        if (this.isUndoing || this.isRestoringFiles || this.isApplyingNotes) {
            return;
        }

        const relativePath = this.toRelative(event.document.uri.fsPath);
        const notes = this.storedNotes[relativePath];
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
