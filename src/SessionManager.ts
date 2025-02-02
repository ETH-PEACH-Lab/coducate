import * as vscode from "vscode";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import path from "path";
import * as fs from "fs";
import { Awareness } from "y-protocols/awareness";
import * as os from "os";
import { WebSocket } from "ws";
import { DiffWatcher } from "./DiffWatcher";
import { NotesCodeLensProvider } from "./NotesCodeLensProvider";
import { InlineCompletionProvider } from "./InlineCompletionProvider";

// Extend WebSocket interface to include custom properties
interface CustomWebSocket extends WebSocket {
    isAlive?: boolean;
    pingTimeout?: NodeJS.Timeout;
    roomId?: string;
}

export class SessionManager {
    private provider: WebsocketProvider;
    private controlWebSocket: CustomWebSocket | null = null;
    private urlControlWebsocket: string;
    private reconnectAttempts: number = 0;
    private maxBackoffTime: number = 2500; // Maximum backoff time in milliseconds
    private shouldConnect: boolean = true; // Flag to manage connection state
    private roomId: string;
    private yDoc: Y.Doc;
    private awareness: Awareness;
    private fileYMap: Y.Map<Y.Text>; // A shared map to store file names and their corresponding Y.Text objects
    private excludedDirectories: Set<string> = new Set();
    private excludedFileExtensions: Set<string> = new Set();
    private diffWatcher: DiffWatcher;
    private notebookFilePath: string;
    private hasExecutedOpenTerminal: boolean = false;
    private notesCodeLensProvider: NotesCodeLensProvider;
    private inlineCompletionProvider: InlineCompletionProvider;
    private disposables: vscode.Disposable[] = [];

    constructor(
        urlYjs: string,
        urlControlWebsocket: string,
        roomId: string,
        context: vscode.ExtensionContext
    ) {
        this.roomId = roomId;
        this.yDoc = new Y.Doc();
        this.provider = new WebsocketProvider(urlYjs, roomId, this.yDoc, {
            WebSocketPolyfill: require("ws"),
        });

        // Bind methods
        this.toPosixPath = this.toPosixPath.bind(this);
        this.getRelativeFilePath = this.getRelativeFilePath.bind(this);

        // Initialize the control WebSocket
        this.urlControlWebsocket = urlControlWebsocket;
        this.initializeControlWebSocket();

        // Initialize awareness for the provider
        this.awareness = this.provider.awareness;

        // Initialize the shared file list in the Y.Doc
        this.fileYMap = this.yDoc.getMap("fileYMap");

        // Initialize the diff watcher
        this.diffWatcher = new DiffWatcher(this.fileYMap, context, this.roomId);

        // Initialize providers
        this.notesCodeLensProvider = new NotesCodeLensProvider(
            context,
            roomId,
            this.getRelativeFilePath
        );

        this.inlineCompletionProvider = new InlineCompletionProvider(
            this.notesCodeLensProvider
        );

        // Register providers
        const codeLensDisposable = vscode.languages.registerCodeLensProvider(
            { pattern: "**" },
            this.notesCodeLensProvider
        );
        const inlineCompletionDisposable =
            vscode.languages.registerInlineCompletionItemProvider(
                { pattern: "**" },
                this.inlineCompletionProvider
            );

        this.disposables.push(codeLensDisposable, inlineCompletionDisposable);

        // Load settings
        this.loadSettings();

        // Sync initial files from each workspace folder
        vscode.workspace.workspaceFolders?.forEach((folder) => {
            this.addAllFilesInWorkspaceFolder(
                this.toPosixPath(folder.uri.fsPath)
            );
        });

        this.notebookFilePath = path.posix.join(
            os.tmpdir(),
            `coducateNotebook_${this.roomId}.txt`
        );
        fs.writeFileSync(this.notebookFilePath, "");

        this.setupVSCodeListeners();
    }

    /*
     * Getter methods
     */

    public getProvider() {
        return this.provider;
    }

    public getAwareness() {
        return this.awareness;
    }

    public getFileYMap() {
        return this.fileYMap;
    }

    public getControlWebSocket() {
        return this.controlWebSocket;
    }

    public getRoomId() {
        return this.roomId;
    }

    public getNotesCodeLensProvider(): NotesCodeLensProvider {
        return this.notesCodeLensProvider;
    }

    public getInlineCompletionProvider(): InlineCompletionProvider {
        return this.inlineCompletionProvider;
    }

    public toPosixPath(filePath: string): string {
        return filePath.replace(/\\/g, "/");
    }

    /*
     * WebSocket connection management
     */

