import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
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

export async function activate(context: vscode.ExtensionContext) {
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

    // Restore the previously opened workspace folders
    const workspaceFolders: string[] | undefined = context.globalState.get(
        "coducate.workspaceFolders"
    );

    if (workspaceFolders && workspaceFolders.length > 0) {
        const foldersToAdd = workspaceFolders.map((folderUriString) => ({
            uri: vscode.Uri.parse(folderUriString),
        }));

        vscode.workspace.updateWorkspaceFolders(
            vscode.workspace.workspaceFolders
                ? vscode.workspace.workspaceFolders.length
                : 0,
            null,
            ...foldersToAdd
        );
    }

    // Restore the previously opened files (this is necessary due to the creation of a new workspace)
    const tabGroupsState = context.globalState.get<
        {
            viewColumn: vscode.ViewColumn;
            tabs: { label: string; isActive: boolean; uri: string }[];
        }[]
    >("coducate.tabGroupsState");

    if (tabGroupsState) {
        try {
            // Restore tabs for each tab group
            for (const group of tabGroupsState) {
                let focusedTabUri: string | undefined;

                for (const tab of group.tabs) {
                    try {
                        // Restore files
                        const document =
                            await vscode.workspace.openTextDocument(
                                vscode.Uri.parse(tab.uri)
                            );
                        await vscode.window.showTextDocument(document, {
                            viewColumn: group.viewColumn,
                            preview: false,
                            preserveFocus: !tab.isActive,
                        });

                        // Mark the active tab for later focus
                        if (tab.isActive) {
                            focusedTabUri = tab.uri;
                        }
                    } catch (error) {
                        // Do not notify the user as this is not of critical importance
                    }
                }

                // After all tabs in the group are opened, set focus to the active tab
                if (focusedTabUri) {
                    try {
                        const focusedDocument =
                            await vscode.workspace.openTextDocument(
                                vscode.Uri.parse(focusedTabUri)
                            );
                        await vscode.window.showTextDocument(focusedDocument, {
                            viewColumn: group.viewColumn,
                            preview: false,
                            preserveFocus: false,
                        });
                    } catch (error) {
                        // Do not notify the user as this is not of critical importance
                    }
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(
                "An error occurred while restoring open editors."
            );
        }
    }

    // Restore session if a roomId exists
    const roomId = context.workspaceState.get<string>(ROOM_ID_KEY);
    if (roomId) {
        const sessionManagerFromInitailization = await initializeSession(
            context,
            roomId,
            status,
            SessionType.RESTORED_SESSION
        );

        if (!sessionManagerFromInitailization) {
            return;
        }

        sessionManager = sessionManagerFromInitailization;
    }

    // Register commands
    registerCommands(context, {
        sessionManager,
        status,
    });

    if (tabGroupsState && !workspaceFolders) {
        // A new session was started so tabGroupsState is available but workspaceFolders is not
        vscode.commands.executeCommand("coducate.startSession");
        await context.globalState.update("coducate.tabGroupsState", undefined);
        await context.globalState.update(
            "coducate.workspaceFolders",
            undefined
        );
    } else {
        // The session was ended or the VS Code window was reloaded
        await context.globalState.update("coducate.tabGroupsState", undefined);
        await context.globalState.update(
            "coducate.workspaceFolders",
            undefined
        );
    }
}

/**
 * Initialize the live coding session for the given room ID.
 */
async function initializeSession(
    context: vscode.ExtensionContext,
    roomId: string,
    status: vscode.StatusBarItem,
    sessionType: SessionType
): Promise<SessionManager | null> {
    const sessionManager = new SessionManager(
        YJS_WEBSOCKET_URL,
        CONTROL_WEBSOCKET_URL(roomId),
        roomId,
        context
    );

    // Wait for WebSocket connection to open (max 5 seconds)
    const controlWebSocket = sessionManager.getControlWebSocket();
    if (!controlWebSocket) {
        vscode.window.showErrorMessage("WebSocket connection not available.");
        return null;
    }

    const waitForWebSocketOpen = new Promise<void>((resolve, reject) => {
        if (controlWebSocket.readyState === WebSocket.OPEN) {
            resolve(); // Already open
        } else {
            const timeout = setTimeout(() => {
                if (controlWebSocket.readyState !== WebSocket.OPEN) {
                    vscode.window.showErrorMessage(
                        "WebSocket connection not available."
                    );
                    reject(new Error("WebSocket connection timeout"));
                }
            }, 5000); // 5 seconds timeout

            controlWebSocket.addEventListener(
                "open",
                () => {
                    clearTimeout(timeout);
                    resolve();
                },
                { once: true }
            );
        }
    });

    try {
        await waitForWebSocketOpen;
    } catch {
        return null; // Exit if WebSocket fails to connect
    }

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
                            "Room ID copied to clipboard."
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

    // Function to send the currently active file to the server if available
    const sendInstructorFile = () => {
        if (!relativeFilePath || !controlWebSocket) {
            return; // Do nothing if no file is available
        }

        try {
            controlWebSocket.send(
                JSON.stringify({
                    type: "set_instructor_file_request",
                    payload: {
                        roomId: roomId,
                        instructorFile: relativeFilePath,
                    },
                })
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to send instructor file: ${(error as Error).message}`
            );
        }
    };

    // Check WebSocket state and send the file accordingly
    if (controlWebSocket) {
        if (controlWebSocket.readyState === WebSocket.OPEN) {
            sendInstructorFile();
        } else if (controlWebSocket.readyState === WebSocket.CONNECTING) {
            controlWebSocket.addEventListener(
                "open",
                function onOpenHandler() {
                    sendInstructorFile();
                    controlWebSocket.removeEventListener("open", onOpenHandler);
                },
                { once: true }
            );
        } else {
            vscode.window.showErrorMessage(
                "WebSocket connection not available."
            );
        }
    } else {
        vscode.window.showErrorMessage("WebSocket connection not available.");
    }

    return sessionManager;
}

const registerWebSocketCommand = (
    sessionManager: SessionManager | undefined,
    commandName: string,
    requestType: string,
    responseType: string,
    successMessage: string,
    timeoutMessage: string,
    waitForOpen: boolean = true // Optional parameter to determine if waiting for WebSocket.OPEN is needed
) => {
    return vscode.commands.registerCommand(commandName, async () => {
        if (!sessionManager) {
            vscode.window.showErrorMessage(
                "No active session found. Please start a session first."
            );
            return;
        }

        const controlWebSocket = sessionManager.getControlWebSocket();
        if (!controlWebSocket) {
            vscode.window.showErrorMessage(
                "WebSocket connection not available."
            );
            return;
        }

        const sendRequest = async () => {
            try {
                await sessionManager.sendWebSocketRequest(
                    controlWebSocket,
                    requestType,
                    responseType,
                    { roomId: sessionManager.getRoomId() },
                    (payload) => payload.roomId === sessionManager.getRoomId()
                );
                vscode.window.showInformationMessage(successMessage);
            } catch (error) {
                vscode.window.showErrorMessage(
                    error instanceof Error ? error.message : timeoutMessage
                );
            }
        };

        if (controlWebSocket.readyState === WebSocket.OPEN) {
            await sendRequest();
        } else if (
            waitForOpen &&
            controlWebSocket.readyState === WebSocket.CONNECTING
        ) {
            const onOpenHandler = async () => {
                await sendRequest();
                controlWebSocket.removeEventListener("open", onOpenHandler);
            };
            controlWebSocket.addEventListener("open", onOpenHandler, {
                once: true,
            });
        } else {
            vscode.window.showErrorMessage(
                "WebSocket connection not available."
            );
        }
    });
};

/**
 * Verifys the password for a given room ID.
 */
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

/**
 * Checks if the room with a given room ID exists.
 */
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

            // Check if the workspace is not stored (workspaceFile exists)
            if (!vscode.workspace.workspaceFile) {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (
                    !workspaceFolders ||
                    (workspaceFolders && workspaceFolders.length === 0)
                ) {
                    vscode.window.showErrorMessage(
                        "No workspace folders found. Please add a folder to the workspace first."
                    );
                    return;
                }

                // Create a new workspace with the current folders and files
                if (workspaceFolders) {
                    const workspaceContent = {
                        folders: workspaceFolders.map((folder) => ({
                            uri: folder.uri.toString(),
                        })),
                        settings: {},
                    };

                    try {
                        // Capture all file tabs in tab groups
                        const tabGroupsState = vscode.window.tabGroups.all.map(
                            (group) => ({
                                viewColumn: group.viewColumn,
                                tabs: group.tabs
                                    .filter(
                                        (tab) =>
                                            tab.input instanceof
                                            vscode.TabInputText
                                    ) // Only capture files
                                    .map((tab) => ({
                                        label: tab.label,
                                        isActive: tab.isActive,
                                        uri: (
                                            tab.input as vscode.TabInputText
                                        ).uri.toString(),
                                    })),
                            })
                        );

                        // // Save tab and terminal state in globalState
                        await context.globalState.update(
                            "coducate.tabGroupsState",
                            tabGroupsState
                        );

                        // Write the workspace configurations to a temporary file
                        const tempDir = os.tmpdir();
                        const workspacePath = path.join(
                            tempDir,
                            `coducate-${Date.now()}.code-workspace`
                        );

                        await fs.writeFile(
                            workspacePath,
                            JSON.stringify(workspaceContent, null, 2)
                        );

                        await vscode.commands.executeCommand(
                            "vscode.openFolder",
                            vscode.Uri.file(workspacePath),
                            false
                        );
                    } catch {
                        vscode.window.showErrorMessage(
                            "Failed to save the workspace. Try starting the session again."
                        );
                        return;
                    }
                } else {
                    vscode.window.showErrorMessage(
                        "Failed to save the workspace. Try starting the session again."
                    );
                    return;
                }
            }

            const sessionType = await vscode.window.showQuickPick(
                ["New Session", "Existing Session"],
                {
                    placeHolder: "Choose session type. Press 'Esc' to cancel.",
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
                    placeHolder:
                        "A password is required to secure the session.",
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
                            canSelectMany: false,
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
                            canSelectMany: false,
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
                        vscode.window.showErrorMessage(
                            "Error generating room ID: " +
                                (error as Error).message
                        );
                        return;
                    }
                }

                await context.workspaceState.update(ROOM_ID_KEY, newRoomId);

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

                const sessionManagerFromInitailization =
                    await initializeSession(
                        context,
                        newRoomId,
                        status,
                        SessionType.NEW_SESSION
                    );

                if (!sessionManagerFromInitailization) {
                    return;
                }

                sessionManager = sessionManagerFromInitailization;

                if (taskDescriptionPath) {
                    try {
                        await sessionManager.addFileToYMap(
                            sessionManager.toPosixPath(
                                taskDescriptionPath.fsPath
                            ),
                            sessionManager.toPosixPath(
                                taskDescriptionPath.fsPath
                            )
                        );
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            "Failed to add task description."
                        );

                        // End the session if the task description fails to load
                        sessionManager.dispose();
                        sessionManager = undefined;
                        status.text = "$(sync-ignored) Coducate";
                        await context.workspaceState.update(
                            ROOM_ID_KEY,
                            undefined
                        );

                        return;
                    }
                }

                if (learningGoalsPath) {
                    try {
                        await sessionManager.addFileToYMap(
                            sessionManager.toPosixPath(
                                learningGoalsPath.fsPath
                            ),
                            sessionManager.toPosixPath(learningGoalsPath.fsPath)
                        );
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            "Failed to add learning goals."
                        );

                        // End the session if the learning goals fail to load
                        sessionManager.dispose();
                        sessionManager = undefined;
                        status.text = "$(sync-ignored) Coducate";
                        await context.workspaceState.update(
                            ROOM_ID_KEY,
                            undefined
                        );

                        return;
                    }
                }

                if (password && sessionManager.getControlWebSocket()) {
                    const controlWebSocket =
                        sessionManager.getControlWebSocket();
                    if (!controlWebSocket) {
                        vscode.window.showErrorMessage(
                            "WebSocket connection not available."
                        );
                        return;
                    }

                    const sendRequest = async () => {
                        try {
                            if (!sessionManager) {
                                vscode.window.showErrorMessage(
                                    "Session manager is not initialized."
                                );
                                return;
                            }

                            await sessionManager.sendWebSocketRequest(
                                controlWebSocket,
                                "set_session_data_request",
                                "set_session_data_response",
                                {
                                    roomId: newRoomId,
                                    password,
                                    taskDescriptionPath: taskDescriptionPath
                                        ? sessionManager.toPosixPath(
                                              taskDescriptionPath.fsPath
                                          )
                                        : "",
                                    learningGoalsPath: learningGoalsPath
                                        ? sessionManager.toPosixPath(
                                              learningGoalsPath.fsPath
                                          )
                                        : "",
                                },
                                (payload) =>
                                    payload.roomId ===
                                    sessionManager?.getRoomId(),
                                5000,
                                "Set session data request timed out."
                            );
                        } catch (error) {
                            vscode.window.showErrorMessage(
                                "Failed to set room password. Try starting the session again."
                            );

                            // End the session if the password fails to set
                            sessionManager?.dispose();
                            sessionManager = undefined;
                            status.text = "$(sync-ignored) Coducate";
                            await context.workspaceState.update(
                                ROOM_ID_KEY,
                                undefined
                            );
                        }
                    };

                    if (controlWebSocket.readyState === WebSocket.OPEN) {
                        await sendRequest();
                    } else if (
                        controlWebSocket.readyState === WebSocket.CONNECTING
                    ) {
                        const onOpenHandler = async () => {
                            await sendRequest();
                            controlWebSocket.removeEventListener(
                                "open",
                                onOpenHandler
                            );
                        };
                        controlWebSocket.addEventListener(
                            "open",
                            onOpenHandler,
                            { once: true }
                        );
                    } else {
                        vscode.window.showErrorMessage(
                            "WebSocket connection not available."
                        );
                    }
                } else {
                    vscode.window.showErrorMessage(
                        "WebSocket connection not available."
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
                        placeHolder: "Select an existing session.",
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

                await context.workspaceState.update(ROOM_ID_KEY, roomId);

                const sessionManagerFromInitailization =
                    await initializeSession(
                        context,
                        roomId,
                        status,
                        SessionType.EXISTING_SESSION
                    );

                if (!sessionManagerFromInitailization) {
                    return;
                }

                sessionManager = sessionManagerFromInitailization;
            }
        }
    );

    const endCommand = vscode.commands.registerCommand(
        "coducate.endSession",
        async () => {
            if (sessionManager) {
                sessionManager.dispose();
                sessionManager = undefined;
                status.text = "$(sync-ignored) Coducate";
                await context.workspaceState.update(ROOM_ID_KEY, undefined);

                vscode.window.showInformationMessage(
                    "Live Coding Session ended."
                );

                // If the current workspace is non-existent, untitled or not created by Coducate, do nothing
                if (
                    !vscode.workspace.workspaceFile ||
                    vscode.workspace.workspaceFile.scheme === "untitled" ||
                    !/coducate-\d+\.code-workspace$/.test(
                        vscode.workspace.workspaceFile.fsPath
                    )
                ) {
                    return;
                }

                const workspaceFolders = vscode.workspace.workspaceFolders;

                // Capture all file tabs in tab groups
                const tabGroupsState = vscode.window.tabGroups.all.map(
                    (group) => ({
                        viewColumn: group.viewColumn,
                        tabs: group.tabs
                            .filter(
                                (tab) =>
                                    tab.input instanceof vscode.TabInputText
                            ) // Only capture files
                            .map((tab) => ({
                                label: tab.label,
                                isActive: tab.isActive,
                                uri: (
                                    tab.input as vscode.TabInputText
                                ).uri.toString(),
                            })),
                    })
                );

                // Save workspace folders state in globalState
                if (workspaceFolders) {
                    const folderUris = workspaceFolders.map((folder) =>
                        folder.uri.toString()
                    );
                    context.globalState.update(
                        "coducate.workspaceFolders",
                        folderUris
                    );
                }

                // Save tab and terminal state in globalState
                await context.globalState.update(
                    "coducate.tabGroupsState",
                    tabGroupsState
                );

                if (vscode.workspace.workspaceFile) {
                    // Use closeFolder to remove the workspace
                    await vscode.commands.executeCommand(
                        "workbench.action.closeFolder"
                    );
                }

                // Open a new VS Code window
                await vscode.commands.executeCommand(
                    "workbench.action.newWindow"
                );

                // Close the current VS Code window
                await vscode.commands.executeCommand(
                    "workbench.action.closeWindow"
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
                            "Select a session to manage. Press 'Esc' to cancel.",
                    }
                );

                if (!selectedSession) {
                    return;
                }

                const selectedSessionName = selectedSession.label;

                const sessionActions = await vscode.window.showQuickPick(
                    ["Show password", "Rename Session", "Delete Session"],
                    {
                        placeHolder: `What would you like to do with '${selectedSessionName}'? Press 'Esc' to cancel.`,
                    }
                );

                if (!sessionActions) {
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
                        prompt: `Enter a new name for the session '${selectedSessionName}'.`,
                        placeHolder: "My New Session Name",
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
                        // Delete the stored notes for the session
                        const notesKey = `storedNotes-${existingSessions[selectedSessionName].roomId}`;
                        await context.globalState.update(notesKey, undefined);

                        // Delete the selected session
                        delete existingSessions[selectedSessionName];
                        await context.globalState.update(
                            "coducate.sessions",
                            existingSessions
                        );

                        vscode.window.showInformationMessage(
                            `Session '${selectedSessionName}' successfully deleted.`
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
                        placeHolder:
                            "Choose how to grant write access. Press 'Esc' to cancel.",
                    }
                );

                if (decision === undefined) {
                    return;
                }

                const controlWebSocket = sessionManager?.getControlWebSocket();
                const roomId = sessionManager?.getRoomId();

                if (!controlWebSocket || !roomId) {
                    vscode.window.showErrorMessage(
                        "WebSocket connection not available."
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
                                placeHolder:
                                    "Enter user ID. Press 'Esc' to cancel.",
                            }
                        );

                        if (targetSimpleID === undefined) {
                            await grantAccessLoop(); // Restart the process
                            return;
                        }

                        if (targetSimpleID !== undefined) {
                            if (targetSimpleID.trim() === "") {
                                vscode.window.showErrorMessage(
                                    "No user ID entered."
                                );
                                continue;
                            }

                            try {
                                const responsePayload =
                                    await sessionManager?.sendWebSocketRequest(
                                        controlWebSocket,
                                        "grant_access_request",
                                        "grant_access_response",
                                        { roomId, targetSimpleID },
                                        (payload) =>
                                            payload.simpleID ===
                                                targetSimpleID &&
                                            payload.roomId === roomId,
                                        5000,
                                        "Grant write access request timed out. Client ID may not exist."
                                    );

                                const responseSimpleID =
                                    responsePayload?.simpleID;

                                // Add the user ID to the roomAccessMap
                                clientSet.add(responseSimpleID);
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
                                    `Write access granted to user ID: ${responseSimpleID}`
                                );
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

                    try {
                        const responsePayload =
                            await sessionManager?.sendWebSocketRequest(
                                controlWebSocket,
                                "grant_access_request",
                                "grant_access_response",
                                { roomId, targetSimpleID: null },
                                (payload) =>
                                    payload.roomId === roomId &&
                                    Array.isArray(payload.simpleID),
                                5000,
                                "Grant write access request timed out."
                            );

                        const grantedClientIDs = responsePayload?.simpleID;

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

                            if (grantedClientIDs.length === 1) {
                                vscode.window.showInformationMessage(
                                    `Write access granted to all clients (${grantedClientIDs.length} client).`
                                );
                            } else {
                                vscode.window.showInformationMessage(
                                    `Write access granted to all clients (${grantedClientIDs.length} clients).`
                                );
                            }
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

            const controlWebSocket = sessionManager.getControlWebSocket();
            const roomId = sessionManager.getRoomId();

            if (!controlWebSocket || !roomId) {
                vscode.window.showErrorMessage(
                    "WebSocket connection not available."
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

            if (clientSet.size === 0) {
                vscode.window.showInformationMessage(
                    "No users have write access."
                );
                return;
            }

            // Ask the user if they want to revoke access for all users or a specific user
            const revokeChoice = await vscode.window.showQuickPick(
                [
                    "Revoke write access for a specific user",
                    "Revoke write access for all users",
                ],
                {
                    placeHolder:
                        "Choose how to revoke write access. Press 'Esc' to cancel.",
                }
            );

            if (revokeChoice === undefined) {
                return;
            }

            if (revokeChoice === "Revoke access for a specific user") {
                while (true) {
                    if (clientSet.size === 0) {
                        vscode.window.showInformationMessage(
                            "No users have write access."
                        );
                        return;
                    }

                    // Convert the Set to an array for quick pick
                    const clientList = Array.from(clientSet);

                    // Ask the user to choose a client ID from the list or input manually
                    const targetSimpleID = await vscode.window.showQuickPick(
                        clientList,
                        {
                            placeHolder:
                                "Choose a user ID to revoke write access. Press 'Esc' to cancel.",
                        }
                    );

                    if (targetSimpleID === undefined) {
                        return;
                    }

                    try {
                        const responsePayload =
                            await sessionManager?.sendWebSocketRequest(
                                controlWebSocket,
                                "revoke_access_request",
                                "revoke_access_response",
                                { roomId, targetSimpleID: targetSimpleID },
                                (payload) =>
                                    payload.simpleID === targetSimpleID &&
                                    payload.roomId === roomId,
                                5000,
                                "Revoke write access request timed out."
                            );

                        const responseSimpleID = responsePayload?.simpleID;

                        if (responseSimpleID) {
                            // Remove the specific user from the roomAccessMap
                            clientSet.delete(responseSimpleID);
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
                                `Write access revoked from user ID: ${responseSimpleID}`
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
            } else if (revokeChoice === "Revoke write access for all users") {
                try {
                    await sessionManager?.sendWebSocketRequest(
                        controlWebSocket,
                        "revoke_access_request",
                        "revoke_access_response",
                        { roomId, targetSimpleID: null },
                        (payload) =>
                            payload.roomId === roomId &&
                            payload.simpleID === null,
                        5000,
                        "Revoke write access request timed out."
                    );

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

            // Check if OS is Windows
            const isWindows = os.platform() === "win32";
            const runningProcess = isWindows ? "WSL (Bash)" : "Bash";

            const task = new vscode.Task(
                { type: "runBash" },
                vscode.TaskScope.Workspace,
                `Running ${runningProcess}`,
                "Emulated Terminal",
                new vscode.CustomExecution(
                    async (): Promise<vscode.Pseudoterminal> =>
                        new CaptureTerminal(sessionManager!)
                ),
                []
            );

            vscode.tasks.executeTask(task);

            // Request the terminal to open
            vscode.commands.executeCommand("coducate.openTerminal");
        }
    );

    // Command to request terminal open
    const requestTerminalOpenCommand = registerWebSocketCommand(
        sessionManager,
        "coducate.closeTerminal",
        "close_terminal_request",
        "close_terminal_response",
        "Terminal successfully closed.",
        "Terminal close request timed out",
        false
    );

    // Command to request terminal close
    const requestTerminalCloseCommand = registerWebSocketCommand(
        sessionManager,
        "coducate.openTerminal",
        "open_terminal_request",
        "open_terminal_response",
        "Terminal successfully opened.",
        "Terminal open request timed out",
        false
    );

    // Command to request explorer open
    const requestExplorerOpenCommand = registerWebSocketCommand(
        sessionManager,
        "coducate.openExplorer",
        "open_explorer_request",
        "open_explorer_response",
        "Explorer successfully opened.",
        "Explorer open request timed out",
        false
    );

    // Command to request explorer close
    const requestExplorerCloseCommand = registerWebSocketCommand(
        sessionManager,
        "coducate.closeExplorer",
        "close_explorer_request",
        "close_explorer_response",
        "Explorer successfully closed.",
        "Explorer close request timed out",
        false
    );

    // Command to show room ID
    const showRoomIdCommand = registerWebSocketCommand(
        sessionManager,
        "coducate.showRoomId",
        "show_room_id_request",
        "show_room_id_response",
        "Room ID successfully shown.",
        "Show room ID request timed out",
        false
    );

    // Command to hide room ID
    const hideRoomIdCommand = registerWebSocketCommand(
        sessionManager,
        "coducate.hideRoomId",
        "hide_room_id_request",
        "hide_room_id_response",
        "Room ID successfully hidden.",
        "Hide room ID request timed out",
        false
    );

    const adjustFontSizeCommand = vscode.commands.registerCommand(
        "coducate.changeFontSize",
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
            quickPick.title = "Change Font Size";
            quickPick.placeholder = "Select an action. Press 'Esc' to cancel.";
            quickPick.buttons = [vscode.QuickInputButtons.Back];

            quickPick.onDidTriggerButton(() => {
                quickPick.hide();
            });

            quickPick.onDidChangeSelection(async (selection) => {
                if (!selection[0] || !sessionManager) {
                    vscode.window.showErrorMessage(
                        "Invalid input or session not active."
                    );
                    return;
                }

                const choice = selection[0].label;
                const increaseFontSize = choice === "Increase Font Size";
                const controlWebSocket = sessionManager.getControlWebSocket();

                if (!controlWebSocket) {
                    vscode.window.showErrorMessage(
                        "WebSocket connection not available."
                    );
                    return;
                }

                try {
                    await sessionManager.sendWebSocketRequest(
                        controlWebSocket,
                        "change_font_size_request",
                        "change_font_size_response",
                        {
                            roomId: sessionManager.getRoomId(),
                            increase: increaseFontSize,
                        },
                        (payload) =>
                            payload.roomId === sessionManager?.getRoomId(),
                        5000,
                        "Change font size request timed out."
                    );

                    vscode.window.showInformationMessage(
                        `Font size successfully ${
                            increaseFontSize ? "increased" : "decreased"
                        }.`
                    );
                } catch (error) {
                    vscode.window.showErrorMessage(
                        error instanceof Error
                            ? error.message
                            : "Font size change request failed."
                    );
                }
            });

            // Show the QuickPick
            quickPick.show();
        }
    );

    const changeThemeCommand = vscode.commands.registerCommand(
        "coducate.changeTheme",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            const controlWebSocket = sessionManager.getControlWebSocket();
            if (!controlWebSocket) {
                vscode.window.showErrorMessage(
                    "WebSocket connection not available."
                );
                return;
            }

            // Prompt user to select theme
            const theme = await vscode.window.showQuickPick(["Dark", "Light"], {
                placeHolder: "Select theme",
            });

            if (!theme) {
                return; // User canceled selection
            }

            const selectedTheme = theme.toLowerCase();

            try {
                await sessionManager.sendWebSocketRequest(
                    controlWebSocket,
                    "change_theme_request",
                    "change_theme_response",
                    {
                        changedTheme: selectedTheme,
                        roomId: sessionManager.getRoomId(),
                    },
                    (payload) =>
                        payload.changedTheme === selectedTheme &&
                        payload.roomId === sessionManager?.getRoomId(),
                    5000,
                    "Change theme request timed out."
                );

                vscode.window.showInformationMessage(
                    `Theme successfully changed to ${theme} mode.`
                );
            } catch (error) {
                vscode.window.showErrorMessage(
                    error instanceof Error
                        ? error.message
                        : "Theme change request failed."
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
                        prompt: "Enter a title for the note. Press 'Esc' to cancel.",
                        placeHolder: "e.g., Check if user input is valid",
                    });

                    if (title === undefined) {
                        return; // User cancelled
                    } else if (title === "") {
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
                {
                    placeHolder:
                        "What do you want to do with this note? Click 'Esc' to cancel.",
                }
            );

            if (choice === undefined) {
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
        "coducate.removeNotes",
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
                        label: "Remove all notes in this workspace",
                        value: "workspace",
                    },
                ],
                {
                    placeHolder:
                        "Choose which notes to remove. Click 'Esc' to cancel.",
                }
            );

            if (choice === undefined) {
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
        requestExplorerOpenCommand,
        requestExplorerCloseCommand,
        showRoomIdCommand,
        hideRoomIdCommand,
        adjustFontSizeCommand,
        changeThemeCommand,
        createNotesCommand,
        handleNoteActionCommand,
        removeNoteCommand,
        toggleSuggestionsCommand
    );
}

export function deactivate() {}
