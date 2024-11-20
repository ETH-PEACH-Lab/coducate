import * as vscode from "vscode";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import { WebSocket, Event } from "ws";
import { DisposableWebSocket } from "./DisposableWebSocket";
import { CaptureTerminal } from "./CaptureTerminal";
import { HideCodeLensProvider } from "./HideCodeLensProvider";
import { HideCodeHoverProvider } from "./HideCodeHoverProvider";
import { NotesCodeLensProvider } from "./NotesCodeLensProvider";
import { renderPrompt } from "@vscode/prompt-tsx";
import { AutocompletePrompt } from "./AutocompletePrompt";

let disposableWebSocket: DisposableWebSocket | undefined;
const ROOM_ID_KEY = "coducateRoomId";

// Create a status bar item
const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
);
status.text = "$(sync-ignored) Coducate";
status.color = "#fff";
status.show();

// CodeLens Provider for hiding code
const hideCodeLensProvider = new HideCodeLensProvider();

// CodeLens Provider for notes
let notesCodeLensProvider: NotesCodeLensProvider | undefined;
let cachedResponse: { [filePath: string]: string | null } = {};
let suggestionsEnabled = false;

export function activate(context: vscode.ExtensionContext) {
    status.text = "$(sync-ignored) Coducate";
    let roomId = context.globalState.get<string>(ROOM_ID_KEY);

    // Restore the live coding session if a roomId exists in globalState
    if (roomId) {
        disposableWebSocket = new DisposableWebSocket(
            "ws://localhost:1234/yjs",
            "ws://localhost:1234/control",
            roomId,
            context
        );
        context.subscriptions.push(disposableWebSocket);
        status.text = "$(sync) Coducate";
        vscode.window.showInformationMessage(
            "Live coding session restored. Room ID: " + roomId
        );

        // Show the roomId in the status bar, make it large on hover
        status.tooltip = roomId;
        status.command = {
            title: "Copy Room ID",
            command: "coducate.copyRoomId",
            arguments: [roomId],
        };

        // Capture the currently active file in the editor
        const activeEditor = vscode.window.activeTextEditor;
        const activeFilePath = activeEditor?.document.fileName;
        const relativeFilePath = activeFilePath
            ? disposableWebSocket.getRelativeFilePath(activeFilePath)
            : null;

        // Get cursor and selection positions
        const position = activeEditor?.selections[0].active;
        const selection = activeEditor?.selections[0];
        const clientState = {
            filePath: relativeFilePath,
            cursorPosition: {
                line: position?.line,
                column: position?.character,
            },
            selectionRange: {
                start: {
                    line: selection?.start.line,
                    column: selection?.start.character,
                },
                end: {
                    line: selection?.end.line,
                    column: selection?.end.character,
                },
            },
        };

        disposableWebSocket
            .getAwareness()
            .setLocalStateField("vsCodeClient", clientState);

        // Send the currently active file to the server if available
        const controlWebSocket = disposableWebSocket.getWebControlWebSocket();

        if (controlWebSocket) {
            // Attach an onopen event handler to send the instructor file once the connection is open
            controlWebSocket.onopen = () => {
                console.log("WebSocket connection opened.");
                if (
                    relativeFilePath &&
                    disposableWebSocket?.getFileYMap().has(relativeFilePath)
                ) {
                    try {
                        controlWebSocket.send(
                            JSON.stringify({
                                type: "setInstructorFile",
                                payload: {
                                    roomId: roomId,
                                    instructorFile: relativeFilePath,
                                },
                            })
                        );
                        console.log(
                            `Instructor file sent: ${relativeFilePath}`
                        );
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            "Failed to send instructor file: " +
                                (error as Error).message
                        );
                        console.error("Error sending instructor file:", error);
                    }
                }
            };

            // If the WebSocket is already open, trigger the onopen event manually
            if (controlWebSocket.readyState === WebSocket.OPEN) {
                const mockEvent: Event = {
                    target: controlWebSocket,
                } as Event;
                controlWebSocket.onopen(mockEvent);
            }
        } else {
            vscode.window.showErrorMessage(
                "WebSocket connection is not available."
            );
        }

        // Load the notesCodeLensProvider
        notesCodeLensProvider = new NotesCodeLensProvider(context, roomId);
    }

    const startCommand = vscode.commands.registerCommand(
        "coducate.startSession",
        async () => {
            // Check if a WebSocket session is already running
            if (disposableWebSocket) {
                vscode.window.showInformationMessage(
                    "A live coding session is already running."
                );
                status.text = "$(sync) Coducate";
                return;
            }

            // Prompt user for task description and learning goals
            const taskDescription = await vscode.window.showInputBox({
                prompt: "Enter the task description",
                placeHolder:
                    "e.g., Simulate a simple bank account system with deposits and withdrawals.",
            });
            const learningGoalsInput = await vscode.window.showInputBox({
                prompt: "Enter learning goals (comma-separated)",
                placeHolder:
                    "e.g., Object-oriented Programming, State Management, Error Handling",
            });

            // Convert learning goals to an array
            const learningGoals = learningGoalsInput
                ? learningGoalsInput.split(",").map((goal) => goal.trim())
                : [];

            // Generate a new roomId
            let roomId = Math.random().toString(36).substring(2, 10);
            context.globalState.update(ROOM_ID_KEY, roomId); // Store the new roomId in globalState

            // Initialize the WebSocket connection
            disposableWebSocket = new DisposableWebSocket(
                "ws://localhost:1234/yjs",
                "ws://localhost:1234/control",
                roomId,
                context
            );

            // Capture the currently active file in the editor
            const activeEditor = vscode.window.activeTextEditor;
            const activeFilePath = activeEditor?.document.fileName;
            const relativeFilePath = activeFilePath
                ? disposableWebSocket.getRelativeFilePath(activeFilePath)
                : null;

            // Get cursor and selection positions
            const position = activeEditor?.selections[0].active;
            const selection = activeEditor?.selections[0];
            const clientState = {
                filePath: relativeFilePath,
                cursorPosition: {
                    line: position?.line,
                    column: position?.character,
                },
                selectionRange: {
                    start: {
                        line: selection?.start.line,
                        column: selection?.start.character,
                    },
                    end: {
                        line: selection?.end.line,
                        column: selection?.end.character,
                    },
                },
            };

            disposableWebSocket
                .getAwareness()
                .setLocalStateField("vsCodeClient", clientState);

            context.subscriptions.push(disposableWebSocket);
            status.text = "$(sync) Coducate";
            vscode.window.showInformationMessage(
                "Live coding session started. Room ID: " + roomId
            );

            // Show the roomId in the status bar, make it large on hover
            status.tooltip = roomId;
            status.command = {
                title: "Copy Room ID",
                command: "coducate.copyRoomId",
                arguments: [roomId],
            };

            // Path for coducateSetup.jsonc file in the /tmp directory
            const setupFilePath = path.join(os.tmpdir(), "coducateSetup.jsonc");

            // Create JSON content with comments
            const setupContent = `// This file contains the setup for task description and learning goals.
// If edited, a browser refresh is required to see the changes.

{
  "taskDescription": ${JSON.stringify(taskDescription)},
  "learningGoals": ${JSON.stringify(learningGoals)}
}`;

            // Write the content to coducateSetup.jsonc
            fs.writeFileSync(setupFilePath, setupContent);

            await disposableWebSocket.addTemporaryFileToYMap(
                "coducateSetup.jsonc"
            );

            // Send the currently active file to the server if available
            const controlWebSocket =
                disposableWebSocket.getWebControlWebSocket();

            if (controlWebSocket) {
                // Attach an onopen event handler to send the instructor file once the connection is open
                controlWebSocket.onopen = () => {
                    console.log("WebSocket connection opened.");
                    if (
                        relativeFilePath &&
                        disposableWebSocket?.getFileYMap().has(relativeFilePath)
                    ) {
                        try {
                            controlWebSocket.send(
                                JSON.stringify({
                                    type: "setInstructorFile",
                                    payload: {
                                        roomId: roomId,
                                        instructorFile: relativeFilePath,
                                    },
                                })
                            );
                            console.log(
                                `Instructor file sent: ${relativeFilePath}`
                            );
                        } catch (error) {
                            vscode.window.showErrorMessage(
                                "Failed to send instructor file: " +
                                    (error as Error).message
                            );
                            console.error(
                                "Error sending instructor file:",
                                error
                            );
                        }
                    }
                };

                // If the WebSocket is already open, trigger the onopen event manually
                if (controlWebSocket.readyState === WebSocket.OPEN) {
                    const mockEvent: Event = {
                        target: controlWebSocket,
                    } as Event;
                    controlWebSocket.onopen(mockEvent);
                }
            } else {
                vscode.window.showErrorMessage(
                    "WebSocket connection is not available."
                );
            }
        }
    );

    const endCommand = vscode.commands.registerCommand(
        "coducate.endSession",
        () => {
            if (disposableWebSocket) {
                disposableWebSocket.dispose();
                disposableWebSocket = undefined;
                status.text = "$(sync-ignored) Coducate"; // Update status bar to inactive state
                console.log("Live coding session ended.");

                // Clear the stored roomId from globalState
                context.globalState.update(ROOM_ID_KEY, undefined);
            } else {
                console.log("No live coding session is running.");
                status.text = "$(sync-ignored) Coducate";
            }
        }
    );

    // Command to hide selected code
    const hideCodeCommand = vscode.commands.registerCommand(
        "coducate.hideCode",
        () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const selection = editor.selection;
                if (!selection.isEmpty) {
                    // Create a range that includes entire lines, not just the selection
                    const startLine = selection.start.line;
                    const endLine = selection.end.line;

                    // Create a range that starts at the beginning of the first line and ends at the end of the last line
                    const range = new vscode.Range(
                        new vscode.Position(startLine, 0),
                        new vscode.Position(
                            endLine,
                            editor.document.lineAt(endLine).range.end.character
                        )
                    );

                    const selectedCode = editor.document.getText(range);

                    hideCodeLensProvider.hideCode(range, selectedCode, editor);

                    editor.edit((editBuilder) => {
                        editBuilder.delete(range); // Remove the entire lines from the editor
                    });
                    console.log("Code hidden");
                } else {
                    vscode.window.showInformationMessage("No code selected");
                }
            }
        }
    );

    // Command to show hidden code
    const showCodeCommand = vscode.commands.registerCommand(
        "coducate.showCode",
        (range: vscode.Range) => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const hiddenCode = hideCodeLensProvider.showCode(range);
                if (hiddenCode) {
                    editor.edit((editBuilder) => {
                        editBuilder.insert(range.start, hiddenCode); // Insert the hidden code back
                    });
                    hideCodeLensProvider.clearDecorations(editor); // Clear any remaining decorations
                    console.log("Code revealed");
                } else {
                    vscode.window.showInformationMessage("No code to reveal");
                }
            }
        }
    );

    // Command to copy the roomId to the clipboard
    const copyRoomIdCommand = vscode.commands.registerCommand(
        "coducate.copyRoomId",
        (roomId: string) => {
            vscode.env.clipboard.writeText(roomId);
            vscode.window.showInformationMessage("Room ID copied to clipboard");
        }
    );

    // Command to grant write access to a user
    const grantWriteAccessCommand = vscode.commands.registerCommand(
        "coducate.grantWriteAccess",
        async () => {
            const targetSimpleID = await vscode.window.showInputBox({
                prompt: "Enter the user ID to grant write access",
                placeHolder: "Enter user ID",
            });

            if (
                targetSimpleID &&
                disposableWebSocket &&
                disposableWebSocket.getWebControlWebSocket()
            ) {
                const checkAccess = async () => {
                    return new Promise((resolve, reject) => {
                        const controlWebSocket =
                            disposableWebSocket?.getWebControlWebSocket();
                        if (controlWebSocket?.readyState === WebSocket.OPEN) {
                            // Define a unique message event handler to listen for the response
                            const handleAccessResponse = (message: string) => {
                                try {
                                    const { type, payload } =
                                        JSON.parse(message);
                                    if (
                                        type === "accessGranted" &&
                                        payload.simpleID === targetSimpleID &&
                                        payload.roomId ===
                                            disposableWebSocket?.getRoomId()
                                    ) {
                                        // Access granted/denied from server response
                                        resolve(true);
                                        console.log("Access granted");
                                    }
                                } catch {
                                    // Ignore invalid JSON messages
                                }
                            };

                            controlWebSocket.onmessage = (event) => {
                                try {
                                    handleAccessResponse(event.data.toString());
                                } catch {
                                    // Ignore invalid JSON messages
                                }
                            };

                            controlWebSocket.send(
                                JSON.stringify({
                                    type: "grantAccess",
                                    payload: {
                                        roomId: disposableWebSocket?.getRoomId(),
                                        targetSimpleID,
                                    },
                                })
                            );

                            // Add a timeout to resolve/reject in case of no response
                            setTimeout(() => {
                                reject(new Error("Access check timed out"));
                            }, 5000); // 5 seconds timeout
                        } else {
                            reject(
                                new Error("WebSocket connection is not open")
                            );
                        }
                    });
                };

                try {
                    const accessGranted = await checkAccess();
                    if (accessGranted) {
                        vscode.window.showInformationMessage(
                            `Write access granted to user ID: ${targetSimpleID}`
                        );
                    }
                } catch (error) {
                    if (error instanceof Error) {
                        vscode.window.showErrorMessage(error.message);
                    } else {
                        vscode.window.showErrorMessage(String(error));
                    }
                }
            } else {
                vscode.window.showErrorMessage(
                    "Invalid input or session not active."
                );
            }
        }
    );

    // Command to revoke write access from a user
    const revokeWriteAccessCommand = vscode.commands.registerCommand(
        "coducate.revokeWriteAccess",
        async () => {
            const targetSimpleID = await vscode.window.showInputBox({
                prompt: "Enter the user ID to revoke write access",
                placeHolder: "Enter user ID",
            });

            if (
                targetSimpleID &&
                disposableWebSocket &&
                disposableWebSocket.getWebControlWebSocket()
            ) {
                const checkAccess = async () => {
                    return new Promise((resolve, reject) => {
                        const controlWebSocket =
                            disposableWebSocket?.getWebControlWebSocket();
                        if (controlWebSocket?.readyState === WebSocket.OPEN) {
                            // Define a unique message event handler to listen for the response
                            const handleAccessResponse = (message: string) => {
                                try {
                                    const { type, payload } =
                                        JSON.parse(message);
                                    if (
                                        type === "accessRevoked" &&
                                        payload.simpleID === targetSimpleID &&
                                        payload.roomId ===
                                            disposableWebSocket?.getRoomId()
                                    ) {
                                        // Access granted/denied from server response
                                        resolve(true);
                                        console.log("Access revoked");
                                    }
                                } catch {
                                    // Ignore invalid JSON messages
                                }
                            };

                            controlWebSocket.onmessage = (event) => {
                                try {
                                    handleAccessResponse(event.data.toString());
                                } catch {
                                    // Ignore invalid JSON messages
                                }
                            };

                            controlWebSocket.send(
                                JSON.stringify({
                                    type: "revokeAccess",
                                    payload: {
                                        roomId: disposableWebSocket?.getRoomId(),
                                        targetSimpleID,
                                    },
                                })
                            );

                            // Add a timeout to resolve/reject in case of no response
                            setTimeout(() => {
                                reject(new Error("Access check timed out"));
                            }, 5000); // 5 seconds timeout
                        } else {
                            reject(
                                new Error("WebSocket connection is not open")
                            );
                        }
                    });
                };

                try {
                    const accessGranted = await checkAccess();
                    if (accessGranted) {
                        vscode.window.showInformationMessage(
                            `Write access revoked from user ID: ${targetSimpleID}`
                        );
                    }
                } catch (error) {
                    if (error instanceof Error) {
                        vscode.window.showErrorMessage(error.message);
                    } else {
                        vscode.window.showErrorMessage(String(error));
                    }
                }
            } else {
                vscode.window.showErrorMessage(
                    "Invalid input or session not active."
                );
            }
        }
    );

    const emulateTerminalCommand = vscode.commands.registerCommand(
        "coducate.emulateTerminal",
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage("No active editor to run code.");
                return;
            }

            const document = editor.document;

            if (!disposableWebSocket) {
                vscode.window.showErrorMessage("WebSocket is not initialized.");
                return;
            }

            const task = new vscode.Task(
                { type: "runBash" },
                vscode.TaskScope.Workspace,
                "Running Bash",
                "Emulated Terminal",
                new vscode.CustomExecution(
                    async (): Promise<vscode.Pseudoterminal> =>
                        new CaptureTerminal(disposableWebSocket!)
                ),
                []
            );

            vscode.tasks.executeTask(task);

            // Request the terminal to open
            vscode.commands.executeCommand("coducate.requestTerminalOpen");
        }
    );

    // Command to request terminal open
    const requestTerminalOpenCommand = vscode.commands.registerCommand(
        "coducate.requestTerminalOpen",
        async () => {
            if (
                disposableWebSocket &&
                disposableWebSocket.getWebControlWebSocket()
            ) {
                const checkConnectionAndOpenTerminal = async () => {
                    return new Promise((resolve, reject) => {
                        const controlWebSocket =
                            disposableWebSocket?.getWebControlWebSocket();

                        if (controlWebSocket?.readyState === WebSocket.OPEN) {
                            const handleResponse = (message: string) => {
                                try {
                                    const { type, payload } =
                                        JSON.parse(message);
                                    if (
                                        type === "terminalOpened" &&
                                        payload.roomId ===
                                            disposableWebSocket?.getRoomId()
                                    ) {
                                        resolve(true);
                                        console.log(
                                            "Terminal opened successfully"
                                        );
                                    }
                                } catch {
                                    // Ignore invalid JSON messages
                                }
                            };

                            controlWebSocket.onmessage = (event) => {
                                try {
                                    handleResponse(event.data.toString());
                                } catch {
                                    // Ignore invalid messages
                                }
                            };

                            controlWebSocket.send(
                                JSON.stringify({
                                    type: "requestTerminalOpen",
                                    payload: {
                                        roomId: disposableWebSocket?.getRoomId(),
                                    },
                                })
                            );

                            // Timeout in case of no response
                            setTimeout(() => {
                                reject(
                                    new Error("Terminal open request timed out")
                                );
                            }, 5000);
                        } else {
                            reject(
                                new Error("WebSocket connection is not open")
                            );
                        }
                    });
                };

                try {
                    const terminalOpened =
                        await checkConnectionAndOpenTerminal();
                    if (terminalOpened) {
                        vscode.window.showInformationMessage(
                            "Terminal opened successfully."
                        );
                    }
                } catch (error) {
                    if (error instanceof Error) {
                        vscode.window.showErrorMessage(error.message);
                    } else {
                        vscode.window.showErrorMessage(String(error));
                    }
                }
            } else {
                vscode.window.showErrorMessage(
                    "WebSocket connection is not active."
                );
            }
        }
    );

    // Command to request terminal close
    const requestTerminalCloseCommand = vscode.commands.registerCommand(
        "coducate.requestTerminalClose",
        async () => {
            if (
                disposableWebSocket &&
                disposableWebSocket.getWebControlWebSocket()
            ) {
                const checkConnectionAndCloseTerminal = async () => {
                    return new Promise((resolve, reject) => {
                        const controlWebSocket =
                            disposableWebSocket?.getWebControlWebSocket();

                        if (controlWebSocket?.readyState === WebSocket.OPEN) {
                            const handleResponse = (message: string) => {
                                try {
                                    const { type, payload } =
                                        JSON.parse(message);
                                    if (
                                        type === "terminalClosed" &&
                                        payload.roomId ===
                                            disposableWebSocket?.getRoomId()
                                    ) {
                                        resolve(true);
                                        console.log(
                                            "Terminal closed successfully"
                                        );
                                    }
                                } catch {
                                    // Ignore invalid JSON messages
                                }
                            };

                            controlWebSocket.onmessage = (event) => {
                                try {
                                    handleResponse(event.data.toString());
                                } catch {
                                    // Ignore invalid messages
                                }
                            };

                            controlWebSocket.send(
                                JSON.stringify({
                                    type: "requestTerminalClose",
                                    payload: {
                                        roomId: disposableWebSocket?.getRoomId(),
                                    },
                                })
                            );

                            // Timeout in case of no response
                            setTimeout(() => {
                                reject(
                                    new Error(
                                        "Terminal close request timed out"
                                    )
                                );
                            }, 5000);
                        } else {
                            reject(
                                new Error("WebSocket connection is not open")
                            );
                        }
                    });
                };

                try {
                    const terminalClosed =
                        await checkConnectionAndCloseTerminal();
                    if (terminalClosed) {
                        vscode.window.showInformationMessage(
                            "Terminal closed successfully."
                        );
                    }
                } catch (error) {
                    if (error instanceof Error) {
                        vscode.window.showErrorMessage(error.message);
                    } else {
                        vscode.window.showErrorMessage(String(error));
                    }
                }
            } else {
                vscode.window.showErrorMessage(
                    "WebSocket connection is not active."
                );
            }
        }
    );

    // Command to create notes from selected text and delete the entire lines
    const createNotesCommand = vscode.commands.registerCommand(
        "coducate.createNotes",
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const selection = editor.selection;
                const filePath = editor.document.uri.fsPath;

                if (!selection.isEmpty) {
                    const title = await vscode.window.showInputBox({
                        prompt: "Enter a title for the CodeLens",
                        placeHolder: "Notes available",
                    });

                    if (!title) {
                        vscode.window.showWarningMessage(
                            "CodeLens title cannot be empty."
                        );
                        return;
                    }

                    const startLine = selection.start.line;
                    const endLine = selection.end.line;

                    const fullLineRange = new vscode.Range(
                        new vscode.Position(startLine, 0),
                        new vscode.Position(
                            endLine,
                            editor.document.lineAt(endLine).range.end.character
                        )
                    );
                    const selectedCode = editor.document.getText(fullLineRange);

                    // Add the note using the NotesCodeLensProvider's method
                    notesCodeLensProvider?.addNote(filePath, {
                        line: startLine,
                        code: selectedCode,
                        title: title,
                    });

                    // Delete the selected lines in the editor
                    await editor.edit((editBuilder) => {
                        editBuilder.delete(fullLineRange);
                    });

                    vscode.window.showInformationMessage(
                        `Notes created at lines ${startLine + 1} to ${
                            endLine + 1
                        }.`
                    );
                    vscode.commands.executeCommand("coducate.refreshCodeLens");
                } else {
                    vscode.window.showInformationMessage("No code selected.");
                }
            }
        }
    );

    // Command to restore code from the note
    const restoreNoteCommand = vscode.commands.registerCommand(
        "coducate.restoreNote",
        async (filePath: string, line: number) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }

            const notes = notesCodeLensProvider?.storedNotes[filePath];
            if (!notes) {
                return;
            }

            const noteIndex = notes.findIndex((n) => n.line === line);
            if (noteIndex === -1) {
                return;
            }

            const note = notes[noteIndex];

            // Get the current cursor position
            const cursorPosition = editor.selection.active;

            // Compute the position of the line start where the cursor is
            const cursorLineStartPosition = new vscode.Position(
                cursorPosition.line,
                0
            );

            // Compute the number of tabs (indention) of the cursor
            const lineText = editor.document.lineAt(cursorPosition.line).text;
            const indentation = lineText.match(/^\t*/)?.[0].length || 0;

            // Adjust the indentation of the note.code based on the current indentation level
            const adjustedCode = note.code.replace(
                /\t/g,
                "\t".repeat(indentation)
            );

            // Insert the code block exactly as it was captured, starting at the current cursor position
            await editor.edit((editBuilder) => {
                editBuilder.insert(cursorLineStartPosition, adjustedCode);
            });

            // Remove the note using the NotesCodeLensProvider's method
            notesCodeLensProvider?.removeNote(filePath, line);

            const numberOfLines = note.code.split("\n").length;
            vscode.window.showInformationMessage(
                `Code restored at lines ${
                    cursorLineStartPosition.line + 1
                } to ${cursorLineStartPosition.line + numberOfLines}.`
            );
        }
    );

    // Register the refresh CodeLens command
    const refreshCodeLensCommand = vscode.commands.registerCommand(
        "coducate.refreshCodeLens",
        () => {
            notesCodeLensProvider?.refresh();
        }
    );

    // Command to toggle suggestions on or off
    const toggleSuggestionsCommand = vscode.commands.registerCommand(
        "coducate.toggleSuggestions",
        () => {
            suggestionsEnabled = !suggestionsEnabled;
            vscode.window.showInformationMessage(
                `Code suggestions ${
                    suggestionsEnabled ? "enabled" : "disabled"
                }.`
            );
        }
    );

    // Function to generate code suggestions using the Language Model API
    async function getLanguageModelSuggestions(
        note: string,
        typedText: string
    ): Promise<string | null> {
        try {
            const models = await vscode.lm.selectChatModels({
                vendor: "copilot",
                family: "gpt-4o-mini",
            });

            if (models.length === 0) {
                vscode.window.showErrorMessage("No language models available.");
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
            console.error("Error fetching suggestions:", err);
            return null;
        }
    }

    // Find the most recent note that is above or on the same line as the current cursor position
    function findRecentNoteAbove(
        filePath: string,
        currentLine: number
    ): { line: number; code: string } | null {
        const notes = notesCodeLensProvider?.storedNotes[filePath];
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

    function startsWithIgnoringWhitespace(
        noteContent: string,
        typedText: string
    ) {
        // Remove all whitespace from both strings
        const normalize = (str: string) => str.replace(/\s+/g, "");
        return normalize(noteContent).startsWith(normalize(typedText));
    }

    function codeDifference(note: string, typedText: string) {
        const cleanNoteContent = note.replace(/[ \t]+\n/g, "\n");
        const cleanTypedText = typedText.replace(/[ \t]+\n/g, "\n");
        return cleanNoteContent
            .trimStart()
            .slice(cleanTypedText.trimStart().length);
    }

    // Inline completion provider using cached suggestions and LLM
    const inlineCompletionProvider: vscode.InlineCompletionItemProvider = {
        async provideInlineCompletionItems(
            document: vscode.TextDocument,
            position: vscode.Position,
            context: vscode.InlineCompletionContext,
            token: vscode.CancellationToken
        ) {
            if (!suggestionsEnabled) {
                return [];
            }

            const filePath = document.uri.fsPath;
            const line = position.line;

            // Find the most recent note that is above or on the same line as the current cursor position
            const recentNote = findRecentNoteAbove(filePath, line);
            if (!recentNote) {
                return [];
            }

            // Capture the user's typed text from the note's starting line to the current cursor position
            const noteStartPosition = new vscode.Position(recentNote.line, 0);
            const typedRange = new vscode.Range(noteStartPosition, position);
            const typedText = document.getText(typedRange);

            console.log("Code (Note Content):\n", recentNote.code);

            const noteSuggestion = recentNote.code;

            // 1. If the user's input matches the stored notes, show the remaining notes
            if (startsWithIgnoringWhitespace(noteSuggestion, typedText)) {
                const trimmedSuggestion = codeDifference(
                    noteSuggestion,
                    typedText
                );
                console.log("*******************************************");
                console.log("Showing suggestion from Notes");
                console.log("Typed text:\n", typedText);
                console.log("Suggestion:\n", noteSuggestion);
                console.log("Trimmed suggestion:\n", trimmedSuggestion);
                console.log("*******************************************");
                const item = new vscode.InlineCompletionItem(trimmedSuggestion);
                item.range = new vscode.Range(position, position);
                return [item];
            }

            // 2. Check the cached LLM suggestion
            const cachedSuggestion = cachedResponse[filePath];
            if (
                cachedSuggestion &&
                startsWithIgnoringWhitespace(cachedSuggestion, typedText)
            ) {
                console.log("*******************************************");
                console.log("Using cached LLM suggestion");
                console.log("Typed text:\n", typedText);

                const trimmedSuggestion = codeDifference(
                    cachedSuggestion,
                    typedText
                );
                console.log("Suggestion (cached):\n", cachedSuggestion);
                console.log("Trimmed suggestion:\n", trimmedSuggestion);
                console.log("*******************************************");
                const item = new vscode.InlineCompletionItem(trimmedSuggestion);
                item.range = new vscode.Range(position, position);
                return [item];
            }

            // 3. Fetch a new LLM suggestion if no valid cached suggestion is available
            const newSuggestion = await getLanguageModelSuggestions(
                noteSuggestion,
                typedText
            );
            if (newSuggestion) {
                console.log("*******************************************");
                console.log("Fetching new LLM Suggestion:\n", newSuggestion);
                console.log("Typed text:\n", typedText);

                if (!startsWithIgnoringWhitespace(newSuggestion, typedText)) {
                    console.log("Drop invalid suggestion");
                    console.log("*******************************************");
                    return;
                }

                const trimmedSuggestion = codeDifference(
                    newSuggestion,
                    typedText
                );

                console.log("Trimmed suggestion:\n", trimmedSuggestion);
                console.log("*******************************************");

                cachedResponse[filePath] = newSuggestion; // Cache the new suggestion
                const item = new vscode.InlineCompletionItem(trimmedSuggestion);
                item.range = new vscode.Range(position, position);
                return [item];
            }

            return [];
        },
    };

    context.subscriptions.push(
        startCommand,
        endCommand,
        hideCodeCommand,
        showCodeCommand,
        copyRoomIdCommand,
        grantWriteAccessCommand,
        revokeWriteAccessCommand,
        emulateTerminalCommand,
        requestTerminalOpenCommand,
        requestTerminalCloseCommand,
        createNotesCommand,
        restoreNoteCommand,
        refreshCodeLensCommand,
        toggleSuggestionsCommand,

        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: "**" },
            inlineCompletionProvider
        ),
        vscode.languages.registerCodeLensProvider(
            { pattern: "**" },
            notesCodeLensProvider!
        ),
        vscode.languages.registerHoverProvider(
            "*",
            new HideCodeHoverProvider(hideCodeLensProvider)
        ),
        vscode.languages.registerCodeLensProvider("*", hideCodeLensProvider)
    );
}

export function deactivate() {
    if (disposableWebSocket) {
        disposableWebSocket.dispose();
        disposableWebSocket = undefined;
    }
    status.text = "$(sync-ignored) Coducate"; // Reset status bar to default when deactivated
    console.log("Extension is now deactivated.");
}
