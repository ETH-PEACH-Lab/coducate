import * as vscode from "vscode";
import { NotesCodeLensProvider } from "./NotesCodeLensProvider";
import { renderPrompt } from "@vscode/prompt-tsx";
import { AutocompletePrompt } from "./AutocompletePrompt";

export class InlineCompletionProvider
    implements vscode.InlineCompletionItemProvider
{
    private notesCodeLensProvider: NotesCodeLensProvider;
    private cachedResponses: { [filePath: string]: string | null } = {};
    private suggestionsEnabled = true;
    private userWasNotified = false;

    constructor(notesCodeLensProvider: NotesCodeLensProvider) {
        this.notesCodeLensProvider = notesCodeLensProvider;
    }

    toggleSuggestions() {
        this.suggestionsEnabled = !this.suggestionsEnabled;
        return this.suggestionsEnabled;
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ) {
        if (!this.suggestionsEnabled) {
            return [];
        }

        const filePath = document.uri.fsPath;
        const line = position.line;

        // Find the most recent note that is above or on the same line as the current cursor position
        const recentNote = this.findRecentNoteAbove(filePath, line);
        if (!recentNote) {
            return [];
        }

        // Capture the user's typed text from the note's starting line to the current cursor position
        const noteStartPosition = new vscode.Position(recentNote.line, 0);
        const typedRange = new vscode.Range(noteStartPosition, position);
        const typedText = document.getText(typedRange);

        const noteSuggestion = recentNote.code;

        // 1. If the user's input matches the stored notes, show the remaining notes
        if (this.startsWithIgnoringWhitespace(noteSuggestion, typedText)) {
            const trimmedSuggestion = this.codeDifference(
                noteSuggestion,
                typedText
            );
            const item = new vscode.InlineCompletionItem(trimmedSuggestion);
            item.range = new vscode.Range(position, position);
            return [item];
        }

        // 2. Check the cached LLM suggestion
        const cachedSuggestion = this.cachedResponses[filePath];
        if (
            cachedSuggestion &&
            this.startsWithIgnoringWhitespace(cachedSuggestion, typedText)
        ) {
            const trimmedSuggestion = this.codeDifference(
                cachedSuggestion,
                typedText
            );
            const item = new vscode.InlineCompletionItem(trimmedSuggestion);
            item.range = new vscode.Range(position, position);
            return [item];
        }

        // 3. Fetch a new LLM suggestion if no valid cached suggestion is available
        const newSuggestion = await this.getLanguageModelSuggestions(
            noteSuggestion,
            typedText
        );
        if (newSuggestion) {
            if (!this.startsWithIgnoringWhitespace(newSuggestion, typedText)) {
                // Drop invalid suggestions
                return;
            }

            const trimmedSuggestion = this.codeDifference(
                newSuggestion,
                typedText
            );

            this.cachedResponses[filePath] = newSuggestion;
            const item = new vscode.InlineCompletionItem(trimmedSuggestion);
            item.range = new vscode.Range(position, position);
            return [item];
        }

        return [];
    }

    private findRecentNoteAbove(
        filePath: string,
        currentLine: number
    ): { line: number; code: string } | null {
        const relativePath = this.notesCodeLensProvider?.toRelative(filePath);
        const notes = this.notesCodeLensProvider?.storedNotes[relativePath];
        if (!notes) {
            return null;
        }

        // Filter for notes that are on the same line or above the current line
        const validNotes = notes.filter((note) => note.line <= currentLine);

        // Find the most recent (highest line number) among valid notes
        const recentNote = validNotes.reduce(
            (prev, curr) => (curr.line > prev.line ? curr : prev),
            validNotes[0]
        );

        return recentNote || null;
    }

    private startsWithIgnoringWhitespace(
        noteContent: string,
        typedText: string
    ) {
        // Remove all whitespace from both strings
        const normalize = (str: string) => str.replace(/\s+/g, "");
        return normalize(noteContent).startsWith(normalize(typedText));
    }

    private codeDifference(note: string, typedText: string) {
        const cleanNoteContent = note.replace(/[ \t]+\n/g, "\n");
        const cleanTypedText = typedText.replace(/[ \t]+\n/g, "\n");
        return cleanNoteContent
            .trimStart()
            .slice(cleanTypedText.trimStart().length);
    }

    // Function to generate code suggestions using the Language Model API
    private async getLanguageModelSuggestions(
        note: string,
        typedText: string
    ): Promise<string | null> {
        try {
            const models = await vscode.lm.selectChatModels({
                vendor: "copilot",
                family: "gpt-4o-mini",
            });

            if (models.length === 0) {
                if (!this.userWasNotified) {
                    const answer = await vscode.window.showWarningMessage(
                        "No language models available. To use your notes, your typing must precisely match the notes.",
                        "Ok"
                    );

                    if (answer === "Ok") {
                        this.userWasNotified = true;
                    }
                }
                return null;
            }

            const [model] = models;

            const { messages } = await renderPrompt(
                AutocompletePrompt,
                {
                    note: note,
                    typedText: typedText,
                },
                { modelMaxPromptTokens: 4096 },
                model
            );

            const response = await model.sendRequest(
                messages,
                {},
                new vscode.CancellationTokenSource().token
            );

            let suggestion = "";
            for await (const fragment of response.text) {
                suggestion += fragment;
            }

            return suggestion;
        } catch (err) {
            return null;
        }
    }
}