    private initializeControlWebSocket() {
        if (!this.shouldConnect) {
            return;
        }

        this.controlWebSocket = new WebSocket(
            this.urlControlWebsocket
        ) as CustomWebSocket;

        const ws = this.controlWebSocket;

        ws.onopen = () => {
            this.reconnectAttempts = 0; // Reset reconnect attempts
            if (ws.pingTimeout) {
                clearTimeout(ws.pingTimeout);
            }
        };

        ws.onclose = () => {
            if (ws.pingTimeout) {
                clearTimeout(ws.pingTimeout);
            }
            this.scheduleReconnect();
        };

        ws.onerror = () => {
            ws.close();
            this.scheduleReconnect();
        };

        // Heartbeat handling
        const heartbeat = () => {
            if (ws.pingTimeout) {
                clearTimeout(ws.pingTimeout);
            }

            // Set a timeout to terminate the connection if no ping is received
            ws.pingTimeout = setTimeout(() => {
                ws.terminate();
            }, 30000 + 1000); // 30 seconds (ping interval) + 1 second buffer
        };

        this.controlWebSocket.on("ping", heartbeat);
    }

    private scheduleReconnect() {
        if (!this.shouldConnect) {
            return;
        }

        const backoffTime = Math.min(
            Math.pow(2, this.reconnectAttempts) * 100,
            this.maxBackoffTime
        );

        setTimeout(() => {
            this.reconnectAttempts++;
            this.initializeControlWebSocket();
        }, backoffTime);
    }

    /*
     * VSCode event listeners
     */

