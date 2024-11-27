import * as vscode from "vscode";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import { WebSocket } from "ws";
import { SessionManager } from "./SessionManager";
import { CaptureTerminal } from "./CaptureTerminal";

const ROOM_ID_KEY = "coducateRoomId";

export function activate(context: vscode.ExtensionContext) {
    console.log("Coducate extension is now active.");
    let sessionManager: SessionManager | undefined;

    // Create the status bar item
    let status = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    status.text = "$(sync-ignored) Coducate";
    status.color = "#fff";
    status.show();
    context.subscriptions.push(status);

    // Restore session if a roomId exists
    const roomId = context.globalState.get<string>(ROOM_ID_KEY);
    if (roomId) {
        sessionManager = initializeSession(context, roomId, status, true);
    }

    // Register commands
    registerCommands(context, {
        sessionManager,
        status,
    });
}

/**
 * Initialize the live coding session for the given room ID.
 */
function initializeSession(
    context: vscode.ExtensionContext,
    roomId: string,
    status: vscode.StatusBarItem,
    wasConnected: boolean
): SessionManager {
    const sessionManager = new SessionManager(
        "ws://localhost:1234/yjs",
        "ws://localhost:1234/control",
        roomId,
        context
    );

    context.subscriptions.push(sessionManager);

    status.text = "$(sync) Coducate";
    status.tooltip = roomId;
    status.command = {
        title: "Copy Room ID",
        command: "coducate.copyRoomId",
        arguments: [roomId],
    };

    if (wasConnected) {
        vscode.window.showInformationMessage(
            "Live coding session restored. Room ID: " + roomId
        );
    } else {
        vscode.window.showInformationMessage(
            "Live coding session started. Room ID: " + roomId
        );
    }

    // Capture the currently active file in the editor
    const activeEditor = vscode.window.activeTextEditor;
    const activeFilePath = activeEditor?.document.fileName;
    const relativeFilePath = activeFilePath
        ? sessionManager.getRelativeFilePath(activeFilePath)
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

    sessionManager
        .getAwareness()
        .setLocalStateField("vsCodeClient", clientState);

    // Send the currently active file to the server if available
    const controlWebSocket = sessionManager.getControlWebSocket();
    if (controlWebSocket.readyState === WebSocket.OPEN) {
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
                console.log(`Instructor file sent: ${relativeFilePath}`);
            } catch (error) {
                vscode.window.showErrorMessage(
                    "Failed to send instructor file: " +
                        (error as Error).message
                );
            }
        }
    } else if (controlWebSocket.readyState === WebSocket.CONNECTING) {
        controlWebSocket.addEventListener("open", async () => {
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
                    console.log(`Instructor file sent: ${relativeFilePath}`);
                } catch (error) {
                    vscode.window.showErrorMessage(
                        "Failed to send instructor file: " +
                            (error as Error).message
                    );
                }
            }
        });
    } else {
        vscode.window.showErrorMessage(
            "WebSocket connection is not available."
        );
    }
    return sessionManager;
}

/**
 * Register all commands for the extension.
 */
