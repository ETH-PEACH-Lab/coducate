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
import { SessionManager } from "./SessionManager";
// import { CaptureTerminal } from "./CaptureTerminal";
import { showTmpNotification } from "./tmpNotifications";

// Key to store the room ID in the workspace state
const ROOM_ID_KEY = "coducateRoomId";

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
    const diffEditorConfig = vscode.workspace.getConfiguration("diffEditor");
    const diffEditorCurrentValue = diffEditorConfig.get<boolean>("codeLens");

    if (!diffEditorCurrentValue) {
        vscode.window
            .showInformationMessage(
                "To accept/rollback changes made by web clients, enable 'diffEditor.codeLens'.",
                { modal: true },
                "Enable"
            )
            .then((selection) => {
                if (selection === "Enable") {
                    diffEditorConfig
                        .update(
                            "codeLens",
                            true,
                            vscode.ConfigurationTarget.Global
                        )
                        .then(
                            () => {
                                showTmpNotification(
                                    "'diffEditor.codeLens' has been enabled."
                                );
                            },
                            (error) => {
                                vscode.window.showErrorMessage(
                                    "Failed to enable 'diffEditor.codeLens'."
                                );
                            }
                        );
                } else {
                    vscode.window.showWarningMessage(
                        "You may not be able to accept/rollback changes made by web clients in the diff editor view. You can enable 'diffEditor.codeLens' in the settings.",
                        "Ok"
                    );
                }
            });
    }

    // Prompt to enable terminal.integrated.shellIntegration.enabled setting
    const terminalIntegrationConfig = vscode.workspace.getConfiguration(
        "terminal.integrated"
    );
    const terminalIntegrationCurrentValue =
        terminalIntegrationConfig.get<boolean>("shellIntegration.enabled");

    if (!terminalIntegrationCurrentValue) {
        vscode.window
            .showInformationMessage(
                "To allow Coducate to mirror the terminal to the web view (read-only), enable 'terminal.integrated.shellIntegration.enabled'.",
                { modal: true },
                "Enable"
            )
            .then((selection) => {
                if (selection === "Enable") {
                    terminalIntegrationConfig
                        .update(
                            "shellIntegration.enabled",
                            true,
                            vscode.ConfigurationTarget.Global
                        )
                        .then(
                            () => {
                                showTmpNotification(
                                    "'terminal.integrated.shellIntegration.enabled' has been enabled."
                                );
                            },
                            (error) => {
                                vscode.window.showErrorMessage(
                                    "Failed to enable 'terminal.integrated.shellIntegration.enabled'."
                                );
                            }
                        );
                } else {
                    vscode.window.showWarningMessage(
                        "Coducate may not be able to mirror the terminal to the web view. You can enable 'terminal.integrated.shellIntegration.enabled' in the settings.",
                        "Ok"
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
        // Look up stored password to re-authenticate and get a fresh token
        const existingSessions =
            context.globalState.get<{
                [key: string]: { roomId: string; password: string };
            }>("coducate.sessions") || {};

        const sessionEntry = Object.values(existingSessions).find(
            (s) => s.roomId === roomId
        );

        if (!sessionEntry) {
            vscode.window.showErrorMessage(
                "Failed to restore session: no stored credentials found."
            );
            await context.workspaceState.update(ROOM_ID_KEY, undefined);
            return;
        }

        let token: string | undefined;
        try {
            token = await verifyPassword(
                getBackendHost(context),
                sessionEntry.password,
                roomId
            );
        } catch {
            // Server may be unreachable — clear stale session
        }

        if (!token) {
            vscode.window.showErrorMessage(
                "Failed to restore session: authentication failed."
            );
            await context.workspaceState.update(ROOM_ID_KEY, undefined);
            return;
        }

        const sessionManagerFromInitailization = await initializeSession(
            context,
            roomId,
            token,
            status
        );

        if (!sessionManagerFromInitailization) {
            vscode.window.showErrorMessage(
                "Failed to restore the live coding session."
            );
            return;
        }

        sessionManager = sessionManagerFromInitailization;

        const showRoomIdMessage = async (message: string) => {
            const copyToClipboard = await vscode.window.showInformationMessage(
                message,
                "Copy Room ID"
            );

            if (copyToClipboard === "Copy Room ID") {
                await vscode.env.clipboard.writeText(roomId);
                showTmpNotification("Room ID copied to clipboard.");
            }
        };

        showRoomIdMessage(`Live coding session restored. Room ID: ${roomId}`);
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
    token: string,
    status: vscode.StatusBarItem
): Promise<SessionManager | null> {
    const sessionManager = new SessionManager(roomId, token, status, context);

    context.subscriptions.push(sessionManager);

    // Capture the currently active file in the editor
    const activeEditor = vscode.window.activeTextEditor;
    const activeFilePath = activeEditor?.document.uri.fsPath;
    let relativeFilePath = null;
    if (activeFilePath) {
        const correctFilePath = await sessionManager.getCorrectCasePath(
            activeFilePath
        );
        relativeFilePath = sessionManager.getRelativeFilePath(correctFilePath);
    }

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
        .getProvider()
        .awareness.setLocalStateField("vsCodeClient", clientState);

    // Send the active file to the server (send-and-forget)
    if (relativeFilePath) {
        try {
            await sessionManager.sendWebSocketRequest(
                "set_instructor_file_request",
                { roomId: roomId, instructorFile: relativeFilePath },
                {
                    waitForResponse: false, // Send-and-forget (no response expected)
                }
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                error instanceof Error ? error.message : String(error)
            );

            return null;
        }
    }

    return sessionManager;
}

/**
 * Get backend host based on the extension mode.
 */
function getBackendHost(context: vscode.ExtensionContext): string {
    return context.extensionMode === vscode.ExtensionMode.Production
        ? "https://coducate.me" // Production environment
        : "http://localhost:1234"; // Development environment
}

/**
 * Verifies the password for a given room ID.
 * Returns the token on success, undefined on failure.
 */
async function verifyPassword(
    backendHost: string,
    password: string,
    roomId: string
): Promise<string | undefined> {
    const response = await fetch(`${backendHost}/api/verify-password`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ password, roomId }),
    });

    if (response.ok) {
        const data = await response.json();
        return data.success ? data.token : undefined;
    }
}

/**
 * Checks if the room with a given room ID exists.
 */
async function isRoomExisting(
    backendHost: string,
    roomId: string
): Promise<boolean> {
    const response = await fetch(`${backendHost}/api/verify-room`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ roomId }),
    });

    return response.ok;
}