    private setupVSCodeListeners() {
        // Listen to file renames
        vscode.workspace.onDidRenameFiles(async (event) => {
            for (const { oldUri, newUri } of event.files) {
                const oldFilePath = oldUri.fsPath;
                const newFilePath = newUri.fsPath;
                const oldRelativePath = this.getRelativeFilePath(oldFilePath);
                const newRelativePath = this.getRelativeFilePath(newFilePath);

                // Check if it's a file or a directory
                const fileStat = await vscode.workspace.fs.stat(newUri);
                if (fileStat.type === vscode.FileType.File) {
                    // Rename single file in fileYMap
                    await this.renameFileInYMap(
                        oldRelativePath,
                        newRelativePath
                    );
                } else if (fileStat.type === vscode.FileType.Directory) {
                    // Rename folder and all files within it
                    await this.renameAllFilesInDirectory(
                        oldRelativePath,
                        newRelativePath
                    );
                }
            }
        });

        // Listen to workspace folder changes
        vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
            // Handle added workspace folders
            for (const addedFolder of event.added) {
                const folderPath = addedFolder.uri.fsPath;

                // Add all files in the new folder to fileYMap
                await this.addAllFilesInWorkspaceFolder(folderPath);
            }

            // Handle removed workspace folders
            for (const removedFolder of event.removed) {
                // Remove all files in the folder from fileYMap
                this.removeAllFilesInWorkspaceFolder(removedFolder.name);
            }
        });

        // Listen to file changes
        vscode.workspace.onDidChangeTextDocument(async (event) => {
            if (event.document === vscode.window.activeTextEditor?.document) {
                const relativePath = this.getRelativeFilePath(
                    event.document.fileName
                );
                if (!relativePath) {
                    return; // Ignore files that cannot be resolved to a relative path
                }

                // Warn the instructor if the file has differences tracked in DiffWatcher
                if (
                    this.diffWatcher &&
                    this.diffWatcher.getDiffFilesSet().has(relativePath)
                ) {
                    await vscode.window.showWarningMessage(
                        `${relativePath} contains changes from clients. Please resolve these changes before editing the file.`,
                        "Ok"
                    );
                }

                this.applyIncrementalChanges(
                    relativePath,
                    event.contentChanges
                );
            }
        });

        // Listen to cursor movement and selection changes
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (event.textEditor === vscode.window.activeTextEditor) {
                const relativeFilePath = this.getRelativeFilePath(
                    event.textEditor.document.fileName
                );
                const position = event.selections[0].active;
                const selection = event.selections[0];
                const clientState = {
                    filePath: relativeFilePath,
                    cursorPosition: {
                        line: position.line,
                        column: position.character,
                    },
                    selectionRange: {
                        start: {
                            line: selection.start.line,
                            column: selection.start.character,
                        },
                        end: {
                            line: selection.end.line,
                            column: selection.end.character,
                        },
                    },
                };
                this.awareness.setLocalStateField("vsCodeClient", clientState);
            }
        });

        // Listen for active editor changes (e.g., when a different file is opened)
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                const relativeFilePath = this.getRelativeFilePath(
                    editor.document.fileName
                );
                const position = editor.selections[0].active;
                const selection = editor.selections[0];
                const clientState = {
                    filePath: relativeFilePath,
                    cursorPosition: {
                        line: position.line,
                        column: position.character,
                    },
                    selectionRange: {
                        start: {
                            line: selection.start.line,
                            column: selection.start.character,
                        },
                        end: {
                            line: selection.end.line,
                            column: selection.end.character,
                        },
                    },
                };
                this.awareness.setLocalStateField("vsCodeClient", clientState);

                // Send the instructor file name to the server
                if (
                    this.controlWebSocket &&
                    this.controlWebSocket.readyState === WebSocket.OPEN &&
                    relativeFilePath &&
                    this.fileYMap.has(relativeFilePath)
                ) {
                    try {
                        // Send the instructor file name to the server
                        this.controlWebSocket.send(
                            JSON.stringify({
                                type: "set_instructor_file_request",
                                payload: {
                                    roomId: this.roomId,
                                    instructorFile: relativeFilePath,
                                },
                            })
                        );
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            `Failed to send instructor file: ${
                                (error as Error).message
                            }`
                        );
                    }
                }
            }
        });

        // Listen to file creation
        vscode.workspace.onDidCreateFiles(async (event) => {
            for (const file of event.files) {
                const filePath = file.fsPath;
                const relativeFilePath = this.getRelativeFilePath(filePath);

                // Check if it's a file or a directory
                const fileStat = await vscode.workspace.fs.stat(file);
                if (fileStat.type === vscode.FileType.File) {
                    // Add single file to fileYMap
                    await this.addFileToYMap(filePath, relativeFilePath);
                }
            }
        });

        // Listen to file deletion
        vscode.workspace.onDidDeleteFiles(async (event) => {
            for (const file of event.files) {
                const filePath = file.fsPath;
                const relativeFilePath = this.getRelativeFilePath(filePath);

                // Check if any entries in fileYMap start with the folder path
                const isFolder = Array.from(this.fileYMap.keys()).some((key) =>
                    key.startsWith(relativeFilePath + path.posix.sep)
                );

                if (isFolder) {
                    // If it's a folder, delete all entries within that path
                    for (const key of Array.from(this.fileYMap.keys())) {
                        if (key.startsWith(relativeFilePath + path.posix.sep)) {
                            this.fileYMap.delete(key);
                        }
                    }
                } else {
                    // If it's a single file, delete only that specific entry
                    if (this.fileYMap.has(relativeFilePath)) {
                        this.fileYMap.delete(relativeFilePath);
                    }
                }
            }
        });

        // Listen to changes in notebook cells
        vscode.workspace.onDidChangeNotebookDocument((event) => {
            this.handleCellChanges(event);

            // Execute the command only once on the first trigger
            if (!this.hasExecutedOpenTerminal) {
                // Request the terminal to open
                vscode.commands.executeCommand("coducate.openTerminal");
                this.hasExecutedOpenTerminal = true;
            }
        });

        // Listen to notebook close events
        vscode.workspace.onDidCloseNotebookDocument(() => {
            // Request the terminal to close
            vscode.commands.executeCommand("coducate.closeTerminal");
            this.hasExecutedOpenTerminal = false;
        });
    }

    /*
     * Notebook Cell Output Handling
     */

    // Function to determine the MIME type of the item based on its mime property
    private getMimeType(mime: string): string {
        if (mime.includes("image/png")) {
            return "image/png";
        }
        if (mime.includes("image/jpeg")) {
            return "image/jpeg";
        }
        if (mime.includes("image/gif")) {
            return "image/gif";
        }
        if (mime.includes("text/html")) {
            return "text/html";
        }
        if (mime.includes("application/json")) {
            return "application/json";
        }
        return "text/plain"; // Default to text/plain if unknown mime
    }

    // Function to convert UInt8Array to either Base64 or Blob (for images)
    private convertBinaryData(
        uint8Array: Uint8Array,
        mimeType: string
    ): string | Blob {
        const MAX_SIZE_FOR_BASE64 = 50000; // Define a threshold size for Base64 (adjust as needed)

        // If the binary data is small, convert it to Base64
        if (uint8Array.length < MAX_SIZE_FOR_BASE64) {
            return Buffer.from(uint8Array).toString("base64");
        } else {
            // Otherwise, create a Blob (for larger files)
            return new Blob([uint8Array], { type: mimeType });
        }
    }

    // Function to extract cell outputs from a notebook cell
    private getCellOutputs(
        cell: vscode.NotebookCell
    ): { mime: string; data: string | Blob }[] {
        const outputs = [];

        for (const output of cell.outputs) {
            if (output.items) {
                for (const item of output.items) {
                    const mimeType = this.getMimeType(item.mime);
                    // Convert the UInt8Array to Base64 or Blob based on the data size
                    const data = this.convertBinaryData(item.data, mimeType);
                    outputs.push({
                        mime: mimeType,
                        data: data,
                    });
                }
            }
        }

        return outputs;
    }

    //  Function to handle changes in notebook cells
    private handleCellChanges(event: vscode.NotebookDocumentChangeEvent) {
        event.cellChanges.forEach((change) => {
            // Handle only changes in cell outputs
            if (change.outputs) {
                const cell = change.cell;
                const cellOutputs = this.getCellOutputs(cell);
                if (cellOutputs.length > 0) {
                    this.addOutputToYMap(
                        this.notebookFilePath,
                        JSON.stringify(cellOutputs)
                    );
                }
            }
        });
    }

    /*
     * Settings and File Management
     */

    // Function to request the task description and learning goals paths from the server
    public async requestTaskData(roomId: string) {
        let taskData: {
            taskDescriptionPath: string;
            learningGoalsPath: string;
        } = {
            taskDescriptionPath: "",
            learningGoalsPath: "",
        };

        const getTaskDataResponse = async () => {
            return new Promise<boolean>((resolve, reject) => {
                if (!this.controlWebSocket) {
                    return reject(
                        new Error("WebSocket connection not available.")
                    );
                }

                let timeout: NodeJS.Timeout | undefined;

                // Define a unique message event handler
                const handleServerResponse = (event: any) => {
                    try {
                        const message =
                            typeof event.data === "string"
                                ? event.data
                                : event.toString();
                        const { type, payload } = JSON.parse(message);

                        if (
                            type === "get_task_data_response" &&
                            payload.roomId === roomId
                        ) {
                            taskData.taskDescriptionPath =
                                payload.taskDescriptionPath;
                            taskData.learningGoalsPath =
                                payload.learningGoalsPath;
                            resolve(true);
                        }
                    } catch (error) {
                        reject(
                            new Error("Invalid response format from server.")
                        );
                    } finally {
                        cleanup();
                    }
                };

                // Cleanup function for timeout and event listener
                const cleanup = () => {
                    if (timeout) {
                        clearTimeout(timeout);
                    }
                    this.controlWebSocket?.removeEventListener(
                        "message",
                        handleServerResponse
                    );
                };

                // Attach the event listener
                this.controlWebSocket.addEventListener(
                    "message",
                    handleServerResponse
                );

                // Send the request when the connection is open
                const sendRequest = () => {
                    this.controlWebSocket?.send(
                        JSON.stringify({
                            type: "get_task_data_request",
                            payload: { roomId },
                        })
                    );
                };

                if (this.controlWebSocket.readyState === WebSocket.OPEN) {
                    sendRequest();
                } else if (
                    this.controlWebSocket.readyState === WebSocket.CONNECTING
                ) {
                    this.controlWebSocket.addEventListener(
                        "open",
                        sendRequest,
                        { once: true }
                    );
                } else {
                    return reject(
                        new Error("WebSocket connection not available.")
                    );
                }

                // Set a timeout to reject the promise if no response is received
                timeout = setTimeout(() => {
                    reject(new Error("Request timed out."));
                    cleanup();
                }, 5000);
            });
        };

        try {
            const success = await getTaskDataResponse();
            if (success) {
                return taskData;
            }
        } catch (error) {
            vscode.window.showErrorMessage(
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    /**
     * Sends a WebSocket request and waits for a response.
     * @param {WebSocket} controlWebSocket - The WebSocket connection.
     * @param {string} requestType - The type of request to send.
     * @param {string} responseType - The expected response type.
     * @param {any} payload - The payload to send with the request.
     * @param {(payload: any) => boolean} validateResponse - Function to validate if the response matches expectations.
     * @param {number} timeoutMs - Timeout duration in milliseconds (default 5000ms).
     * @param {string} timeoutMessage - Custom message to display if the request times out.
     * @returns {Promise<any>} - Resolves with the response payload or rejects with an error.
     */
    public sendWebSocketRequest = async (
        controlWebSocket: WebSocket,
        requestType: string,
        responseType: string,
        payload: any,
        validateResponse: (payload: any) => boolean,
        timeoutMs: number = 5000,
        timeoutMessage?: string
    ): Promise<any> => {
        return new Promise((resolve, reject) => {
            if (
                !controlWebSocket ||
                controlWebSocket.readyState !== WebSocket.OPEN
            ) {
                return reject(new Error("WebSocket connection not available."));
            }

            let timeout: NodeJS.Timeout | undefined;

            const handleServerResponse = (event: any) => {
                try {
                    // Convert event.data to a string if needed
                    const message =
                        typeof event.data === "string"
                            ? event.data
                            : event.data.toString();

                    const { type, payload: responsePayload } =
                        JSON.parse(message);
                    if (
                        type === responseType &&
                        validateResponse(responsePayload)
                    ) {
                        cleanup();
                        resolve(responsePayload);
                    }
                } catch (error) {
                    console.error(
                        `Invalid JSON from WebSocket (${responseType}):`,
                        error
                    );
                }
            };

            const cleanup = () => {
                if (timeout) {
                    clearTimeout(timeout);
                }
                controlWebSocket.removeEventListener(
                    "message",
                    handleServerResponse
                );
            };

            // Attach event listener for the response
            controlWebSocket.addEventListener("message", handleServerResponse);

            // Send the request
            try {
                controlWebSocket.send(
                    JSON.stringify({
                        type: requestType,
                        payload,
                    })
                );
            } catch (error) {
                cleanup();
                return reject(
                    new Error(
                        `Failed to send request: ${(error as Error).message}`
                    )
                );
            }

            // Set a timeout in case of no response
            timeout = setTimeout(() => {
                cleanup();
                reject(
                    timeoutMessage
                        ? timeoutMessage
                        : new Error(`${requestType} request timed out`)
                );
            }, timeoutMs);
        });
    };

    // Function to get the relative file path within the workspace
    public getRelativeFilePath(filePath: string): string {
        const normalizedFilePath = this.toPosixPath(filePath);
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(
            (folder) =>
                normalizedFilePath.startsWith(
                    this.toPosixPath(folder.uri.fsPath) + path.posix.sep
                )
        );

        if (workspaceFolder) {
            const workspaceFolderPath = this.toPosixPath(
                workspaceFolder.uri.fsPath
            );
            const relativePath = path.posix.relative(
                workspaceFolderPath,
                normalizedFilePath
            );
            return `${workspaceFolder.name}/${relativePath}`;
        }

        return normalizedFilePath; // Return absolute path if file is not within any workspace folder
    }

    // Function to get all file names from files in fileYMap which have a specific file extension
    public getFilesByExtension(extension: string): string[] {
        const filesWithExtension = Array.from(this.fileYMap.keys()).filter(
            (key) => key.endsWith(extension)
        );

        return filesWithExtension;
    }

    // Function to check if a file has changes tracked in DiffWatcher
    public hasChangesTracked(filePath: string): boolean {
        return this.diffWatcher?.getDiffFilesSet().has(filePath) || false;
    }

    // Function to handle changes in excluded file extensions
    private async handleFileExtensionChanges(
        oldExcluded: Set<string>,
        newExcluded: Set<string>
    ) {
        const addedExtensions = Array.from(newExcluded).filter(
            (ext) => !oldExcluded.has(ext)
        );
        const removedExtensions = Array.from(oldExcluded).filter(
            (ext) => !newExcluded.has(ext)
        );

        // Remove files with newly excluded extensions
        for (const ext of addedExtensions) {
            const fileHasExtension = (file: string) => file.endsWith(ext);

            let hasChanges = false;
            for (const file of this.fileYMap.keys()) {
                if (fileHasExtension(file) && this.hasChangesTracked(file)) {
                    hasChanges = true;
                    await vscode.window.showWarningMessage(
                        `${file} contains client changes. Please resolve these changes before excluding the file extension.`,
                        "Ok"
                    );

                    // Remove the file extension from the excluded list in the settings
                    await this.removeSettingValue(
                        "excludedFileExtensions",
                        ext
                    );

                    break;
                }
            }

            if (!hasChanges) {
                await this.removeFilesByExtension(ext);
            }
        }

        // Add back files with newly included extensions
        for (const ext of removedExtensions) {
            await this.addFilesByExtension(ext);
        }
    }

    // Function to handle changes in excluded file extensions
    private async handleDirectoryChanges(
        oldExcluded: Set<string>,
        newExcluded: Set<string>
    ) {
        const addedDirectories = Array.from(newExcluded).filter(
            (dir) => !oldExcluded.has(dir)
        );
        const removedDirectories = Array.from(oldExcluded).filter(
            (dir) => !newExcluded.has(dir)
        );

        const fileIsInDirectory = (file: string, dir: string) =>
            file.startsWith(`${dir}/`) ||
            file.includes(`/${dir}/`) ||
            file.endsWith(`/${dir}`);

        // Remove newly excluded directories and their files
        for (const dir of addedDirectories) {
            let hasChanges = false;
            for (const file of this.fileYMap.keys()) {
                if (
                    fileIsInDirectory(file, dir) &&
                    this.hasChangesTracked(file)
                ) {
                    hasChanges = true;
                    await vscode.window.showWarningMessage(
                        `${dir} contains files with client changes. Please resolve these changes before excluding the directory.`,
                        "Ok"
                    );

                    // Remove the directory from the excluded list in settings
                    await this.removeSettingValue("excludedDirectories", dir);

                    break;
                }
            }

            if (!hasChanges) {
                await this.removeAllFilesInDirectory(dir);
            }
        }

        // Add back files from newly included directories
        for (const dir of removedDirectories) {
            await this.addAllFilesInDirectory(dir);
        }
    }

    // Function to load settings
    // It prioritizes the settings with changes (user or workspace settings) with regards to the default values
    // If both user and workspace settings have changes, the workspace settings take precedence
    private loadSettings() {
        // Fetch configuration settings
        const config = vscode.workspace.getConfiguration("coducate");

        const excludedDirs = config.get<string[]>("excludedDirectories", []);
        const excludedExts = config.get<string[]>("excludedFileExtensions", []);

        const oldExcludedDirectories = this.excludedDirectories;
        const oldExcludedFileExtensions = this.excludedFileExtensions;

        this.excludedDirectories = new Set(excludedDirs);
        this.excludedFileExtensions = new Set(excludedExts);

        // Handle changes in excluded directories
        this.handleDirectoryChanges(
            oldExcludedDirectories,
            this.excludedDirectories
        );

        // Handle changes in excluded file extensions
        this.handleFileExtensionChanges(
            oldExcludedFileExtensions,
            this.excludedFileExtensions
        );

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration("coducate.excludedDirectories") ||
                event.affectsConfiguration("coducate.excludedFileExtensions")
            ) {
                this.loadSettings();
            }
        });
    }

    // Function to check if a file is excluded in settings
    private isExcludedFile(filePath: string): boolean {
        const normalizedPath = this.toPosixPath(filePath);
        const fileExtension = path.extname(normalizedPath);
        return this.excludedFileExtensions.has(fileExtension);
    }

    // Function to check if a directory is excluded in settings
    private isExcludedDirectory(filePath: string): boolean {
        const normalizedPath = this.toPosixPath(filePath);
        const pathSegments = normalizedPath.split(path.posix.sep);
        return pathSegments.some((segment) =>
            this.excludedDirectories.has(segment)
        );
    }

    // Function to add an output to fileYMap
    public addOutputToYMap(outputFilePath: string, content: string) {
        const yText = new Y.Text();
        yText.insert(0, content);
        const relativeFilePath = this.getRelativeFilePath(outputFilePath);
        this.fileYMap.set(relativeFilePath, yText);
    }

    // Function to add a single file to fileYMap
    public async addFileToYMap(filePath: string, relativeFilePath: string) {
        if (
            !this.fileYMap.has(relativeFilePath) &&
            !this.isExcludedDirectory(filePath) &&
            !this.isExcludedFile(filePath)
        ) {
            const yText = new Y.Text();
            this.fileYMap.set(relativeFilePath, yText);

            try {
                const document = await vscode.workspace.openTextDocument(
                    filePath
                );
                const content = document.getText();
                yText.insert(0, content);
            } catch (error) {}
        }
    }

    // Function to add all files with a specific extension to fileYMap
    private async addFilesByExtension(extension: string) {
        const workspaces = vscode.workspace.workspaceFolders;

        if (!workspaces) {
            return;
        }

        for (const workspace of workspaces) {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(
                    workspace.uri.fsPath,
                    `**/*${extension}`
                )
            );

            for (const file of files) {
                const normalizedFilePath = this.toPosixPath(file.fsPath);
                const relativeFilePath =
                    this.getRelativeFilePath(normalizedFilePath);

                if (
                    !this.isExcludedDirectory(normalizedFilePath) &&
                    !this.isExcludedFile(normalizedFilePath)
                ) {
                    const fileStat = await vscode.workspace.fs.stat(file);
                    if (fileStat.type === vscode.FileType.File) {
                        await this.addFileToYMap(
                            normalizedFilePath,
                            relativeFilePath
                        );
                    }
                }
            }
        }
    }

    // Function to add all files within a directory to fileYMap
    private async addAllFilesInDirectory(dir: string) {
        const workspaces = vscode.workspace.workspaceFolders;

        if (!workspaces) {
            return;
        }

        const filesToAdd: vscode.Uri[] = [];

        for (const workspace of workspaces) {
            const normalizedWorkspacePath = this.toPosixPath(
                workspace.uri.fsPath
            );

            // Match files in the workspace folder or subdirectories containing `dir`
            const pattern = `**/${dir}/**/*`;

            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(workspace, pattern)
            );

            filesToAdd.push(...files);

            // Check if the `dir` itself is the workspace root
            if (normalizedWorkspacePath.endsWith(`/${dir}`)) {
                // Search all files and directories directly within the `dir` workspace
                const rootFiles = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(workspace, "**/*")
                );

                filesToAdd.push(...rootFiles);
            }
        }

        for (const file of filesToAdd) {
            const normalizedFilePath = this.toPosixPath(file.fsPath);
            const relativeFilePath =
                this.getRelativeFilePath(normalizedFilePath);

            // Skip files in excluded directories or with excluded extensions
            if (
                this.isExcludedDirectory(normalizedFilePath) ||
                this.isExcludedFile(normalizedFilePath)
            ) {
                continue;
            }

            const fileStat = await vscode.workspace.fs.stat(file);
            if (fileStat.type === vscode.FileType.File) {
                await this.addFileToYMap(normalizedFilePath, relativeFilePath);
            }
        }
    }

    // Function to add all files within a workspace folder to fileYMap
    private async addAllFilesInWorkspaceFolder(folderPath: string) {
        const normalizedFolderPath = this.toPosixPath(folderPath);

        // Find all files in the created directory
        const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(normalizedFolderPath, "**/*")
        );

        for (const file of files) {
            const normalizedFilePath = this.toPosixPath(file.fsPath);
            const relativeFilePath =
                this.getRelativeFilePath(normalizedFilePath);

            // Skip files in excluded directories
            if (
                this.isExcludedDirectory(normalizedFilePath) ||
                this.isExcludedFile(normalizedFilePath)
            ) {
                continue;
            }

            const fileStat = await vscode.workspace.fs.stat(file);
            if (fileStat.type === vscode.FileType.File) {
                await this.addFileToYMap(normalizedFilePath, relativeFilePath);
            }
        }
    }

    // Function to remove all files with a specific extension from fileYMap
    private async removeFilesByExtension(extension: string) {
        const taskData = await this.requestTaskData(this.roomId);
        for (const key of Array.from(this.fileYMap.keys())) {
            if (key.endsWith(extension)) {
                if (key === taskData?.taskDescriptionPath) {
                    vscode.window.showWarningMessage(
                        `Cannot remove ${key} from synchronization. This file is used as the task description.`,
                        "Ok"
                    );
                    continue;
                } else if (key === taskData?.learningGoalsPath) {
                    vscode.window.showWarningMessage(
                        `Cannot remove ${key} from synchronization. This file is used as the learning goals.`,
                        "Ok"
                    );
                    continue;
                }

                this.fileYMap.delete(key);
            }
        }
    }

    // Function to remove all files within a directory from fileYMap
    private async removeAllFilesInDirectory(dir: string) {
        const taskData = await this.requestTaskData(this.roomId);
        for (const key of Array.from(this.fileYMap.keys())) {
            if (
                key.startsWith(`${dir}/`) ||
                key.includes(`/${dir}/`) ||
                key.endsWith(`/${dir}`)
            ) {
                if (key === taskData?.taskDescriptionPath) {
                    vscode.window.showWarningMessage(
                        `Cannot remove ${key} from synchronization. This file is used as the task description.`,
                        "Ok"
                    );
                    continue;
                } else if (key === taskData?.learningGoalsPath) {
                    vscode.window.showWarningMessage(
                        `Cannot remove ${key} from synchronization. This file is used as the learning goals.`,
                        "Ok"
                    );
                    continue;
                }

                this.fileYMap.delete(key);
            }
        }
    }

    // Function to remove all files within a workspace folder from fileYMap
    private async removeAllFilesInWorkspaceFolder(dir: string) {
        for (const key of Array.from(this.fileYMap.keys())) {
            if (key.startsWith(`${dir}/`)) {
                this.fileYMap.delete(key);
            }
        }
    }

    /**
     * Removes a value from a specified setting key (`excludedDirectories` or `excludedFileExtensions`).
     * If the setting becomes empty and matches the default, it is reset to `undefined` to ensure VS Code properly reverts to default settings.
     */
    private async removeSettingValue(settingKey: string, value: string) {
        const config = vscode.workspace.getConfiguration("coducate");

        const settingValues = config.get<string[]>(settingKey, []);

        if (!settingValues.includes(value)) {
            return;
        }

        // Remove the value from the list
        const updatedValues = settingValues.filter((v) => v !== value);

        // Retrieve the default values dynamically using `inspect`
        const defaultValues = this.getDefaultValuesFromInspect(
            config,
            settingKey
        );

        // Determine whether the setting exists in workspace or user settings
        const configurationTarget = await this.getConfigurationTarget(
            config,
            settingKey
        );

        if (this.areArraysEqual(defaultValues, updatedValues)) {
            // If the updated list matches the default values, reset to `undefined` (default values)
            await config.update(settingKey, undefined, configurationTarget);
        }
    }

    /**
     * Determines whether a setting is stored in the workspace or user settings.
     * Returns the appropriate `ConfigurationTarget` value.
     */
    private async getConfigurationTarget(
        config: vscode.WorkspaceConfiguration,
        settingKey: string
    ): Promise<vscode.ConfigurationTarget> {
        const workspaceValue = config.inspect(settingKey)?.workspaceValue;
        return workspaceValue !== undefined
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
    }

    /**
     * Retrieves the default values for a given setting using `inspect`.
     */
    private getDefaultValuesFromInspect(
        config: vscode.WorkspaceConfiguration,
        settingKey: string
    ): string[] {
        return config.inspect<string[]>(settingKey)?.defaultValue || [];
    }

    /**
     * Checks if two arrays contain the same elements (ignoring order).
     */
    private areArraysEqual(array1: string[], array2: string[]): boolean {
        if (array1.length !== array2.length) {
            return false;
        }
        const sorted1 = [...array1].sort();
        const sorted2 = [...array2].sort();
        return sorted1.every((val, index) => val === sorted2[index]);
    }

    // Function to handle renaming of files or directories with added safety checks
    private async renameFileInYMap(
        oldRelativePath: string,
        newRelativePath: string
    ) {
        // Check if the old path exists in fileYMap
        const oldYText = this.fileYMap.get(oldRelativePath);

        if (oldYText) {
            // Create a new Y.Text instance if necessary for the new path
            const newYText = this.fileYMap.has(newRelativePath)
                ? this.fileYMap.get(newRelativePath)
                : new Y.Text();

            // Copy the content from the old Y.Text instance to the new one
            if (newYText && oldYText.toString()) {
                newYText.insert(0, oldYText.toString());
            }

            if (newYText) {
                // Remove the old entry and add the new one
                this.fileYMap.delete(oldRelativePath);
                this.fileYMap.set(newRelativePath, newYText);
            }
        }
    }

    // Function to rename all files within a directory in fileYMap
    private async renameAllFilesInDirectory(
        oldRelativePath: string,
        newRelativePath: string
    ) {
        const normalizedOldPath = this.toPosixPath(oldRelativePath);
        const normalizedNewPath = this.toPosixPath(newRelativePath);

        // Find all entries in fileYMap that start with the old folder path
        const keysToRename = Array.from(this.fileYMap.keys()).filter((key) =>
            key.startsWith(normalizedOldPath + path.posix.sep)
        );

        for (const oldKey of keysToRename) {
            const newKey = oldKey.replace(normalizedOldPath, normalizedNewPath);
            // Reuse renameFileInYMap to handle each file rename
            await this.renameFileInYMap(oldKey, newKey);
        }
    }

    // Function to apply incremental changes to Y.Text objects
    private applyIncrementalChanges(
        relativePath: string,
        contentChanges: readonly vscode.TextDocumentContentChangeEvent[]
    ) {
        const yText = this.fileYMap.get(relativePath);
        if (!yText) {
            return;
        }

        contentChanges.forEach((change) => {
            const start = change.rangeOffset;
            const length = change.rangeLength;

            if (length > 0) {
                yText.delete(start, length);
            }

            if (change.text.length > 0) {
                yText.insert(start, change.text);
            }
        });
    }

    /*
     * Cleanup and Disposal
     */

    public dispose() {
        // Prevent WebSocket reconnections
        this.shouldConnect = false;

        // Disconnect and clean up the provider
        if (this.provider) {
            this.provider.disconnect();
            this.provider.destroy();
        }

        // Destroy the Yjs document
        if (this.yDoc) {
            this.yDoc.destroy();
        }

        // Reset awareness state
        if (this.awareness) {
            this.awareness.setLocalState(null);
        }

        // Close the control WebSocket safely
        if (this.controlWebSocket) {
            if (
                this.controlWebSocket.readyState === WebSocket.OPEN ||
                this.controlWebSocket.readyState === WebSocket.CONNECTING
            ) {
                this.controlWebSocket.close();
            }
            this.controlWebSocket = null;
        }

        // Dispose the diff watcher
        if (this.diffWatcher) {
            this.diffWatcher.dispose();
        }

        // Dispose all registered disposables
        if (this.disposables.length > 0) {
            this.disposables.forEach((disposable) => disposable.dispose());
            this.disposables = [];
        }
    }
}
