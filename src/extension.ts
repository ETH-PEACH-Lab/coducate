import * as vscode from "vscode";
import path from "path";
import {
    uniqueNamesGenerator,
    adjectives,
    colors,
    animals,
} from "unique-names-generator";
import { WebSocket } from "ws";
import { SessionManager } from "./SessionManager";
import { CaptureTerminal } from "./CaptureTerminal";

const ROOM_ID_KEY = "coducateRoomId";

// Determine environment
const PRODUCTION = true;

// Define backend host for HTTP API requests
const BACKEND_HOST = PRODUCTION
    ? "https://delta.peachhub-cntr1.inf.ethz.ch"
    : "http://localhost:1234"; // Development environment

// Define WebSocket protocol and host
const WEBSOCKET_PROTOCOL = PRODUCTION ? "wss" : "ws";
const WEBSOCKET_HOST = PRODUCTION
    ? "delta.peachhub-cntr1.inf.ethz.ch"
    : "localhost:1234";

// Define WebSocket URLs
const YJS_WEBSOCKET_URL = `${WEBSOCKET_PROTOCOL}://${WEBSOCKET_HOST}/yjs`;
const CONTROL_WEBSOCKET_URL = (roomId: string) =>
    `${WEBSOCKET_PROTOCOL}://${WEBSOCKET_HOST}/control?roomId=${roomId}`;

enum SessionType {
    NEW_SESSION = 1,
    EXISTING_SESSION = 2,
    RESTORED_SESSION = 3,
}

