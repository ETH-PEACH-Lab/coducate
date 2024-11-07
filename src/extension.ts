import * as vscode from "vscode";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import { WebSocket } from "ws";
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
    }

    const startCommand = vscode.commands.registerCommand(
        "coducate.startSession",
        async () => {
            if (!disposableWebSocket) {
                // Prompt user for task description and learning goals
                const taskDescription = await vscode.window.showInputBox({
                    prompt: "Enter the task description",
                    placeHolder: "What is the main goal of this session?",
                });
                const learningGoalsInput = await vscode.window.showInputBox({
                    prompt: "Enter learning goals (comma-separated)",
                    placeHolder: "e.g., React, Input/Output, Unit Testing",
                });

                // Convert learning goals to an array
                const learningGoals = learningGoalsInput
                    ? learningGoalsInput.split(",").map((goal) => goal.trim())
                    : [];

                // Generate a new roomId
                let roomId = Math.random().toString(36).substring(2, 10);
                context.globalState.update(ROOM_ID_KEY, roomId); // Store the new roomId in globalState

                disposableWebSocket = new DisposableWebSocket(
                    "ws://localhost:1234/yjs",
                    "ws://localhost:1234/control",
                    roomId
                );
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
                const setupFilePath = path.join(
                    os.tmpdir(),
                    "coducateSetup.jsonc"
                );

                // Create JSON content with comments
                const setupContent = `// This file contains the setup for task description and learning goals.
// If edited, a browser refresh is required to see the changes.

{
  "taskDescription": ${JSON.stringify(taskDescription)},
  "learningGoals": ${JSON.stringify(learningGoals)}
}`;

                // Write the content to coducateSetup.jsonc
                fs.writeFileSync(setupFilePath, setupContent);

                await disposableWebSocket.addTemporaryFileToYMap(); // Add the /tmp file directly to fileYMap
            } else {
                vscode.window.showInformationMessage(
                    "A live coding session is already running."
                );
                status.text = "$(sync) Coducate";
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
                        if (
                            disposableWebSocket?.getWebControlWebSocket()
                                .readyState === WebSocket.OPEN
                        ) {
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
                                    console.log("Invalid JSON message");
                                }
                            };

                            disposableWebSocket.getWebControlWebSocket().onmessage =
                                (event) => {
                                    try {
                                        handleAccessResponse(
                                            event.data.toString()
                                        );
                                    } catch {
                                        // Ignore invalid JSON messages
                                    }
                                };

                            disposableWebSocket.getWebControlWebSocket().send(
                                JSON.stringify({
                                    type: "grantAccess",
                                    payload: {
                                        roomId: disposableWebSocket.getRoomId(),
                                        targetSimpleID,
                                    },
                                })
                            );

                            // Add a timeout to resolve/reject in case of no response
                            setTimeout(() => {
                                reject(new Error("Access check timed out"));
                            }, 5000); // 5 seconds timeout
                        } else {
                            resolve(false); // Not connected, so no access
                        }
                    });
                };

                const accessGranted = await checkAccess();
                if (accessGranted) {
                    vscode.window.showInformationMessage(
                        `Write access granted to user ID: ${targetSimpleID}`
                    );
                } else {
                    vscode.window.showErrorMessage(
                        `User ID ${targetSimpleID} not found.`
                    );
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
                        if (
                            disposableWebSocket?.getWebControlWebSocket()
                                .readyState === WebSocket.OPEN
                        ) {
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
                                    console.log("Invalid JSON message");
                                }
                            };

                            disposableWebSocket.getWebControlWebSocket().onmessage =
                                (event) => {
                                    try {
                                        handleAccessResponse(
                                            event.data.toString()
                                        );
                                    } catch {
                                        // Ignore invalid JSON messages
                                    }
                                };

                            disposableWebSocket.getWebControlWebSocket().send(
                                JSON.stringify({
                                    type: "revokeAccess",
                                    payload: {
                                        roomId: disposableWebSocket.getRoomId(),
                                        targetSimpleID,
                                    },
                                })
                            );

                            // Add a timeout to resolve/reject in case of no response
                            setTimeout(() => {
                                reject(new Error("Access check timed out"));
                            }, 5000); // 5 seconds timeout
                        } else {
                            resolve(false); // Not connected, so no access
                        }
                    });
                };

                const accessGranted = await checkAccess();
                if (accessGranted) {
                    vscode.window.showInformationMessage(
                        `Write access granted to user ID: ${targetSimpleID}`
                    );
                } else {
                    vscode.window.showErrorMessage(
                        `User ID ${targetSimpleID} not found.`
                    );
                }
            } else {
                vscode.window.showErrorMessage(
                    "Invalid input or session not active."
                );
            }
        }
    );

    const runPythonFile = vscode.commands.registerCommand(
        "coducate.runPythonFile",
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage("No active editor to run code.");
                return;
            }

            const document = editor.document;
            const filePath = document.uri.fsPath;

            const task = new vscode.Task(
                { type: "runPython" },
                vscode.TaskScope.Workspace,
                "Run Python File with Output",
                "custom",
                new vscode.CustomExecution(
                    async (): Promise<vscode.Pseudoterminal> =>
                        new CaptureTerminal(filePath, disposableWebSocket!)
                ),
                []
            );

            vscode.tasks.executeTask(task);
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
        runPythonFile
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