function registerCommands(
    context: vscode.ExtensionContext,
    deps: {
        sessionManager?: SessionManager;
        status: vscode.StatusBarItem;
    }
) {
    let { sessionManager, status } = deps;
    const startCommand = vscode.commands.registerCommand(
        "coducate.startSession",
        async () => {
            // Check if a WebSocket session is already running
            if (sessionManager) {
                vscode.window.showInformationMessage(
                    "A live coding session is already running."
                );
                status.text = "$(sync) Coducate";
                return;
            }

            // Prompt user for a password
            const password = await vscode.window.showInputBox({
                prompt: "Enter a password for this session",
                placeHolder: "A password is required to secure the session",
                password: true,
            });

            if (!password) {
                vscode.window.showErrorMessage("Password cannot be empty.");
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
            const newRoomId = Math.random().toString(36).substring(2, 10);
            context.globalState.update(ROOM_ID_KEY, newRoomId); // Store the new roomId in globalState

            sessionManager = initializeSession(
                context,
                newRoomId,
                status,
                false
            );

            // Path for coducateSetup.jsonc file in the /tmp directory
            const setupFilePath = path.join(
                os.tmpdir(),
                `coducateSetup_${newRoomId}.jsonc`
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

            await sessionManager.addTemporaryFileToYMap(
                `coducateSetup_${newRoomId}.jsonc`
            );

            // Securely hash the password before sending
            if (password && sessionManager.getControlWebSocket()) {
                const controlWebSocket = sessionManager.getControlWebSocket();

                if (controlWebSocket.readyState === WebSocket.OPEN) {
                    try {
                        const passwordSuccessfullySet = await sendPassword(
                            controlWebSocket,
                            password,
                            newRoomId
                        );
                        if (passwordSuccessfullySet) {
                            vscode.window.showInformationMessage(
                                "Room password set securely."
                            );
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            "Failed to set room password securely."
                        );
                    }
                } else if (
                    controlWebSocket.readyState === WebSocket.CONNECTING
                ) {
                    controlWebSocket.addEventListener("open", async () => {
                        try {
                            const passwordSuccessfullySet = await sendPassword(
                                controlWebSocket,
                                password,
                                newRoomId
                            );
                            if (passwordSuccessfullySet) {
                                vscode.window.showInformationMessage(
                                    "Room password set securely."
                                );
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(
                                "Failed to set room password securely."
                            );
                        }
                    });
                } else {
                    vscode.window.showErrorMessage(
                        "WebSocket connection is not available. Please try again."
                    );
                }
            } else {
                vscode.window.showErrorMessage(
                    "Failed to set room password securely. WebSocket is not initialized."
                );
            }
        }
    );

    // Helper function to send the password
    async function sendPassword(
        controlWebSocket: WebSocket,
        password: string,
        roomId: string
    ) {
        return new Promise(async (resolve, reject) => {
            const handleAccessResponse = (message: string) => {
                try {
                    const { type, payload } = JSON.parse(message);
                    if (
                        type === "roomPasswordSetResponse" &&
                        payload.roomId === sessionManager?.getRoomId()
                    ) {
                        // Access granted/denied from server response
                        resolve(true);
                        console.log("Room password successfully set");
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

            // Send password to server
            controlWebSocket.send(
                JSON.stringify({
                    type: "setRoomPassword",
                    payload: {
                        roomId,
                        password,
                    },
                })
            );

            // Add a timeout to resolve/reject in case of no response
            setTimeout(() => {
                reject(new Error("Set room password timed out"));
            }, 5000); // 5 seconds timeout
        });
    }

    const endCommand = vscode.commands.registerCommand(
        "coducate.endSession",
        () => {
            if (sessionManager) {
                sessionManager.dispose();
                sessionManager = undefined;
                status.text = "$(sync-ignored) Coducate";
                context.globalState.update(ROOM_ID_KEY, undefined);
                vscode.window.showInformationMessage(
                    "Live coding session ended."
                );
            } else {
                vscode.window.showInformationMessage(
                    "No live coding session is running."
                );
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
                sessionManager &&
                sessionManager.getControlWebSocket()
            ) {
                const checkAccess = async () => {
                    return new Promise((resolve, reject) => {
                        const controlWebSocket =
                            sessionManager?.getControlWebSocket();
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
                                            sessionManager?.getRoomId()
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
                                        roomId: sessionManager?.getRoomId(),
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
                sessionManager &&
                sessionManager.getControlWebSocket()
            ) {
                const checkAccess = async () => {
                    return new Promise((resolve, reject) => {
                        const controlWebSocket =
                            sessionManager?.getControlWebSocket();
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
                                            sessionManager?.getRoomId()
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
                                        roomId: sessionManager?.getRoomId(),
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

            if (!sessionManager) {
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
                        new CaptureTerminal(sessionManager!)
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
            if (sessionManager && sessionManager.getControlWebSocket()) {
                const checkConnectionAndOpenTerminal = async () => {
                    return new Promise((resolve, reject) => {
                        const controlWebSocket =
                            sessionManager?.getControlWebSocket();

                        if (controlWebSocket?.readyState === WebSocket.OPEN) {
                            const handleResponse = (message: string) => {
                                try {
                                    const { type, payload } =
                                        JSON.parse(message);
                                    if (
                                        type === "terminalOpened" &&
                                        payload.roomId ===
                                            sessionManager?.getRoomId()
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
                                        roomId: sessionManager?.getRoomId(),
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
            if (sessionManager && sessionManager.getControlWebSocket()) {
                const checkConnectionAndCloseTerminal = async () => {
                    return new Promise((resolve, reject) => {
                        const controlWebSocket =
                            sessionManager?.getControlWebSocket();

                        if (controlWebSocket?.readyState === WebSocket.OPEN) {
                            const handleResponse = (message: string) => {
                                try {
                                    const { type, payload } =
                                        JSON.parse(message);
                                    if (
                                        type === "terminalClosed" &&
                                        payload.roomId ===
                                            sessionManager?.getRoomId()
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
                                        roomId: sessionManager?.getRoomId(),
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

    // Command to request explorer open
    const requestExplorerOpen = vscode.commands.registerCommand(
        "coducate.requestExplorerOpen",
        async () => {
            if (sessionManager && sessionManager.getControlWebSocket()) {
                const checkConnectionAndOpenTerminal = async () => {
                    return new Promise((resolve, reject) => {
                        const controlWebSocket =
                            sessionManager?.getControlWebSocket();

                        if (controlWebSocket?.readyState === WebSocket.OPEN) {
                            const handleResponse = (message: string) => {
                                try {
                                    const { type, payload } =
                                        JSON.parse(message);
                                    if (
                                        type === "explorerOpened" &&
                                        payload.roomId ===
                                            sessionManager?.getRoomId()
                                    ) {
                                        resolve(true);
                                        console.log(
                                            "Explorer opened successfully"
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
                                    type: "requestExplorerOpen",
                                    payload: {
                                        roomId: sessionManager?.getRoomId(),
                                    },
                                })
                            );

                            // Timeout in case of no response
                            setTimeout(() => {
                                reject(
                                    new Error("Explorer open request timed out")
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
                            "Explorer opened successfully."
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
    const requestExplorerClose = vscode.commands.registerCommand(
        "coducate.requestExplorerClose",
        async () => {
            if (sessionManager && sessionManager.getControlWebSocket()) {
                const checkConnectionAndCloseTerminal = async () => {
                    return new Promise((resolve, reject) => {
                        const controlWebSocket =
                            sessionManager?.getControlWebSocket();

                        if (controlWebSocket?.readyState === WebSocket.OPEN) {
                            const handleResponse = (message: string) => {
                                try {
                                    const { type, payload } =
                                        JSON.parse(message);
                                    if (
                                        type === "explorerClosed" &&
                                        payload.roomId ===
                                            sessionManager?.getRoomId()
                                    ) {
                                        resolve(true);
                                        console.log(
                                            "Explorer closed successfully"
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
                                    type: "requestExplorerClose",
                                    payload: {
                                        roomId: sessionManager?.getRoomId(),
                                    },
                                })
                            );

                            // Timeout in case of no response
                            setTimeout(() => {
                                reject(
                                    new Error(
                                        "Explorer close request timed out"
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
                            "Explorer closed successfully."
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

    const adjustFontSizeCommand = vscode.commands.registerCommand(
        "coducate.adjustFontSize",
        async () => {
            // Create a persistent QuickPick panel
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = [
                { label: "Increase Font Size" },
                { label: "Decrease Font Size" },
            ];
            quickPick.title = "Adjust Font Size";
            quickPick.placeholder =
                "Select an action. Press Esc or click on editor to close the panel.";
            quickPick.buttons = [vscode.QuickInputButtons.Back]; // Add a close button

            quickPick.onDidTriggerButton(() => {
                quickPick.hide();
            });

            quickPick.onDidChangeSelection(async (selection) => {
                if (!selection[0]) {
                    return;
                }

                const choice = selection[0].label;

                if (sessionManager && sessionManager.getControlWebSocket()) {
                    const checkAccess = async () => {
                        return new Promise((resolve, reject) => {
                            const controlWebSocket =
                                sessionManager?.getControlWebSocket();
                            if (
                                controlWebSocket?.readyState === WebSocket.OPEN
                            ) {
                                const handleAccessResponse = (
                                    message: string
                                ) => {
                                    try {
                                        const { type, payload } =
                                            JSON.parse(message);
                                        if (
                                            type === "fontSizeChanged" &&
                                            payload.roomId ===
                                                sessionManager?.getRoomId()
                                        ) {
                                            resolve(true);
                                        }
                                    } catch {
                                        // Ignore invalid JSON messages
                                    }
                                };

                                controlWebSocket.onmessage = (event) => {
                                    try {
                                        handleAccessResponse(
                                            event.data.toString()
                                        );
                                    } catch {
                                        // Ignore invalid JSON messages
                                    }
                                };

                                controlWebSocket.send(
                                    JSON.stringify({
                                        type: "requestFontSizeChange",
                                        payload: {
                                            roomId: sessionManager?.getRoomId(),
                                            increase:
                                                choice === "Increase Font Size",
                                        },
                                    })
                                );

                                setTimeout(() => {
                                    reject(
                                        new Error("Font size change timed out")
                                    );
                                }, 5000); // 5 seconds timeout
                            } else {
                                reject(
                                    new Error(
                                        "WebSocket connection is not open"
                                    )
                                );
                            }
                        });
                    };

                    try {
                        const fontSizeChanged = await checkAccess();
                        if (fontSizeChanged) {
                            vscode.window.showInformationMessage(
                                `Font size successfully ${
                                    choice === "inc" ? "increased" : "decreased"
                                }.`
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
            });

            // Show the QuickPick
            quickPick.show();
        }
    );

    // Command to create notes from selected text and delete the entire lines
    const createNotesCommand = vscode.commands.registerCommand(
        "coducate.createNote",
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const selection = editor.selection;
                const filePath = editor.document.uri.fsPath;

                if (!selection.isEmpty) {
                    const title = await vscode.window.showInputBox({
                        prompt: "Enter a title for the note",
                        placeHolder: "e.g., Check if input is valid",
                    });

                    if (!title) {
                        vscode.window.showWarningMessage(
                            "Note title cannot be empty."
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

                    const notesCodeLensProvider =
                        sessionManager?.getNotesCodeLensProvider();

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

                    notesCodeLensProvider?.refresh();
                } else {
                    vscode.window.showInformationMessage("No code selected.");
                }
            }
        }
    );

    const handleNoteActionCommand = vscode.commands.registerCommand(
        "coducate.handleNoteAction",
        async (filePath: string, line: number) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage("No active editor found.");
                return;
            }

            const notesCodeLensProvider =
                sessionManager?.getNotesCodeLensProvider();

            const notes = notesCodeLensProvider?.storedNotes[filePath];
            if (!notes) {
                vscode.window.showErrorMessage("No notes found for this file.");
                return;
            }

            const note = notes.find((n) => n.line === line);
            if (!note) {
                vscode.window.showErrorMessage("Note not found.");
                return;
            }

            // Prompt the user for an action
            const choice = await vscode.window.showQuickPick(
                [
                    { label: "Insert at Cursor", value: "insert" },
                    { label: "Delete Note", value: "delete" },
                ],
                { placeHolder: "What do you want to do with this note?" }
            );

            if (!choice) {
                return; // User canceled
            }

            if (choice.value === "insert") {
                const cursorPosition = editor.selection.active;
                const cursorLineStartPosition = new vscode.Position(
                    cursorPosition.line,
                    0
                );
                await editor.edit((editBuilder) => {
                    editBuilder.insert(cursorLineStartPosition, note.code);
                });
                const numberOfLines = note.code.split("\n").length;
                vscode.window.showInformationMessage(
                    `Code restored at lines ${
                        cursorLineStartPosition.line + 1
                    } to ${cursorLineStartPosition.line + numberOfLines}.`
                );
            } else if (choice.value === "delete") {
                // Delete the note
                notesCodeLensProvider?.removeNote(filePath, line);
                vscode.window.showInformationMessage("Note deleted.");
            }
        }
    );

    const removeNoteCommand = vscode.commands.registerCommand(
        "coducate.removeNote",
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage("No active editor found.");
                return;
            }

            const filePath = editor.document.uri.fsPath;

            const choice = await vscode.window.showQuickPick(
                [
                    { label: "Remove all notes in this file", value: "file" },
                    {
                        label: "Remove all notes in the workspace",
                        value: "workspace",
                    },
                ],
                { placeHolder: "Choose an option to remove notes" }
            );

            if (!choice) {
                return; // User canceled
            }

            const notesCodeLensProvider =
                sessionManager?.getNotesCodeLensProvider();

            if (choice.value === "file") {
                notesCodeLensProvider?.removeAllNotesInFile(filePath);
            } else if (choice.value === "workspace") {
                notesCodeLensProvider?.removeAllNotesInWorkspace();
            }
        }
    );

    // Command to toggle suggestions on or off
    const toggleSuggestionsCommand = vscode.commands.registerCommand(
        "coducate.toggleSuggestions",
        () => {
            const inlineCompletionProvider =
                sessionManager?.getInlineCompletionProvider();

            const suggestionsEnabled =
                inlineCompletionProvider?.toggleSuggestions();
            vscode.window.showInformationMessage(
                `Code suggestions ${
                    suggestionsEnabled ? "enabled" : "disabled"
                }.`
            );
        }
    );

    context.subscriptions.push(
        startCommand,
        endCommand,
        copyRoomIdCommand,
        grantWriteAccessCommand,
        revokeWriteAccessCommand,
        emulateTerminalCommand,
        requestTerminalOpenCommand,
        requestTerminalCloseCommand,
        requestExplorerOpen,
        requestExplorerClose,
        adjustFontSizeCommand,
        createNotesCommand,
        handleNoteActionCommand,
        removeNoteCommand,
        toggleSuggestionsCommand
    );
}

export function deactivate() {
    console.log("Coducate extension is now deactivated.");
}