/**
 * Register all commands for the extension.
 */
function registerCommands(
    context: vscode.ExtensionContext,
    deps: {
        sessionManager: SessionManager | undefined;
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

            const sessionType = await vscode.window.showQuickPick([
                {
                    label: "$(coducate-create) Create New Session",
                    value: "New Session",
                },
                {
                    label: "$(coducate-join) Join Existing Session",
                    value: "Existing Session",
                },
            ]);

            if (!sessionType) {
                return;
            }

            const existingSessions =
                context.globalState.get<{
                    [key: string]: { roomId: string; password: string };
                }>("coducate.sessions") || {};

            if (sessionType.value === "New Session") {
                let sessionName;
                do {
                    sessionName = await vscode.window.showInputBox({
                        prompt:
                            sessionName && existingSessions[sessionName]
                                ? `The session name '${sessionName}' already exists. Enter a different name or use the Manage Sessions command to delete the existing session.`
                                : "Enter an easy-to-remember session name.",
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
                } while (existingSessions[sessionName]);

                // Prompt user for a password
                const password = await vscode.window.showInputBox({
                    prompt: "Enter a password for this session.",
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
                        isRoomIdValid = !(await isRoomExisting(
                            getBackendHost(context),
                            newRoomId
                        ));
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            error instanceof Error
                                ? error.message
                                : String(error)
                        );
                        return;
                    }
                }

                // Create the session via REST endpoint (creates room + returns auth token)
                let token: string;
                try {
                    const response = await fetch(
                        `${getBackendHost(context)}/api/create-session`,
                        {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                roomId: newRoomId,
                                password,
                                taskDescriptionPath: taskDescriptionPath
                                    ? taskDescriptionPath.fsPath
                                    : "",
                                learningGoalsPath: learningGoalsPath
                                    ? learningGoalsPath.fsPath
                                    : "",
                            }),
                        }
                    );

                    if (!response.ok) {
                        const data = await response.json();
                        throw new Error(
                            data.message || "Failed to create session."
                        );
                    }

                    const data = await response.json();
                    token = data.token;
                } catch (error) {
                    vscode.window.showErrorMessage(
                        error instanceof Error ? error.message : String(error)
                    );
                    return;
                }

                const sessionManagerFromInitailization =
                    await initializeSession(context, newRoomId, token, status);

                if (!sessionManagerFromInitailization) {
                    vscode.window.showErrorMessage(
                        "Failed to start the live coding session."
                    );
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
                        await context.workspaceState.update(
                            ROOM_ID_KEY,
                            undefined
                        );

                        return;
                    }
                }

                // Store the mapping of session name to room ID and password
                existingSessions[sessionName] = { roomId: newRoomId, password };

                await context.globalState.update(
                    "coducate.sessions",
                    existingSessions
                );

                await context.workspaceState.update(ROOM_ID_KEY, newRoomId);

                const showRoomIdMessage = async (message: string) => {
                    const copyToClipboard =
                        await vscode.window.showInformationMessage(
                            message,
                            "Copy Room ID"
                        );

                    if (copyToClipboard === "Copy Room ID") {
                        await vscode.env.clipboard.writeText(newRoomId);
                        showTmpNotification("Room ID copied to clipboard.");
                    }
                };

                showRoomIdMessage(
                    `Live coding session started. Room ID: ${newRoomId}`
                );
            } else if (sessionType.value === "Existing Session") {
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
                    sessionChoices
                );

                if (!selectedSession) {
                    return;
                }

                const selectedSessionName = selectedSession.label;
                const roomId = selectedSession.description;
                const password = existingSessions[selectedSessionName].password;

                let token: string | undefined;
                try {
                    token = await verifyPassword(
                        getBackendHost(context),
                        password,
                        roomId
                    );
                } catch (error) {
                    vscode.window.showErrorMessage(
                        error instanceof Error ? error.message : String(error)
                    );
                    return;
                }

                if (!token) {
                    vscode.window.showErrorMessage(
                        "Invalid Room ID or Password."
                    );
                    return;
                }

                const sessionManagerFromInitailization =
                    await initializeSession(context, roomId, token, status);

                if (!sessionManagerFromInitailization) {
                    vscode.window.showErrorMessage(
                        "Failed to join existing live coding session."
                    );
                    return;
                }

                sessionManager = sessionManagerFromInitailization;

                await context.workspaceState.update(ROOM_ID_KEY, roomId);

                const showRoomIdMessage = async (message: string) => {
                    const copyToClipboard =
                        await vscode.window.showInformationMessage(
                            message,
                            "Copy Room ID"
                        );

                    if (copyToClipboard === "Copy Room ID") {
                        await vscode.env.clipboard.writeText(roomId);
                        showTmpNotification("Room ID copied to clipboard.");
                    }
                };

                showRoomIdMessage(
                    `Live coding session joined. Room ID: ${roomId}`
                );
            }
        }
    );

    const endCommand = vscode.commands.registerCommand(
        "coducate.endSession",
        async () => {
            if (sessionManager) {
                sessionManager.dispose();
                sessionManager = undefined;
                await context.workspaceState.update(ROOM_ID_KEY, undefined);
                status.text = "$(sync-ignored) Coducate";

                showTmpNotification("Live coding session ended.");

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
                showTmpNotification("No sessions available to manage.");
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

                if (sessionChoices.length === 0) {
                    showTmpNotification("All sessions have been deleted.");
                    return;
                }

                const selectedSession = await vscode.window.showQuickPick(
                    sessionChoices,
                    {
                        placeHolder: "Select a session to manage.",
                    }
                );

                if (!selectedSession) {
                    return;
                }

                const selectedSessionName = selectedSession.label;

                const sessionActions = await vscode.window.showQuickPick(
                    [
                        {
                            label: "$(coducate-password) Show password",
                            value: "password",
                        },
                        {
                            label: "$(coducate-rename) Rename Session",
                            value: "rename",
                        },
                        {
                            label: "$(coducate-delete) Delete Session",
                            value: "delete",
                        },
                    ],
                    {
                        placeHolder: `What would you like to do with '${selectedSessionName}'?`,
                    }
                );

                if (!sessionActions) {
                    continue; // Go back to the session list
                }

                if (sessionActions.value === "password") {
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
                            "Copy Password"
                        );

                    if (copyToClipboard === "Copy Password") {
                        await vscode.env.clipboard.writeText(password);
                        showTmpNotification("Password copied to clipboard.");
                        return;
                    }

                    return;
                } else if (sessionActions.value === "rename") {
                    const newSessionName = await vscode.window.showInputBox({
                        prompt: `Enter a new name for the session '${selectedSessionName}'.`,
                        value: selectedSessionName,
                    });

                    if (newSessionName === undefined) {
                        continue;
                    } else if (newSessionName === "") {
                        vscode.window.showErrorMessage(
                            "Session name cannot be empty."
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

                    showTmpNotification(
                        `Session '${selectedSessionName}' renamed to '${newSessionName}'.`
                    );

                    return;
                } else if (sessionActions.value === "delete") {
                    const confirmDelete = await vscode.window.showQuickPick(
                        ["Yes", "No"],
                        {
                            placeHolder: `Are you sure you want to delete the session '${selectedSessionName}'?`,
                        }
                    );

                    if (confirmDelete === undefined) {
                        continue;
                    }

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

                        showTmpNotification(
                            `Session '${selectedSessionName}' deleted.`
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
            showTmpNotification("Room ID copied to clipboard.");
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
                const decision = await vscode.window.showQuickPick([
                    {
                        label: "$(coducate-person-add) Grant write access to a specific client",
                        value: "specific",
                    },
                    {
                        label: "$(coducate-people-add) Grant write access to all clients",
                        value: "all",
                    },
                ]);

                if (decision === undefined) {
                    return;
                }

                const roomId = sessionManager?.getRoomId();

                if (!roomId) {
                    vscode.window.showErrorMessage(
                        "Room ID not found. Please start a session first."
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

                if (decision.value === "specific") {
                    while (true) {
                        const targetSimpleID = await vscode.window.showInputBox(
                            {
                                prompt: "Enter the client ID to grant write access.",
                            }
                        );

                        if (targetSimpleID === undefined) {
                            return;
                        }

                        if (targetSimpleID !== undefined) {
                            if (targetSimpleID.trim() === "") {
                                vscode.window.showErrorMessage(
                                    "No client ID entered."
                                );
                                continue;
                            }

                            const targetSimpleIDNum =
                                parseInt(targetSimpleID, 10);
                            if (isNaN(targetSimpleIDNum)) {
                                vscode.window.showErrorMessage(
                                    "Client ID must be a number."
                                );
                                continue;
                            }

                            let responsePayload;
                            try {
                                responsePayload =
                                    await sessionManager?.sendWebSocketRequest(
                                        "grant_access_request",
                                        { roomId, targetSimpleID: targetSimpleIDNum },
                                        {
                                            responseType:
                                                "grant_access_response",
                                            validateResponse: (payload) =>
                                                payload.simpleID ===
                                                    targetSimpleIDNum &&
                                                payload.roomId === roomId,
                                            timeoutMessage: `Grant write access request timed out. Client ${targetSimpleIDNum} may not exist.`,
                                            waitForOpen: false,
                                        }
                                    );
                            } catch (error) {
                                vscode.window.showErrorMessage(
                                    error instanceof Error
                                        ? error.message
                                        : String(error)
                                );
                                continue; // Skip to next iteration
                            }

                            const responseSimpleID = responsePayload?.simpleID;

                            // Only update access map and show notification if we got a valid response
                            if (responseSimpleID !== undefined && responseSimpleID !== null) {
                                // Add the user ID to the roomAccessMap (as string for serialization)
                                clientSet.add(String(responseSimpleID));
                                roomAccessMap.set(roomId, clientSet);

                                // Convert Sets to arrays for serialization
                                const serializedMap = JSON.stringify(
                                    Array.from(roomAccessMap.entries()).map(
                                        ([key, value]) => [
                                            key,
                                            Array.from(value),
                                        ]
                                    )
                                );

                                await context.globalState.update(
                                    "roomAccessMap",
                                    serializedMap
                                );

                                showTmpNotification(
                                    `Write access granted to client ${responseSimpleID}.`
                                );
                            }
                        }
                    }
                } else if (decision.value === "all") {
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

                    let responsePayload;
                    try {
                        responsePayload =
                            await sessionManager?.sendWebSocketRequest(
                                "grant_access_request",
                                { roomId, targetSimpleID: null },
                                {
                                    responseType: "grant_access_response",
                                    validateResponse: (payload) =>
                                        payload.roomId === roomId &&
                                        Array.isArray(payload.simpleID),
                                    timeoutMessage:
                                        "Grant write access request timed out.",
                                    waitForOpen: false,
                                }
                            );
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            error instanceof Error
                                ? error.message
                                : String(error)
                        );
                        return;
                    }

                    const grantedClientIDs = responsePayload?.simpleID?.map(
                        (id: number) => String(id)
                    );

                    if (grantedClientIDs && grantedClientIDs.length > 0) {
                        // Add all client IDs to the roomAccessMap
                        for (const clientID of grantedClientIDs) {
                            clientSet.add(clientID);
                        }
                        roomAccessMap.set(roomId, clientSet);

                        // Convert Sets to arrays for serialization
                        const serializedMap = JSON.stringify(
                            Array.from(roomAccessMap.entries()).map(
                                ([key, value]) => [key, Array.from(value)]
                            )
                        );

                        await context.globalState.update(
                            "roomAccessMap",
                            serializedMap
                        );

                        showTmpNotification(
                            `Write access granted to all clients (${
                                grantedClientIDs.length
                            } client${
                                grantedClientIDs.length === 1 ? "" : "s"
                            }).`
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

            const roomId = sessionManager.getRoomId();

            if (!roomId) {
                vscode.window.showErrorMessage(
                    "Room ID not found. Please start a session first."
                );
                return;
            }

            const revokeAccessLoop = async () => {
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

                // Get the client set for the current room or initialize a new Set
                const clientSet = roomAccessMap.get(roomId) || new Set();

                if (clientSet.size === 0) {
                    showTmpNotification("No clients have write access.");
                    return;
                }

                // Ask the user if they want to revoke access for all clients or a specific client
                const revokeChoice = await vscode.window.showQuickPick([
                    {
                        label: "$(coducate-person-delete) Revoke write access for a specific client",
                        value: "specific",
                    },
                    {
                        label: "$(coducate-people-delete) Revoke write access for all clients",
                        value: "all",
                    },
                ]);

                if (revokeChoice === undefined) {
                    return;
                }

                if (revokeChoice.value === "specific") {
                    while (true) {
                        if (clientSet.size === 0) {
                            return;
                        }

                        // Convert the Set to an array for quick pick
                        const clientList = Array.from(clientSet);

                        // Ask the user to choose a client ID from the list or input manually
                        const targetSimpleID =
                            await vscode.window.showQuickPick(clientList, {
                                placeHolder:
                                    "Choose a client ID to revoke write access.",
                            });

                        if (targetSimpleID === undefined) {
                            return;
                        }

                        const targetSimpleIDNum =
                            parseInt(targetSimpleID, 10);
                        if (isNaN(targetSimpleIDNum)) {
                            vscode.window.showErrorMessage(
                                "Client ID must be a number."
                            );
                            return;
                        }

                        let responsePayload;
                        try {
                            responsePayload =
                                await sessionManager?.sendWebSocketRequest(
                                    "revoke_access_request",
                                    { roomId, targetSimpleID: targetSimpleIDNum },
                                    {
                                        responseType: "revoke_access_response",
                                        validateResponse: (payload) =>
                                            payload.simpleID ===
                                                targetSimpleIDNum &&
                                            payload.roomId === roomId,
                                        timeoutMessage: `Revoke write access request timed out. Client ${targetSimpleIDNum} may still have write access.`,
                                        waitForOpen: false,
                                    }
                                );
                        } catch (error) {
                            vscode.window.showErrorMessage(
                                error instanceof Error
                                    ? error.message
                                    : String(error)
                            );
                            continue; // Skip to next iteration
                        }

                        const responseSimpleID = responsePayload?.simpleID;

                        if (responseSimpleID !== undefined && responseSimpleID !== null) {
                            // Remove the specific client from the roomAccessMap
                            clientSet.delete(String(responseSimpleID));
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

                            showTmpNotification(
                                `Write access revoked from client ${responseSimpleID}.`
                            );
                        }
                    }
                } else if (revokeChoice.value === "all") {
                    const confirmation = await vscode.window.showQuickPick(
                        ["Yes", "No"],
                        {
                            placeHolder:
                                "Are you sure you want to revoke write access from all clients?",
                        }
                    );

                    if (confirmation === "No" || !confirmation) {
                        await revokeAccessLoop(); // Restart the process
                        return;
                    }

                    let responsePayload;
                    try {
                        responsePayload =
                            await sessionManager?.sendWebSocketRequest(
                                "revoke_access_request",
                                { roomId, targetSimpleID: null },
                                {
                                    responseType: "revoke_access_response",
                                    validateResponse: (payload) =>
                                        payload.roomId === roomId &&
                                        payload.simpleID === null,
                                    timeoutMessage:
                                        "Revoke write access request timed out.",
                                    waitForOpen: false,
                                }
                            );

                        // Only proceed if we got a successful response
                        if (responsePayload) {
                            // Store the client count before clearing
                            const clientCount = clientSet.size;

                            // Clear the roomAccessMap for the current room
                            roomAccessMap.set(roomId, new Set());

                            // Convert Sets to arrays for serialization
                            const serializedMap = JSON.stringify(
                                Array.from(roomAccessMap.entries()).map(
                                    ([key, value]) => [key, Array.from(value)]
                                )
                            );

                            await context.globalState.update(
                                "roomAccessMap",
                                serializedMap
                            );

                            showTmpNotification(
                                `Write access revoked for all clients (${clientCount} client${
                                    clientCount === 1 ? "" : "s"
                                }).`
                            );
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            error instanceof Error
                                ? error.message
                                : String(error)
                        );
                        return;
                    }
                }
            };

            await revokeAccessLoop();
        }
    );

    // Command to create/open a Coducate Terminal
    const createCoducateTerminalCommand = vscode.commands.registerCommand(
        "coducate.createCoducateTerminal",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            const existingTerminals = vscode.window.terminals;
            const coducateTerminal = existingTerminals.find(
                (terminal) =>
                    terminal.creationOptions.name ===
                    `Coducate Terminal (${sessionManager?.getRoomId()})`
            );

            if (coducateTerminal) {
                // Terminal already exists, open it
                coducateTerminal.show();
                return;
            } else {
                // Terminal does not exist, create it
                const terminal = vscode.window.createTerminal({
                    name: `Coducate Terminal (${sessionManager.getRoomId()})`,
                });
                terminal.show();
            }
        }
    );

    // Old pseudo terminal implementation using bash (only works with WSL for windows)
    // const emulateTerminalCommand = vscode.commands.registerCommand(
    //     "coducate.emulateTerminal",
    //     async () => {
    //         if (!sessionManager) {
    //             vscode.window.showErrorMessage(
    //                 "No active session found. Please start a session first."
    //             );
    //             return;
    //         }

    //         const editor = vscode.window.activeTextEditor;
    //         if (!editor) {
    //             vscode.window.showErrorMessage("No active editor to run code.");
    //             return;
    //         }

    //         // Check if OS is Windows
    //         const isWindows = os.platform() === "win32";
    //         const runningProcess = isWindows ? "WSL (Bash)" : "Bash";

    //         const task = new vscode.Task(
    //             { type: "runBash" },
    //             vscode.TaskScope.Workspace,
    //             `Running ${runningProcess}`,
    //             "Emulated Terminal",
    //             new vscode.CustomExecution(
    //                 async (): Promise<vscode.Pseudoterminal> =>
    //                     new CaptureTerminal(sessionManager!)
    //             ),
    //             []
    //         );

    //         vscode.tasks.executeTask(task);

    //         // Request the terminal to open
    //         vscode.commands.executeCommand("coducate.openTerminal");
    //     }
    // );

    // Command to request terminal open
    const requestTerminalOpenCommand = vscode.commands.registerCommand(
        "coducate.openTerminal",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            try {
                await sessionManager.sendWebSocketRequest(
                    "open_terminal_request",
                    {
                        roomId: sessionManager?.getRoomId(),
                    },
                    {
                        responseType: "open_terminal_response",
                        validateResponse: (payload) =>
                            payload.roomId === sessionManager?.getRoomId(),
                        timeoutMessage: "Terminal open request timed out.",
                        waitForOpen: false,
                    }
                );

                sessionManager
                    .getTerminalShellIntegration()
                    .setTerminalFlag(true);

                showTmpNotification("Terminal successfully opened.");
            } catch (error) {
                vscode.window.showErrorMessage(
                    error instanceof Error ? error.message : String(error)
                );
            }
        }
    );

    // Command to request terminal close
    const requestTerminalCloseCommand = vscode.commands.registerCommand(
        "coducate.closeTerminal",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            try {
                await sessionManager.sendWebSocketRequest(
                    "close_terminal_request",
                    { roomId: sessionManager.getRoomId() },
                    {
                        responseType: "close_terminal_response",
                        validateResponse: (payload) =>
                            payload.roomId === sessionManager?.getRoomId(),
                        timeoutMessage: "Terminal close request timed out.",
                        waitForOpen: false,
                    }
                );

                sessionManager
                    .getTerminalShellIntegration()
                    .setTerminalFlag(false);

                showTmpNotification("Terminal successfully closed.");
            } catch (error) {
                vscode.window.showErrorMessage(
                    error instanceof Error ? error.message : String(error)
                );
            }
        }
    );

    // Command to request explorer open
    const requestExplorerOpenCommand = vscode.commands.registerCommand(
        "coducate.openExplorer",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            try {
                await sessionManager.sendWebSocketRequest(
                    "open_explorer_request",
                    { roomId: sessionManager.getRoomId() },
                    {
                        responseType: "open_explorer_response",
                        validateResponse: (payload) =>
                            payload.roomId === sessionManager?.getRoomId(),
                        timeoutMessage: "Explorer open request timed out.",
                        waitForOpen: false,
                    }
                );

                showTmpNotification("Explorer successfully opened.");
            } catch (error) {
                vscode.window.showErrorMessage(
                    error instanceof Error ? error.message : String(error)
                );
            }
        }
    );

    // Command to request explorer close
    const requestExplorerCloseCommand = vscode.commands.registerCommand(
        "coducate.closeExplorer",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            try {
                await sessionManager.sendWebSocketRequest(
                    "close_explorer_request",
                    { roomId: sessionManager.getRoomId() },
                    {
                        responseType: "close_explorer_response",
                        validateResponse: (payload) =>
                            payload.roomId === sessionManager?.getRoomId(),
                        timeoutMessage: "Explorer close request timed out.",
                        waitForOpen: false,
                    }
                );

                showTmpNotification("Explorer successfully closed.");
            } catch (error) {
                vscode.window.showErrorMessage(
                    error instanceof Error ? error.message : String(error)
                );
            }
        }
    );

    // Command to request show room ID
    const requestShowRoomIdCommand = vscode.commands.registerCommand(
        "coducate.showRoomId",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            try {
                await sessionManager.sendWebSocketRequest(
                    "show_room_id_request",
                    { roomId: sessionManager.getRoomId() },
                    {
                        responseType: "show_room_id_response",
                        validateResponse: (payload) =>
                            payload.roomId === sessionManager?.getRoomId(),
                        timeoutMessage: "Show room ID request timed out.",
                        waitForOpen: false,
                    }
                );

                showTmpNotification("Room ID successfully shown.");
            } catch (error) {
                vscode.window.showErrorMessage(
                    error instanceof Error ? error.message : String(error)
                );
            }
        }
    );

    // Command to hide room ID
    const requestHideRoomIdCommand = vscode.commands.registerCommand(
        "coducate.hideRoomId",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            try {
                await sessionManager.sendWebSocketRequest(
                    "hide_room_id_request",
                    { roomId: sessionManager.getRoomId() },
                    {
                        responseType: "hide_room_id_response",
                        validateResponse: (payload) =>
                            payload.roomId === sessionManager?.getRoomId(),
                        timeoutMessage: "Hide room ID request timed out.",
                        waitForOpen: false,
                    }
                );

                showTmpNotification("Room ID successfully hidden.");
            } catch (error) {
                vscode.window.showErrorMessage(
                    error instanceof Error ? error.message : String(error)
                );
            }
        }
    );

    // Command to change the font size
    const changeFontSizeCommand = vscode.commands.registerCommand(
        "coducate.changeFontSize",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage(
                    "No active session found. Please start a session first."
                );
                return;
            }

            const quickPick = vscode.window.createQuickPick();
            quickPick.items = [
                { label: "$(coducate-increase) Increase Font Size" },
                { label: "$(coducate-decrease) Decrease Font Size" },
            ];
            quickPick.title = "Change Font Size";
            quickPick.buttons = [vscode.QuickInputButtons.Back];

            quickPick.onDidTriggerButton(() => {
                quickPick.hide();
            });

            quickPick.onDidChangeSelection(async (selection) => {
                if (!selection[0] || !sessionManager) {
                    return;
                }

                const choice = selection[0].label;
                const increaseFontSize =
                    choice === "$(coducate-increase) Increase Font Size";

                try {
                    await sessionManager.sendWebSocketRequest(
                        "change_font_size_request",
                        {
                            roomId: sessionManager.getRoomId(),
                            increase: increaseFontSize,
                        },
                        {
                            responseType: "change_font_size_response",
                            validateResponse: (payload) =>
                                payload.roomId === sessionManager?.getRoomId(),
                            timeoutMessage:
                                "Change font size request timed out.",
                            waitForOpen: false,
                        }
                    );

                    showTmpNotification(
                        `Font size successfully ${
                            increaseFontSize ? "increased" : "decreased"
                        }.`
                    );
                } catch (error) {
                    vscode.window.showErrorMessage(
                        error instanceof Error ? error.message : String(error)
                    );

                    return;
                }

                // Clear the selection so the same item can be selected again
                quickPick.selectedItems = [];
            });

            // Add a proper disposal method when we want to close
            quickPick.onDidHide(() => {
                quickPick.dispose();
            });

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

            const theme = await vscode.window.showQuickPick([
                {
                    label: "$(coducate-dark-mode) Dark",
                    value: "dark",
                },
                { label: "$(coducate-light-mode) Light", value: "light" },
            ]);

            if (!theme) {
                return; // User canceled selection
            }

            try {
                await sessionManager.sendWebSocketRequest(
                    "change_theme_request",
                    {
                        changedTheme: theme.value,
                        roomId: sessionManager.getRoomId(),
                    },
                    {
                        responseType: "change_theme_response",
                        validateResponse: (payload) =>
                            payload.roomId === sessionManager?.getRoomId() &&
                            payload.changedTheme === theme.value,
                        timeoutMessage: "Change theme request timed out.",
                        waitForOpen: false,
                    }
                );

                showTmpNotification(
                    `Theme successfully changed to ${theme.value} mode.`
                );
            } catch (error) {
                vscode.window.showErrorMessage(
                    error instanceof Error ? error.message : String(error)
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
                        prompt: "Enter a title for the note.",
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

                    showTmpNotification(
                        `Note created at lines ${startLine + 1} to ${
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

            const choice = await vscode.window.showQuickPick(
                [
                    { label: "Insert at Cursor", value: "insert" },
                    { label: "Delete Note", value: "delete" },
                ],
                {
                    placeHolder: "What do you want to do with this note?",
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

                showTmpNotification(
                    `Code restored at lines ${
                        cursorLineStartPosition.line + 1
                    } to ${cursorLineStartPosition.line + numberOfLines}.`
                );
            } else if (choice.value === "delete") {
                // Delete the note
                notesCodeLensProvider?.removeNote(filePath, line);
                showTmpNotification("Note at line " + (line + 1) + " deleted.");
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

            const choice = await vscode.window.showQuickPick([
                {
                    label: "$(coducate-file) Remove all notes in this file",
                    value: "file",
                },
                {
                    label: "$(coducate-workspace) Remove all notes in this workspace",
                    value: "workspace",
                },
            ]);

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

            showTmpNotification(
                `Note-based suggestions ${
                    suggestionsEnabled ? "enabled" : "disabled"
                }.`
            );
        }
    );

    const reviewChangesCommand = vscode.commands.registerCommand(
        "coducate.reviewChanges",
        async () => {
            if (!sessionManager) {
                vscode.window.showErrorMessage("No active session found.");
                return;
            }
            
            const changeTracker = sessionManager.getChangeTracker();
            const filesWithChanges = changeTracker.getFilesWithChanges();
            
            if (filesWithChanges.length === 0) {
                vscode.window.showInformationMessage("No changes to review.");
                return;
            }

            const selected = await vscode.window.showQuickPick(filesWithChanges, {
                placeHolder: "Select a file to review changes"
            });

            if (selected) {
                await changeTracker.showDiff(selected);
            }
        }
    );

    context.subscriptions.push(
        startCommand,
        endCommand,
        manageSessionsCommand,
        copyRoomIdCommand,
        grantWriteAccessCommand,
        revokeWriteAccessCommand,
        createCoducateTerminalCommand,
        requestTerminalOpenCommand,
        requestTerminalCloseCommand,
        requestExplorerOpenCommand,
        requestExplorerCloseCommand,
        requestShowRoomIdCommand,
        requestHideRoomIdCommand,
        changeFontSizeCommand,
        changeThemeCommand,
        createNotesCommand,
        handleNoteActionCommand,
        removeNoteCommand,
        toggleSuggestionsCommand,
        reviewChangesCommand
    );
}

export function deactivate() {}
