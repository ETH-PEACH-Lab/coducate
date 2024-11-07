import * as vscode from "vscode";

export class HideCodeLensProvider implements vscode.CodeLensProvider {
    private hiddenCodeMap: Map<vscode.Range, string> = new Map(); // Track hidden ranges and their code
    private decorations: vscode.TextEditorDecorationType[] = [];

    public provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.CodeLens[] {
        const lenses: vscode.CodeLens[] = [];

        this.hiddenCodeMap.forEach((_, range) => {
            lenses.push(
                new vscode.CodeLens(range, {
                    title: "Show Hidden Code",
                    command: "coducate.showCode",
                    arguments: [range],
                })
            );
        });

        return lenses;
    }

    public hideCode(
        range: vscode.Range,
        code: string,
        editor: vscode.TextEditor
    ) {
        this.hiddenCodeMap.set(range, code);

        // Create a decoration to indicate hidden code
        const decoration = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: "/* Hidden Code */",
                color: "#999999",
                fontStyle: "italic",
            },
        });

        editor.setDecorations(decoration, [range]);
        this.decorations.push(decoration);
    }

    public showCode(range: vscode.Range): string | undefined {
        const code = this.hiddenCodeMap.get(range);
        this.hiddenCodeMap.delete(range);
        return code;
    }

    // Getter method to access the hidden code
    public getHiddenCode(range: vscode.Range): string | undefined {
        return this.hiddenCodeMap.get(range);
    }

    // Method to retrieve all hidden ranges
    public getHiddenRanges(): vscode.Range[] {
        return Array.from(this.hiddenCodeMap.keys());
    }

    public clearDecorations(editor: vscode.TextEditor) {
        this.decorations.forEach((decoration) => {
            editor.setDecorations(decoration, []);
        });
        this.decorations = [];
    }
}