export function activate(context: vscode.ExtensionContext) {
    // console.log("Coducate extension is now active.");
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

    // Prompt to enable diffEditor.codeLens setting
    const config = vscode.workspace.getConfiguration("diffEditor");
    const currentValue = config.get<boolean>("codeLens");

    if (!currentValue) {
        vscode.window
            .showInformationMessage(
                "To accept/reject changes made by web clients, enable 'diffEditor.codeLens'.",
                { modal: true },
                "Enable"
            )
            .then((selection) => {
                if (selection === "Enable") {
                    config
                        .update(
                            "codeLens",
                            true,
                            vscode.ConfigurationTarget.Global
                        )
                        .then(
                            () => {
                                vscode.window.showInformationMessage(
                                    "'diffEditor.codeLens' has been enabled."
                                );
                            },
                            (error) => {
                                vscode.window.showErrorMessage(
                                    "Failed to enable 'diffEditor.codeLens'."
                                );
                            }
                        );
                }
            });
    }

    // Restore session if a roomId exists
    const roomId = context.workspaceState.get<string>(ROOM_ID_KEY);
    if (roomId) {
        sessionManager = initializeSession(
            context,
            roomId,
            status,
            SessionType.RESTORED_SESSION
        );
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
    sessionType: SessionType
): SessionManager {
    const sessionManager = new SessionManager(
        YJS_WEBSOCKET_URL,
        CONTROL_WEBSOCKET_URL(roomId),
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

    const showRoomIdMessage = (message: string) => {
        vscode.window
            .showInformationMessage(message, "Copy Room ID")
            .then((selection) => {
                if (selection === "Copy Room ID") {
                    vscode.env.clipboard.writeText(roomId).then(() => {
                        vscode.window.showInformationMessage(
                            "Room ID copied to clipboard!"
                        );
                    });
                }
            });
    };

    if (sessionType === SessionType.RESTORED_SESSION) {
        showRoomIdMessage("Live coding session restored. Room ID: " + roomId);
    } else if (sessionType === SessionType.NEW_SESSION) {
        showRoomIdMessage("Live coding session started. Room ID: " + roomId);
    } else if (sessionType === SessionType.EXISTING_SESSION) {
        showRoomIdMessage("Live coding session joined. Room ID: " + roomId);
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
                vscode.window.showErrorMessage(
                    "A live coding session is already running."
                );
                status.text = "$(sync) Coducate";
                return;
            }

            const sessionType = await vscode.window.showQuickPick(
                ["New Session", "Existing Session"],
                {
                    placeHolder: "Choose session type",
                }
            );

            if (!sessionType) {
                return;
            }

            if (sessionType === "New Session") {
                const alreadyExistingSessions =
                    context.globalState.get<{
                        [key: string]: { roomId: string; password: string };
                    }>("coducate.sessions") || {};
                let sessionName;
                do {
                    sessionName = await vscode.window.showInputBox({
                        prompt:
                            sessionName && alreadyExistingSessions[sessionName]
                                ? `The session name '${sessionName}' already exists. Enter a different name or use the Manage Sessions command to delete the existing session.`
                                : "Enter an easy-to-remember session name",
                        placeHolder: "E.g., 'Computer Systems Lecture 10'",
                    });

                    if (sessionName === "") {
                        vscode.window.showErrorMessage(
                            "Session name cannot be empty."
                        );
                        return;
                    } else if (!sessionName) {
                        return;
                    }
                } while (alreadyExistingSessions[sessionName]);

                // Prompt user for a password
                const password = await vscode.window.showInputBox({
                    prompt: "Enter a password for this session",
                    placeHolder: "A password is required to secure the session",
                    password: true,
                });

                if (password === "") {
                    vscode.window.showErrorMessage("Password cannot be empty.");
                    return;
                } else if (!password) {
                    return;
                }

                const taskDescriptionAction = await vscode.window.showQuickPick(
                    ["Yes", "No"],
                    {
                        placeHolder:
                            "Would you like to add a task description? (Markdown file)",
                    }
                );

                if (taskDescriptionAction === undefined) {
                    // vscode.window.showErrorMessage("Selection is required.");
                    return;
                }

                let taskDescriptionPath: vscode.Uri | undefined;
                if (taskDescriptionAction === "Yes") {
                    const taskDescriptionPaths =
                        await vscode.window.showOpenDialog({
                            canSelectFiles: true,
                            canSelectFolders: false,
                            filters: {
                                Markdown: ["md"],
                            },
                            title: "Select task description file",
                            openLabel: "Select as task description",
                        });

                    if (
                        !taskDescriptionPaths ||
                        taskDescriptionPaths.length === 0
                    ) {
                        vscode.window.showErrorMessage(
                            "You must select a task description Markdown file."
                        );
                        return;
                    }

                    taskDescriptionPath = taskDescriptionPaths[0];
                }

                const learningGoalsAction = await vscode.window.showQuickPick(
                    ["Yes", "No"],
                    {
                        placeHolder:
                            "Would you like to add learning goals? (Markdown file)",
                    }
                );

                if (learningGoalsAction === undefined) {
                    // vscode.window.showErrorMessage("Selection is required.");
                    return;
                }

                let learningGoalsPath: vscode.Uri | undefined;
                if (learningGoalsAction === "Yes") {
                    const learningGoalsPaths =
                        await vscode.window.showOpenDialog({
                            canSelectFiles: true,
                            canSelectFolders: false,
                            filters: {
                                Markdown: ["md"],
                            },
                            title: "Select learning goals file",
                            openLabel: "Select as learning goals",
                        });

                    if (
                        !learningGoalsPaths ||
                        learningGoalsPaths.length === 0
                    ) {
                        vscode.window.showErrorMessage(
                            "You must select a learning goals Markdown file."
                        );
                        return;
                    }

                    learningGoalsPath = learningGoalsPaths[0];
                }

                let newRoomId: string | undefined;
                let isRoomIdValid = false;
                while (!(isRoomIdValid && newRoomId)) {
                    newRoomId = uniqueNamesGenerator({
                        dictionaries: [adjectives, colors, animals],
                    });

                    try {
                        isRoomIdValid = !(await isRoomExisting(newRoomId));
                    } catch (error) {
                        // console.log("Error generating room ID: " + error);
                        vscode.window.showErrorMessage(
                            "Error generating room ID: " +
                                (error as Error).message
                        );
                        return;
                    }
                }

                context.workspaceState.update(ROOM_ID_KEY, newRoomId);

                // Store the mapping of session name to room ID and password
                const existingSessions =
                    context.globalState.get<{
                        [key: string]: { roomId: string; password: string };
                    }>("coducate.sessions") || {};
                existingSessions[sessionName] = { roomId: newRoomId, password };

                try {
                    await context.globalState.update(
                        "coducate.sessions",
                        existingSessions
                    );
                } catch (error) {
                    vscode.window.showErrorMessage(
                        "Failed to store session mappings."
                    );
                    return;
                }

                sessionManager = initializeSession(
                    context,
                    newRoomId,
                    status,
                    SessionType.NEW_SESSION
                );

                if (taskDescriptionPath) {
                    try {
                        await sessionManager.addFileToYMap(
                            path.posix.normalize(taskDescriptionPath.fsPath),
                            path.posix.normalize(taskDescriptionPath.fsPath)
                        );
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            "Failed to add task description."
                        );

                        // End the session if the task description fails to load
                        sessionManager.dispose();
                        sessionManager = undefined;
                        status.text = "$(sync-ignored) Coducate";
                        context.workspaceState.update(ROOM_ID_KEY, undefined);

                        return;
                    }
                }

                if (learningGoalsPath) {
                    try {
                        await sessionManager.addFileToYMap(
                            path.posix.normalize(learningGoalsPath.fsPath),
                            path.posix.normalize(learningGoalsPath.fsPath)
                        );
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            "Failed to add learning goals."
                        );

                        // End the session if the learning goals fail to load
                        sessionManager.dispose();
                        sessionManager = undefined;
                        status.text = "$(sync-ignored) Coducate";
                        context.workspaceState.update(ROOM_ID_KEY, undefined);

                        return;
                    }
                }

                if (password && sessionManager.getControlWebSocket()) {
                    const controlWebSocket =
                        sessionManager.getControlWebSocket();

                    if (controlWebSocket.readyState === WebSocket.OPEN) {
                        try {
                            await sendSessionData(
                                controlWebSocket,
                                password,
                                taskDescriptionPath
                                    ? path.posix.normalize(
                                          taskDescriptionPath.fsPath
                                      )
                                    : "",
                                learningGoalsPath
                                    ? path.posix.normalize(
                                          learningGoalsPath.fsPath
                                      )
                                    : "",
                                newRoomId
                            );
                        } catch (error) {
                            vscode.window.showErrorMessage(
                                "Failed to set room password securely."
                            );

                            // End the session if the password fails to set
                            sessionManager.dispose();
                            sessionManager = undefined;
                            status.text = "$(sync-ignored) Coducate";
                            context.workspaceState.update(
                                ROOM_ID_KEY,
                                undefined
                            );

                            return;
                        }
                    } else if (
                        controlWebSocket.readyState === WebSocket.CONNECTING
                    ) {
                        controlWebSocket.addEventListener("open", async () => {
                            try {
                                await sendSessionData(
                                    controlWebSocket,
                                    password,
                                    taskDescriptionPath
                                        ? path.posix.normalize(
                                              taskDescriptionPath.fsPath
                                          )
                                        : "",
                                    learningGoalsPath
                                        ? path.posix.normalize(
                                              learningGoalsPath.fsPath
                                          )
                                        : "",
                                    newRoomId
                                );
                            } catch (error) {
                                vscode.window.showErrorMessage(
                                    "Failed to set room password securely."
                                );

                                // End the session if the password fails to set
                                sessionManager?.dispose();
                                sessionManager = undefined;
                                status.text = "$(sync-ignored) Coducate";
                                context.workspaceState.update(
                                    ROOM_ID_KEY,
                                    undefined
                                );

                                return;
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
            } else if (sessionType === "Existing Session") {
                // Retrieve the stored session mappings
                const existingSessions =
                    context.globalState.get<{
                        [key: string]: { roomId: string; password: string };
                    }>("coducate.sessions") || {};

                // Convert sessions to a displayable list
                const sessionChoices = Object.entries(existingSessions).map(
                    ([name, { roomId }]) => ({
                        label: name,
                        description: roomId,
                    })
                );

                if (sessionChoices.length === 0) {
                    vscode.window.showErrorMessage(
                        "No existing sessions found. Please create a new session first."
                    );
                    return;
                }

                const selectedSession = await vscode.window.showQuickPick(
                    sessionChoices,
                    {
                        placeHolder: "Select an existing session",
                    }
                );

                if (!selectedSession) {
                    return;
                }

                const selectedSessionName = selectedSession.label;
                const roomId = selectedSession.description;
                const password = existingSessions[selectedSessionName].password;

                let isPasswordValid = false;
                try {
                    isPasswordValid = await verifyPassword(password, roomId);
                } catch (error) {
                    vscode.window.showErrorMessage(
                        "Error verifying password: " + (error as Error).message
                    );
                    return;
                }

                if (!isPasswordValid) {
                    vscode.window.showErrorMessage(
                        "Invalid Room ID or Password."
                    );
                    return;
                }

                context.workspaceState.update(ROOM_ID_KEY, roomId);

                sessionManager = initializeSession(
                    context,
                    roomId,
                    status,
                    SessionType.EXISTING_SESSION
                );
            }
        }
    );

    // Helper function to verify the password
    async function verifyPassword(password: string, roomId: string) {
        const response = await fetch(`${BACKEND_HOST}/api/verify-password`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ password, roomId }),
        });

        if (response.ok) {
            const data = await response.json();
            return data.success;
        }
    }

    // Helper function to check if the room ID already exists
    async function isRoomExisting(roomId: string) {
        const response = await fetch(`${BACKEND_HOST}/api/verify-room`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ roomId }),
        });

        if (response.ok) {
            const data = await response.json();
            return data.success;
        }
    }

    // Helper function to send the session data to the server
    async function sendSessionData(
        controlWebSocket: WebSocket,
        password: string,
        taskDescriptionPath: string,
        learningGoalsPath: string,
        roomId: string
    ) {
        return new Promise(async (resolve, reject) => {
            const handleServerResponse = (message: string) => {
                try {
                    const { type, payload } = JSON.parse(message);
                    if (
                        type === "sessionDataSetResponse" &&
                        payload.roomId === sessionManager?.getRoomId()
                    ) {
                        resolve(true);
                    }
                } catch {
                    // Ignore invalid JSON messages
                }
            };

            controlWebSocket.onmessage = (event) => {
                try {
                    handleServerResponse(event.data.toString());
                } catch {
                    // Ignore invalid JSON messages
                }
            };

            // Send password to server
            controlWebSocket.send(
                JSON.stringify({
                    type: "setSessionData",
                    payload: {
                        roomId,
                        password,
                        taskDescriptionPath,
                        learningGoalsPath,
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
                context.workspaceState.update(ROOM_ID_KEY, undefined);
                vscode.window.showInformationMessage(
                    "Live coding session ended."
                );
            } else {
                vscode.window.showErrorMessage("No active session found.");
            }
        }
    );

    const manageSessionsCommand = vscode.commands.registerCommand(
        "coducate.manageSessions",
        async () => {
            // Retrieve the stored session name-to-room ID-password mappings
            let existingSessions =
                context.globalState.get<{
                    [key: string]: { roomId: string; password: string };
                }>("coducate.sessions") || {};

            if (Object.keys(existingSessions).length === 0) {
                vscode.window.showInformationMessage(
                    "No sessions available to manage."
                );
                return;
            }

            while (true) {
                // Convert sessions to a displayable list
                const sessionChoices = Object.entries(existingSessions).map(
                    ([name, { roomId }]) => ({
                        label: name,
                        description: roomId,
                    })
                );

                // Add an "Exit" option
                sessionChoices.push({
                    label: "Exit",
                    description: "",
                });

                if (sessionChoices.length === 0) {
                    vscode.window.showInformationMessage(
                        "All sessions have been deleted."
                    );
                    return;
                }

                const selectedSession = await vscode.window.showQuickPick(
                    sessionChoices,
                    {
                        placeHolder:
                            "Select a session to manage, or choose 'Exit' to finish managing sessions",
                    }
                );

                if (!selectedSession || selectedSession.label === "Exit") {
                    return;
                }

                const selectedSessionName = selectedSession.label;

                const sessionActions = await vscode.window.showQuickPick(
                    [
                        "Show password",
                        "Rename Session",
                        "Delete Session",
                        "Cancel",
                    ],
                    {
                        placeHolder: `What would you like to do with '${selectedSessionName}'?`,
                    }
                );

                if (!sessionActions || sessionActions === "Cancel") {
                    continue; // Go back to the session list
                }

                if (sessionActions === "Show password") {
                    const sessionData = existingSessions[selectedSessionName];
                    if (!sessionData) {
                        vscode.window.showErrorMessage(
                            "Session data not found."
                        );
                        continue;
                    }
                    const password = sessionData.password;

                    const copyToClipboard =
                        await vscode.window.showInformationMessage(
                            `Password for '${selectedSessionName}': ${password}`,
                            "Copy to Clipboard"
                        );

                    if (copyToClipboard === "Copy to Clipboard") {
                        await vscode.env.clipboard.writeText(password);
                        vscode.window.showInformationMessage(
                            "Password copied to clipboard."
                        );
                        return;
                    }
                } else if (sessionActions === "Rename Session") {
                    const newSessionName = await vscode.window.showInputBox({
                        prompt: `Enter a new name for the session '${selectedSessionName}'`,
                        placeHolder: "New session name",
                        value: selectedSessionName,
                    });

                    if (!newSessionName) {
                        vscode.window.showWarningMessage(
                            "Session was not renamed."
                        );
                        continue;
                    }

                    // Rename the session
                    const sessionData = existingSessions[selectedSessionName];
                    delete existingSessions[selectedSessionName];
                    existingSessions[newSessionName] = sessionData;

                    await context.globalState.update(
                        "coducate.sessions",
                        existingSessions
                    );
                    vscode.window.showInformationMessage(
                        `Session '${selectedSessionName}' renamed to '${newSessionName}'.`
                    );
                } else if (sessionActions === "Delete Session") {
                    const confirmDelete = await vscode.window.showQuickPick(
                        ["Yes", "No"],
                        {
                            placeHolder: `Are you sure you want to delete the session '${selectedSessionName}'?`,
                        }
                    );

                    if (confirmDelete === "Yes") {
                        // Delete the selected session
                        delete existingSessions[selectedSessionName];
                        await context.globalState.update(
                            "coducate.sessions",
                            existingSessions
                        );

                        vscode.window.showInformationMessage(
                            `Session '${selectedSessionName}' deleted successfully.`
                        );
                    } else {
                        vscode.window.showWarningMessage(
                            `Cancelled deletion. No changes were made.`
                        );
                    }
                }
            }
        }
    );

    // Command to copy the roomId to the clipboard
    const copyRoomIdCommand = vscode.commands.registerCommand(
        "coducate.copyRoomId",
        (roomId: string) => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            vscode.env.clipboard.writeText(roomId);
            vscode.window.showInformationMessage("Room ID copied to clipboard");
        }
    );

    // Command to grant write access to a user
    const grantWriteAccessCommand = vscode.commands.registerCommand(
        "coducate.grantWriteAccess",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            const grantAccessLoop = async () => {
                const decision = await vscode.window.showQuickPick(
                    [
                        "Grant write access to a specific client",
                        "Grant write access to all clients",
                    ],
                    {
                        placeHolder: "Choose how to grant write access",
                    }
                );

                const controlWebSocket = sessionManager?.getControlWebSocket();
                const roomId = sessionManager?.getRoomId();

                if (!controlWebSocket || !roomId) {
                    vscode.window.showErrorMessage(
                        "Session or WebSocket connection is not active."
                    );
                    return;
                }

                // Retrieve the stored map from globalState
                const storedData =
                    context.globalState.get<string>("roomAccessMap");
                const roomAccessMap: Map<string, Set<string>> = storedData
                    ? new Map(
                          JSON.parse(storedData).map(
                              ([key, value]: [string, string[]]) => [
                                  key,
                                  new Set(value), // Convert array to Set
                              ]
                          )
                      )
                    : new Map();

                const clientSet = roomAccessMap.get(roomId) || new Set();

                if (decision === "Grant write access to a specific client") {
                    while (true) {
                        const targetSimpleID = await vscode.window.showInputBox(
                            {
                                prompt: "Enter the user ID to grant write access",
                                placeHolder: "Enter user ID",
                            }
                        );

                        if (targetSimpleID === undefined) {
                            return;
                        }

                        if (targetSimpleID !== undefined) {
                            if (targetSimpleID.trim() === "") {
                                vscode.window.showErrorMessage(
                                    "No user ID entered."
                                );
                                continue;
                            }

                            const grantAccessSpecific = async () => {
                                return new Promise<boolean>(
                                    (resolve, reject) => {
                                        if (
                                            controlWebSocket.readyState ===
                                            WebSocket.OPEN
                                        ) {
                                            const handleServerResponse = (
                                                message: string
                                            ) => {
                                                try {
                                                    const { type, payload } =
                                                        JSON.parse(message);
                                                    if (
                                                        type ===
                                                            "accessGranted" &&
                                                        payload.simpleID ===
                                                            targetSimpleID &&
                                                        payload.roomId ===
                                                            roomId
                                                    ) {
                                                        resolve(true);
                                                    }
                                                } catch {
                                                    // Ignore invalid JSON messages
                                                }
                                            };

                                            controlWebSocket.onmessage = (
                                                event
                                            ) => {
                                                try {
                                                    handleServerResponse(
                                                        event.data.toString()
                                                    );
                                                } catch {
                                                    // Ignore invalid JSON messages
                                                }
                                            };

                                            controlWebSocket.send(
                                                JSON.stringify({
                                                    type: "grantAccess",
                                                    payload: {
                                                        roomId,
                                                        targetSimpleID,
                                                    },
                                                })
                                            );

                                            setTimeout(() => {
                                                reject(
                                                    new Error(
                                                        `Access check timed out. User ID ${targetSimpleID} may not exist.`
                                                    )
                                                );
                                            }, 5000); // 5 seconds timeout
                                        } else {
                                            reject(
                                                new Error(
                                                    "WebSocket connection is not open"
                                                )
                                            );
                                        }
                                    }
                                );
                            };

                            try {
                                const accessGranted =
                                    await grantAccessSpecific();
                                if (accessGranted) {
                                    // Add the user ID to the roomAccessMap
                                    clientSet.add(targetSimpleID);
                                    roomAccessMap.set(roomId, clientSet);
                                    const serializedMap = JSON.stringify(
                                        Array.from(roomAccessMap.entries()).map(
                                            ([key, value]) => [
                                                key,
                                                Array.from(value), // Convert Sets to arrays for serialization
                                            ]
                                        )
                                    );

                                    await context.globalState.update(
                                        "roomAccessMap",
                                        serializedMap
                                    );

                                    vscode.window.showInformationMessage(
                                        `Write access granted to user ID: ${targetSimpleID}`
                                    );
                                }
                            } catch (error) {
                                vscode.window.showErrorMessage(
                                    error instanceof Error
                                        ? error.message
                                        : String(error)
                                );
                            }
                        }
                    }
                } else if (decision === "Grant write access to all clients") {
                    const confirmation = await vscode.window.showQuickPick(
                        ["Yes", "No"],
                        {
                            placeHolder:
                                "Are you sure you want to grant write access to all clients?",
                        }
                    );

                    if (confirmation === "No" || !confirmation) {
                        await grantAccessLoop(); // Restart the process
                        return;
                    }

                    const grantAccessAll = async () => {
                        return new Promise<string[] | null>(
                            (resolve, reject) => {
                                if (
                                    controlWebSocket.readyState ===
                                    WebSocket.OPEN
                                ) {
                                    const handleServerResponse = (
                                        message: string
                                    ) => {
                                        try {
                                            const { type, payload } =
                                                JSON.parse(message);
                                            if (
                                                type === "accessGranted" &&
                                                payload.roomId === roomId &&
                                                Array.isArray(payload.simpleID)
                                            ) {
                                                resolve(
                                                    payload.simpleID.map(String)
                                                ); // Convert to string array before resolving
                                            }
                                        } catch {
                                            // Ignore invalid JSON messages
                                        }
                                    };

                                    controlWebSocket.onmessage = (event) => {
                                        try {
                                            handleServerResponse(
                                                event.data.toString()
                                            );
                                        } catch {
                                            // Ignore invalid JSON messages
                                        }
                                    };

                                    controlWebSocket.send(
                                        JSON.stringify({
                                            type: "grantAccess",
                                            payload: {
                                                roomId,
                                                targetSimpleID: null,
                                            },
                                        })
                                    );

                                    setTimeout(() => {
                                        reject(
                                            new Error(
                                                "Access grant timed out for all clients"
                                            )
                                        );
                                    }, 5000); // 5 seconds timeout
                                } else {
                                    reject(
                                        new Error(
                                            "WebSocket connection is not open"
                                        )
                                    );
                                }
                            }
                        );
                    };

                    try {
                        const grantedClientIDs = await grantAccessAll();
                        if (grantedClientIDs) {
                            // Add all client IDs to the roomAccessMap
                            for (const clientID of grantedClientIDs) {
                                clientSet.add(clientID);
                            }
                            roomAccessMap.set(roomId, clientSet);
                            const serializedMap = JSON.stringify(
                                Array.from(roomAccessMap.entries()).map(
                                    ([key, value]) => [
                                        key,
                                        Array.from(value), // Convert Sets to arrays for serialization
                                    ]
                                )
                            );

                            await context.globalState.update(
                                "roomAccessMap",
                                serializedMap
                            );

                            vscode.window.showInformationMessage(
                                `Write access granted to all clients (${grantedClientIDs.length} clients).`
                            );
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            error instanceof Error
                                ? error.message
                                : String(error)
                        );
                    }
                }
            };

            await grantAccessLoop();
        }
    );

    // Command to revoke write access from a user
    const revokeWriteAccessCommand = vscode.commands.registerCommand(
        "coducate.revokeWriteAccess",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            // Ask the user if they want to revoke access for all users or a specific user
            const revokeChoice = await vscode.window.showQuickPick(
                [
                    "Revoke access for a specific user",
                    "Revoke access for all users",
                ],
                {
                    placeHolder: "Choose how to revoke write access",
                }
            );

            const controlWebSocket = sessionManager.getControlWebSocket();
            const roomId = sessionManager.getRoomId();

            if (!controlWebSocket || !roomId) {
                vscode.window.showErrorMessage(
                    "Session or WebSocket connection is not active."
                );
                return;
            }

            // Retrieve the stored map from globalState
            const storedData = context.globalState.get<string>("roomAccessMap");
            const roomAccessMap: Map<string, Set<string>> = storedData
                ? new Map(
                      JSON.parse(storedData).map(
                          ([key, value]: [string, string[]]) => [
                              key,
                              new Set(value), // Convert array to Set
                          ]
                      )
                  )
                : new Map();

            // Get the client set for the current room or initialize a new Set
            const clientSet = roomAccessMap.get(roomId) || new Set();

            if (revokeChoice === "Revoke access for a specific user") {
                while (true) {
                    // Convert the Set to an array for quick pick
                    const clientList = Array.from(clientSet);

                    // Ask the user to choose a client ID from the list or input manually
                    const targetSimpleID = await vscode.window.showQuickPick(
                        [...clientList, "Type a user ID manually"],
                        {
                            placeHolder:
                                "Choose a user ID to revoke or type manually",
                        }
                    );

                    let finalSimpleID = targetSimpleID;

                    if (targetSimpleID === "Type a user ID manually") {
                        finalSimpleID = await vscode.window.showInputBox({
                            prompt: "Enter the user ID to revoke write access",
                            placeHolder: "Enter user ID",
                        });
                    }

                    if (finalSimpleID === undefined) {
                        return;
                    }

                    if (finalSimpleID !== undefined) {
                        if (finalSimpleID.trim() === "") {
                            vscode.window.showErrorMessage(
                                "No user ID entered."
                            );
                            continue;
                        }
                        const revokeSpecific = async () => {
                            return new Promise<boolean>((resolve, reject) => {
                                if (
                                    controlWebSocket.readyState ===
                                    WebSocket.OPEN
                                ) {
                                    // Define a unique message event handler to listen for the response
                                    const handleServerResponse = (
                                        message: string
                                    ) => {
                                        try {
                                            const { type, payload } =
                                                JSON.parse(message);
                                            if (
                                                type === "accessRevoked" &&
                                                payload.simpleID ===
                                                    finalSimpleID &&
                                                payload.roomId === roomId
                                            ) {
                                                resolve(true);
                                            }
                                        } catch {
                                            // Ignore invalid JSON messages
                                        }
                                    };

                                    controlWebSocket.onmessage = (event) => {
                                        try {
                                            handleServerResponse(
                                                event.data.toString()
                                            );
                                        } catch {
                                            // Ignore invalid JSON messages
                                        }
                                    };

                                    controlWebSocket.send(
                                        JSON.stringify({
                                            type: "revokeAccess",
                                            payload: {
                                                roomId,
                                                targetSimpleID: finalSimpleID,
                                            },
                                        })
                                    );

                                    // Add a timeout to resolve/reject in case of no response
                                    setTimeout(() => {
                                        reject(
                                            new Error("Access check timed out")
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
                            const accessRevoked = await revokeSpecific();
                            if (accessRevoked) {
                                // Remove the specific user from the roomAccessMap
                                clientSet.delete(finalSimpleID);
                                roomAccessMap.set(roomId, clientSet);
                                const serializedMap = JSON.stringify(
                                    Array.from(roomAccessMap.entries()).map(
                                        ([key, value]) => [
                                            key,
                                            Array.from(value), // Convert Set back to array for serialization
                                        ]
                                    )
                                );

                                await context.globalState.update(
                                    "roomAccessMap",
                                    serializedMap
                                );

                                vscode.window.showInformationMessage(
                                    `Write access revoked from user ID: ${finalSimpleID}`
                                );
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(
                                error instanceof Error
                                    ? error.message
                                    : String(error)
                            );
                        }
                    } else {
                        vscode.window.showErrorMessage("No user ID entered.");
                    }
                }
            } else if (revokeChoice === "Revoke access for all users") {
                const revokeAll = async () => {
                    return new Promise<boolean>((resolve, reject) => {
                        if (controlWebSocket.readyState === WebSocket.OPEN) {
                            // Define a unique message event handler to listen for the response
                            const handleServerResponse = (message: string) => {
                                try {
                                    const { type, payload } =
                                        JSON.parse(message);
                                    if (
                                        type === "accessRevoked" &&
                                        payload.roomId === roomId &&
                                        payload.simpleID === null
                                    ) {
                                        resolve(true);
                                    }
                                } catch {
                                    // Ignore invalid JSON messages
                                }
                            };

                            controlWebSocket.onmessage = (event) => {
                                try {
                                    handleServerResponse(event.data.toString());
                                } catch {
                                    // Ignore invalid JSON messages
                                }
                            };

                            controlWebSocket.send(
                                JSON.stringify({
                                    type: "revokeAccess",
                                    payload: { roomId, targetSimpleID: null },
                                })
                            );

                            // Add a timeout to resolve/reject in case of no response
                            setTimeout(() => {
                                reject(
                                    new Error(
                                        "Revocation for all clients timed out"
                                    )
                                );
                            }, 5000); // 5 seconds timeout
                        } else {
                            reject(
                                new Error("WebSocket connection is not open")
                            );
                        }
                    });
                };

                try {
                    const accessRevoked = await revokeAll();
                    if (accessRevoked) {
                        // Clear the roomAccessMap for the current room
                        roomAccessMap.set(roomId, new Set());
                        const serializedMap = JSON.stringify(
                            Array.from(roomAccessMap.entries()).map(
                                ([key, value]) => [
                                    key,
                                    Array.from(value), // Convert Set to array for serialization
                                ]
                            )
                        );

                        await context.globalState.update(
                            "roomAccessMap",
                            serializedMap
                        );

                        vscode.window.showInformationMessage(
                            "Write access revoked for all users in this room."
                        );
                    }
                } catch (error) {
                    vscode.window.showErrorMessage(
                        error instanceof Error ? error.message : String(error)
                    );
                }
            }
        }
    );

    const emulateTerminalCommand = vscode.commands.registerCommand(
        "coducate.emulateTerminal",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

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
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

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
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

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
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            if (sessionManager && sessionManager.getControlWebSocket()) {
                const checkConnectionAndOpenExplorer = async () => {
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
                        await checkConnectionAndOpenExplorer();
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
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

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
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

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
                                const handleServerResponse = (
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
                                        handleServerResponse(
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

    // Command to toggle theme
    const changeThemeCommand = vscode.commands.registerCommand(
        "coducate.changeTheme",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            if (sessionManager && sessionManager.getControlWebSocket()) {
                // Prompt user to select theme
                const theme = await vscode.window.showQuickPick(
                    ["Dark", "Light"],
                    {
                        placeHolder: "Select theme",
                    }
                );

                if (!theme) {
                    return;
                }

                const selectedTheme = theme.toLowerCase();

                const sendThemeChangeRequest = async () => {
                    return new Promise((resolve, reject) => {
                        const controlWebSocket =
                            sessionManager?.getControlWebSocket();

                        if (controlWebSocket?.readyState === WebSocket.OPEN) {
                            const handleResponse = (message: string) => {
                                try {
                                    const { type, payload } =
                                        JSON.parse(message);
                                    if (
                                        type === "themeChanged" &&
                                        payload.changedTheme ===
                                            selectedTheme &&
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
                                    handleResponse(event.data.toString());
                                } catch {
                                    // Ignore invalid messages
                                }
                            };

                            controlWebSocket.send(
                                JSON.stringify({
                                    type: "requestThemeChange",
                                    payload: {
                                        changedTheme: selectedTheme,
                                        roomId: sessionManager?.getRoomId(),
                                    },
                                })
                            );

                            // Timeout in case of no response
                            setTimeout(() => {
                                reject(
                                    new Error("Theme toggle request timed out")
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
                    const themeToggled = await sendThemeChangeRequest();
                    if (themeToggled) {
                        vscode.window.showInformationMessage(
                            `Theme toggled to ${theme} mode successfully.`
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
        "coducate.createNote",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const selection = editor.selection;
                const filePath = editor.document.uri.fsPath;

                if (!selection.isEmpty) {
                    const title = await vscode.window.showInputBox({
                        prompt: "Enter a title for the note",
                        placeHolder: "e.g., Check if user input is valid",
                    });

                    if (!title) {
                        vscode.window.showErrorMessage(
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
                    vscode.window.showWarningMessage("No code selected.");
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
                return; // User cancelled
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
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

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
                return; // User cancelled
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
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

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
        manageSessionsCommand,
        copyRoomIdCommand,
        grantWriteAccessCommand,
        revokeWriteAccessCommand,
        emulateTerminalCommand,
        requestTerminalOpenCommand,
        requestTerminalCloseCommand,
        requestExplorerOpen,
        requestExplorerClose,
        adjustFontSizeCommand,
        changeThemeCommand,
        createNotesCommand,
        handleNoteActionCommand,
        removeNoteCommand,
        toggleSuggestionsCommand
    );
}

export function deactivate() {
    // console.log("Coducate extension is now deactivated.");
}
