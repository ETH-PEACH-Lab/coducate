import * as vscode from "vscode";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import { WebSocket, Event } from "ws";
import { DisposableWebSocket } from "./DisposableWebSocket";
import { CaptureTerminal } from "./CaptureTerminal";
import { HideCodeLensProvider } from "./HideCodeLensProvider";
import { HideCodeHoverProvider } from "./HideCodeHoverProvider";

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

export function activate(context: vscode.ExtensionContext) {
    status.text = "$(sync-ignored) Coducate";
    let roomId = context.globalState.get<string>(ROOM_ID_KEY);

    // Restore the live coding session if a roomId exists in globalState
    if (roomId) {
        disposableWebSocket = new DisposableWebSocket(
            "ws://localhost:1234/yjs",
            "ws://localhost:1234/control",
            roomId
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
                if (relativeFilePath) {
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
                roomId
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
                    if (relativeFilePath) {
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
            const filePath = document.uri.fsPath;

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
        requestTerminalCloseCommand
    );

    // Register CodeLens Provider
    const codeLensDisposable = vscode.languages.registerCodeLensProvider(
        "*",
        hideCodeLensProvider
    );
    context.subscriptions.push(codeLensDisposable);

    // Register Hover Provider for previewing hidden code
    const hoverProviderDisposable = vscode.languages.registerHoverProvider(
        "*",
        new HideCodeHoverProvider(hideCodeLensProvider)
    );
    context.subscriptions.push(hoverProviderDisposable);
}

export function deactivate() {
    if (disposableWebSocket) {
        disposableWebSocket.dispose();
        disposableWebSocket = undefined;
    }
    status.text = "$(sync-ignored) Coducate"; // Reset status bar to default when deactivated
    console.log("Extension is now deactivated.");
}
