import * as vscode from "vscode";
import ReconnectingWebSocket, { ErrorEvent } from "reconnecting-websocket";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import path from "path";
import { NotesCodeLensProvider } from "./NotesCodeLensProvider";
import { InlineCompletionProvider } from "./InlineCompletionProvider";
import { TerminalShellIntegration } from "./TerminalShellIntegration";
import { YTextVSCodeBinding } from "./YTextVSCodeBinding";
import { ChangeTracker } from "./ChangeTracker";

export class SessionManager {
    private wsControl: ReconnectingWebSocket;
    private provider: WebsocketProvider;
    private roomId: string;
    private yDoc: Y.Doc;
    private fileYMap: Y.Map<Y.Text>; // A shared map to store file names and their corresponding Y.Text objects
    private excludedDirectories: Set<string> = new Set();
    private excludedFileExtensions: Set<string> = new Set();
    private notesCodeLensProvider: NotesCodeLensProvider;
    private inlineCompletionProvider: InlineCompletionProvider;
    private terminalShellIntegration: TerminalShellIntegration;
    private status: vscode.StatusBarItem;
    private disposables: vscode.Disposable[] = [];
    private isFlushing = false; // Flag to prevent multiple flushes
    private pendingRequests: Array<() => void> = []; // Store requests that are waiting for WebSocket to open
    private pendingResponses: Record<
        string,
        Record<string, Array<(data: any) => void>>
    > = {}; // Store pending responses for each roomId and responseType
    
    private ytextBindings: Map<string, YTextVSCodeBinding> = new Map();
    private changeTracker: ChangeTracker;

    constructor(
        roomId: string,
        status: vscode.StatusBarItem,
        context: vscode.ExtensionContext
    ) {
        const { yjsWebSocketUrl, controlWebSocketUrl } =
            this.getWebSocketUrls(context);
        this.roomId = roomId;
        this.yDoc = new Y.Doc();
        this.provider = new WebsocketProvider(
            yjsWebSocketUrl,
            roomId,
            this.yDoc,
            {
                WebSocketPolyfill: require("ws"),
            }
        );

        // Create status bar for changes
        const changesStatus = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            98  // Show next to your main status bar
        );

        this.changeTracker = new ChangeTracker(context, roomId, changesStatus);

        this.changeTracker.setGetFileUri((relativePath) => this.getFileUriForPath(relativePath));

        this.changeTracker.setOnAccept(async (relativePath) => {
            await this.handleAcceptCurrentVersion(relativePath);
        });

        this.changeTracker.setOnRollback(async (relativePath) => {
            await this.handleRollbackChanges(relativePath);
        });

        // Separate WebSocket for custom messages
        const bcChannelControlUrl = controlWebSocketUrl + "/" + roomId;
        this.wsControl = new ReconnectingWebSocket(bcChannelControlUrl, [], {
            WebSocket: WebSocket,
        });

        // Bind methods
        this.toPosixPath = this.toPosixPath.bind(this);
        this.getRelativeFilePath = this.getRelativeFilePath.bind(this);

        // Initialize the status bar
        this.status = status;

        // Add WebSocket event listeners
        this.addWebSocketListeners();

        // Initialize the shared file list in the Y.Doc
        this.fileYMap = this.yDoc.getMap("fileYMap");

        // Observe all files for changes (even unopened files)
        this.fileYMap.observeDeep((events) => {
            for (const event of events) {
                if (event.target instanceof Y.Text) {
                    const relativePath = event.path[0] as string;
                    if (event.transaction?.origin !== 'vscode-instructor') {
                        this.changeTracker.recordChange(relativePath);
                    }
                }
            }
        });

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

        // Initialize terminal shell integration
        this.terminalShellIntegration = new TerminalShellIntegration(
            context,
            this
        );

        // Load settings
        this.loadSettings();

        // Sync initial files from each workspace folder
        vscode.workspace.workspaceFolders?.forEach((folder) => {
            this.addAllFilesInWorkspaceFolder(
                this.toPosixPath(folder.uri.fsPath)
            );
        });

        const listenerDisposables = this.setupVSCodeListeners();

        // Track disposables for cleanup in the dispose method
        this.disposables.push(codeLensDisposable, inlineCompletionDisposable);
        this.disposables.push(...listenerDisposables);
        context.subscriptions.push(...this.disposables);

        // Create bindings for documents that are already open (important after VS Code reload)
        this.provider.on('sync', async (isSynced: boolean) => {
            if (isSynced) {
                await this.createBindingsForOpenDocuments();
            }
        });
    }

    /*
     * Getter methods
     */

    public getProvider() {
        return this.provider;
    }

    public getFileYMap() {
        return this.fileYMap;
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

    public getTerminalShellIntegration(): TerminalShellIntegration {
        return this.terminalShellIntegration;
    }

    public toPosixPath(filePath: string): string {
        return filePath.replace(/\\/g, "/");
    }

    public getChangeTracker(): ChangeTracker {
        return this.changeTracker;
    }

    public getBinding(relativePath: string): YTextVSCodeBinding | undefined {
        return this.ytextBindings.get(relativePath);
    }

    private getWebSocketUrls(context: vscode.ExtensionContext) {
        // Define WebSocket protocol and host
        const webSocketProtocol =
            context.extensionMode === vscode.ExtensionMode.Production
                ? "wss:"
                : "ws:";
        const webSocketHost =
            context.extensionMode === vscode.ExtensionMode.Production
                ? "coducate.me"
                : "localhost:1234";

        // Define WebSocket URLs
        const yjsWebSocketUrl = `${webSocketProtocol}//${webSocketHost}/yjs`;
        const controlWebSocketUrl = `${webSocketProtocol}//${webSocketHost}/control`;

        return { yjsWebSocketUrl, controlWebSocketUrl };
    }

    private addWebSocketListeners() {
        const handleOpen = () => {
            // Set status bar to synchronized
            this.status.text = "$(sync) Coducate";
            this.status.tooltip = this.roomId;
            this.status.command = {
                title: "Copy Room ID",
                command: "coducate.copyRoomId",
                arguments: [this.roomId],
            };
        };

        const handleClose = () => {
            // Set status bar to not synchronized
            this.status.text = "$(debug-disconnect) Coducate";
        };

        const handleError = (errorEvent: ErrorEvent) => {
            // Set status bar to not synchronized
            this.status.text = "$(debug-disconnect) Coducate";
        };

        const handleMessage = (event: MessageEvent) => {
            try {
                const { type: responseType, payload } = JSON.parse(event.data);

                // Ensure we have a roomId in the payload
                const roomId = payload?.roomId;
                if (!roomId) {
                    return;
                }
                // Check if there are any pending requests for this roomId and responseType
                if (
                    !this.pendingResponses[roomId] ||
                    !this.pendingResponses[roomId][responseType]
                ) {
                    return;
                }

                // Resolve ALL pending requests for this roomId & responseType
                this.pendingResponses[roomId][responseType].forEach(
                    (resolve) => {
                        resolve(payload);
                    }
                );
                // Cleanup: Remove responseType after resolving all requests
                delete this.pendingResponses[roomId][responseType];
                // Cleanup: Remove roomId if no more pending messages
                if (Object.keys(this.pendingResponses[roomId]).length === 0) {
                    delete this.pendingResponses[roomId];
                }
            } catch (error) {
                console.error("Error processing WebSocket message:", error);
            }
        };

        this.wsControl.addEventListener("open", handleOpen);
        this.wsControl.addEventListener("close", handleClose);
        this.wsControl.addEventListener("error", handleError);
        this.wsControl.addEventListener("message", handleMessage);
    }

    /**
     * Sends a WebSocket request and optionally waits for a response.
     *
     * @param {string} requestType - The type of request to send.
     * @param {any} payload - The payload to send with the request.
     * @param {Object} [options={}] - Optional parameters for controlling request behavior.
     * @param {string} [options.responseType] - The expected response type (⚠️ Required if `waitForResponse` is `true`).
     * @param {(payload: any) => boolean} [options.validateResponse=() => true] - Function to validate if the response matches expectations.
     * @param {string} [options.timeoutMessage='Request timed out'] - Custom error message if the request times out.
     * @param {number} [options.timeoutMs=5000] - Timeout duration in milliseconds.
     * @param {boolean} [options.waitForOpen=true] - If `true`, waits for WebSocket `"open"` event before sending.
     * @param {boolean} [options.waitForResponse=true] - If `false`, resolves immediately after sending the request.
     *
     * @returns {Promise<any>} Resolves with the response payload if `waitForResponse` is `true`, otherwise resolves immediately.
     *
     * @throws {Error} If `webSocket` is `null` or not in an open state.
     * @throws {Error} If `waitForResponse` is `true` but `responseType` is missing.
     * @throws {Error} If the request fails to send or times out.
     */
    public sendWebSocketRequest = async (
        requestType: string,
        payload: any,
        options: {
            responseType?: string;
            validateResponse?: (payload: any) => boolean;
            timeoutMessage?: string;
            timeoutMs?: number;
            waitForOpen?: boolean;
            waitForResponse?: boolean;
        } = {}
    ): Promise<any> => {
        return new Promise((resolve, reject) => {
            const {
                responseType,
                validateResponse = () => true,
                timeoutMessage = `${requestType} request timed out`,
                timeoutMs = 5000,
                waitForOpen = true,
                waitForResponse = true,
            } = options;

            if (waitForResponse && !responseType) {
                return reject(
                    new Error(
                        "responseType is required when waiting for a response."
                    )
                );
            }

            // Extract roomId from payload (Assumes roomId is inside the payload)
            const roomId = payload?.roomId;
            if (!roomId) {
                return reject(new Error("roomId is required in the payload."));
            }

            const sendRequest = () => {
                try {
                    this.wsControl.send(
                        JSON.stringify({
                            type: requestType,
                            payload,
                        })
                    );

                    if (!waitForResponse) {
                        return resolve(
                            "Request sent successfully (no response expected)."
                        );
                    }
                } catch (error) {
                    return reject(
                        new Error(`Failed to send request: ${error}`)
                    );
                }

                // Store the request in the pendingResponses map under roomId and responseType
                if (!this.pendingResponses[roomId]) {
                    this.pendingResponses[roomId] = {};
                }
                if (!this.pendingResponses[roomId][responseType!]) {
                    this.pendingResponses[roomId][responseType!] = [];
                }

                // Push the resolver function into the queue for this roomId & responseType
                this.pendingResponses[roomId][responseType!].push(
                    (responseData: any) => {
                        if (validateResponse(responseData)) {
                            resolve(responseData);
                        } else {
                            reject(new Error("Response validation failed."));
                        }
                    }
                );

                // Set timeout for this specific request
                setTimeout(() => {
                    if (
                        this.pendingResponses[roomId]?.[responseType!]?.length >
                        0
                    ) {
                        // Reject all pending requests if timed out
                        this.pendingResponses[roomId][responseType!].forEach(
                            () => reject(new Error(timeoutMessage))
                        );

                        // Cleanup: Remove responseType if no more pending requests
                        delete this.pendingResponses[roomId][responseType!];

                        // Cleanup: Remove roomId if no more pending messages
                        if (
                            Object.keys(this.pendingResponses[roomId])
                                .length === 0
                        ) {
                            delete this.pendingResponses[roomId];
                        }
                    }
                }, timeoutMs);
            };

            // Handle WebSocket connection states
            switch (this.wsControl.readyState) {
                case ReconnectingWebSocket.OPEN:
                    sendRequest();
                    break;

                case ReconnectingWebSocket.CONNECTING:
                    if (waitForOpen) {
                        // Store the request in pendingRequests for later execution
                        this.pendingRequests.push(sendRequest);

                        // Ensure only one "open" listener is added
                        if (!this.isFlushing) {
                            this.isFlushing = true;

                            const handleOpen = () => {
                                setTimeout(() => {
                                    // Flush all pending requests
                                    this.pendingRequests.forEach((req) =>
                                        req()
                                    );
                                    this.pendingRequests = []; // Clear queue after sending
                                    this.wsControl.removeEventListener(
                                        "open",
                                        handleOpen
                                    );
                                    this.isFlushing = false; // Reset flag
                                }, 100); // Delay to ensure WebSocket is fully open
                            };

                            this.wsControl.addEventListener("open", handleOpen);
                        }
                    } else {
                        reject(
                            new Error(
                                "WebSocket is still connecting. Please wait and try again."
                            )
                        );
                    }
                    break;

                case ReconnectingWebSocket.CLOSING:
                    reject(
                        new Error(
                            "WebSocket is closing. Wait for it to reconnect."
                        )
                    );
                    break;

                case ReconnectingWebSocket.CLOSED:
                    reject(
                        new Error(
                            "WebSocket connection was closed. Try to reload the window."
                        )
                    );
                    break;

                default:
                    reject(new Error("WebSocket connection not available."));
            }
        });
    };

    /*
     * VSCode event listeners
     */

    private setupVSCodeListeners(): vscode.Disposable[] {
        return [
            // Listen to file renames
            vscode.workspace.onDidRenameFiles(async (event) => {
                for (const { oldUri, newUri } of event.files) {
                    const oldFilePath = oldUri.fsPath;
                    const newFilePath = await this.getCorrectCasePath(
                        newUri.fsPath
                    );
                    const oldRelativePath =
                        this.getRelativeFilePath(oldFilePath);
                    const newRelativePath =
                        this.getRelativeFilePath(newFilePath);

                    // Update ChangeTracker
                    this.changeTracker.renameFile(oldRelativePath, newRelativePath);

                    // Check if it's a file or a directory
                    const fileStat = await vscode.workspace.fs.stat(newUri);
                    if (fileStat.type === vscode.FileType.File) {
                        // Update the binding for renamed file
                        await this.renameFileBinding(oldRelativePath, newRelativePath);
                        
                        // Rename in fileYMap
                        await this.renameFileInYMap(
                            oldRelativePath,
                            newRelativePath
                        );

                        // Check if this is just a case change
                        const isCaseChangeOnly =
                            oldFilePath.toLowerCase() ===
                            newFilePath.toLowerCase();

                        // If it's a case-only change and the file is currently open,
                        // manually trigger onDidChangeActiveTextEditor handler
                        //  as such a event is not fired if only the casing changes
                        if (
                            isCaseChangeOnly &&
                            vscode.window.activeTextEditor
                        ) {
                            const currentEditor =
                                vscode.window.activeTextEditor;
                            const currentFilePath =
                                currentEditor.document.uri.fsPath;

                            // Check if the renamed file is the currently active editor
                            if (
                                currentFilePath.toLowerCase() ===
                                newFilePath.toLowerCase()
                            ) {
                                // Force a refresh of our active editor handling
                                this.handleActiveEditorChange(currentEditor);
                            }
                        }
                    } else if (fileStat.type === vscode.FileType.Directory) {
                        // Rename all bindings in the directory
                        await this.renameDirectoryBindings(oldRelativePath, newRelativePath);
                        
                        // Rename folder and all files within it
                        await this.renameAllFilesInDirectory(
                            oldRelativePath,
                            newRelativePath
                        );

                        // If a directory was renamed and the current file is in that directory,
                        // we should also trigger a refresh
                        if (vscode.window.activeTextEditor) {
                            const currentEditor =
                                vscode.window.activeTextEditor;
                            this.handleActiveEditorChange(currentEditor);
                        }
                    }
                }
            }),

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
                    // Remove all bindings in the folder
                    this.removeWorkspaceFolderBindings(removedFolder.name);
                    // Remove all files in the folder from fileYMap
                    this.removeAllFilesInWorkspaceFolder(removedFolder.name);
                }
            }),

            vscode.workspace.onDidSaveTextDocument((document) => {
                const relativePath = this.getRelativeFilePath(document.uri.fsPath);
                if (relativePath && this.fileYMap.has(relativePath)) {
                    // Only update snapshot if there are NO changes
                    // If changes exist, instructor must use diff view to accept/rollback
                    if (!this.changeTracker.hasChanges(relativePath)) {
                        this.changeTracker.recordInstructorEdit(relativePath, document.getText());
                    } else {
                        // Show warning that changes must be resolved first
                        vscode.window.showWarningMessage(
                            `'${relativePath}' has unresolved changes. Please use the diff view to accept or rollback changes.`,
                            "Review Changes"
                        ).then(choice => {
                            if (choice === "Review Changes") {
                                vscode.commands.executeCommand("coducate.reviewChanges");
                            }
                        });
                    }
                }
            }),

            // Listen for when text documents are opened - create bindings
            vscode.workspace.onDidOpenTextDocument(async (document) => {
                const correctFilePath = await this.getCorrectCasePath(
                    document.uri.fsPath
                );
                const relativePath = this.getRelativeFilePath(correctFilePath);
                
                if (relativePath && this.fileYMap.has(relativePath)) {
                    await this.createOrUpdateBinding(relativePath, document);
                }
            }),

            // Listen for when text documents are closed
            vscode.workspace.onDidCloseTextDocument((document) => {
                // Bindings are kept alive for seamless re-opening
                // They will be disposed when files are deleted or session ends
            }),

            // Listen to cursor movement and selection changes
            vscode.window.onDidChangeTextEditorSelection(async (event) => {
                if (event.textEditor === vscode.window.activeTextEditor) {
                    const correctFilePath = await this.getCorrectCasePath(
                        event.textEditor.document.uri.fsPath
                    );

                    const relativeFilePath =
                        this.getRelativeFilePath(correctFilePath);
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
                    this.provider.awareness.setLocalStateField(
                        "vsCodeClient",
                        clientState
                    );
                }
            }),

            // Listen for active editor changes (e.g., when a different file is opened)
            vscode.window.onDidChangeActiveTextEditor(async (editor) => {
                await this.handleActiveEditorChange(editor);
            }),

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
            }),

            // Listen to file deletion
            vscode.workspace.onDidDeleteFiles(async (event) => {
                for (const file of event.files) {
                    const filePath = file.fsPath;
                    const relativeFilePath = this.getRelativeFilePath(filePath);

                    // Remove from ChangeTracker
                    this.changeTracker.removeFile(relativeFilePath);

                    // Check if any entries in fileYMap start with the folder path
                    const isFolder = Array.from(this.fileYMap.keys()).some(
                        (key) =>
                            key.startsWith(relativeFilePath + path.posix.sep)
                    );

                    if (isFolder) {
                        // Remove bindings for all files in the folder
                        for (const key of Array.from(this.fileYMap.keys())) {
                            if (
                                key.startsWith(
                                    relativeFilePath + path.posix.sep
                                )
                            ) {
                                this.removeBinding(key);
                                this.fileYMap.delete(key);
                            }
                        }
                    } else {
                        // Remove binding for single file
                        this.removeBinding(relativeFilePath);
                        if (this.fileYMap.has(relativeFilePath)) {
                            this.fileYMap.delete(relativeFilePath);
                        }
                    }
                }
            }),

            // Listen for configuration changes
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (
                    event.affectsConfiguration(
                        "coducate.exclusion.excludedDirectories"
                    ) ||
                    event.affectsConfiguration(
                        "coducate.exclusion.excludedFileExtensions"
                    ) ||
                    event.affectsConfiguration(
                        "coducate.terminal.mirrorOnlyCoducateTerminals"
                    )
                ) {
                    this.loadSettings();
                }
            }),
        ];
    }

    /*
     * Settings and File Management
     */

    // Function to handle active editor changes
    private async handleActiveEditorChange(
        editor: vscode.TextEditor | undefined
    ) {
        if (editor) {
            const editorPath = editor.document.uri.fsPath;

            const correctFilePath = await this.getCorrectCasePath(editorPath);

            // Get the relative path with correct casing
            const relativeFilePath = this.getRelativeFilePath(correctFilePath);

            // Create or update binding for this document
            if (relativeFilePath && this.fileYMap.has(relativeFilePath)) {
                await this.createOrUpdateBinding(relativeFilePath, editor.document);
            }

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

            this.provider.awareness.setLocalStateField(
                "vsCodeClient",
                clientState
            );

            // Send the instructor file name to the server
            if (relativeFilePath && this.fileYMap.has(relativeFilePath)) {
                try {
                    await this.sendWebSocketRequest(
                        "set_instructor_file_request",
                        {
                            roomId: this.roomId,
                            instructorFile: relativeFilePath,
                        },
                        {
                            waitForResponse: false, // Send-and-forget (no response expected)
                        }
                    );
                } catch (error) {
                    vscode.window.showErrorMessage(
                        error instanceof Error ? error.message : String(error)
                    );
                }
            }
        }
    }

    // Function to get the case sensitive file or directory path
    public async getCorrectCasePath(inputPath: string): Promise<string> {
        try {
            // Get directory and filename parts
            const dirPath = path.dirname(inputPath);
            const baseName = path.basename(inputPath);

            // If this is the root directory, just return it
            if (dirPath === inputPath || baseName === "") {
                return inputPath;
            }

            // Recursively get the correct case for the parent directory
            const correctParentPath = await this.getCorrectCasePath(dirPath);

            // Read the directory contents to get the correct case
            try {
                const dirEntries = await vscode.workspace.fs.readDirectory(
                    vscode.Uri.file(correctParentPath)
                );

                // Find the matching entry with correct case (file or directory)
                const matchingEntry = dirEntries.find(
                    ([entryName]) =>
                        entryName.toLowerCase() === baseName.toLowerCase()
                );

                // Return the corrected path if found, otherwise the original
                if (matchingEntry) {
                    return path.join(correctParentPath, matchingEntry[0]);
                }
            } catch (err) {
                // If we can't read the directory, just use the original basename
                console.error(
                    `Failed to read directory ${correctParentPath}:`,
                    err
                );
            }

            // Default fallback: use original basename with corrected parent path
            return path.join(correctParentPath, baseName);
        } catch (error) {
            console.error("Error getting correct case path:", error);
            return inputPath; // Return original on error
        }
    }

    public async getFileUriForPath(relativePath: string): Promise<vscode.Uri | null> {
        const slashIndex = relativePath.indexOf("/");
        if (slashIndex === -1) {
            return null;
        }

        const workspaceFolderName = relativePath.substring(0, slashIndex);
        const filePath = relativePath.substring(slashIndex + 1);

        for (const folder of vscode.workspace.workspaceFolders || []) {
            if (folder.name === workspaceFolderName) {
                const fileUri = vscode.Uri.joinPath(folder.uri, filePath);
                try {
                    await vscode.workspace.fs.stat(fileUri);
                    return fileUri;
                } catch (error) {
                    continue;
                }
            }
        }
        return null;
    }

    /*
    * Binding Management
    */

    /**
     * Create or update a YTextVSCodeBinding for a document
     */
    private async createOrUpdateBinding(
        relativePath: string,
        document: vscode.TextDocument
    ): Promise<void> {
        this.removeBinding(relativePath);

        const yText = this.fileYMap.get(relativePath);
        if (!yText) {
            console.warn(`No Y.Text found for ${relativePath}`);
            return;
        }

        // Create binding with change callback
        const binding = new YTextVSCodeBinding(
            yText,
            document,
            relativePath,
            (path) => this.changeTracker.recordChange(path)
        );
        this.ytextBindings.set(relativePath, binding);

        // Record current state as instructor snapshot
        this.changeTracker.recordInstructorEdit(relativePath, document.getText());

        if (!binding.isInSync()) {
            await binding.syncFromYText();
        }
    }

    /**
     * Create bindings for all currently open documents that are in fileYMap.
     * This is crucial for restoring the session after a VS Code reload.
     */
    private async createBindingsForOpenDocuments(): Promise<void> {
        console.log('Creating bindings for open documents after sync...');
        
        for (const document of vscode.workspace.textDocuments) {
            if (document.uri.scheme !== 'file') {
                continue;
            }

            try {
                const correctFilePath = await this.getCorrectCasePath(document.uri.fsPath);
                const relativePath = this.getRelativeFilePath(correctFilePath);

                if (relativePath && this.fileYMap.has(relativePath)) {
                    if (!this.ytextBindings.has(relativePath)) {
                        console.log(`Creating binding for already-open document: ${relativePath}`);
                        await this.createOrUpdateBinding(relativePath, document);
                    }
                }
            } catch (error) {
                console.error(`Error creating binding for ${document.uri.fsPath}:`, error);
            }
        }
        
        console.log(`Bindings created. Total bindings: ${this.ytextBindings.size}`);
    }

    /**
     * Remove a binding for a file
     */
    private removeBinding(relativePath: string): void {
        const binding = this.ytextBindings.get(relativePath);
        if (binding) {
            binding.dispose();
            this.ytextBindings.delete(relativePath);
        }
    }

    /**
     * Rename a binding when a file is renamed
     */
    private async renameFileBinding(
        oldRelativePath: string,
        newRelativePath: string
    ): Promise<void> {
        const binding = this.ytextBindings.get(oldRelativePath);
        if (binding) {
            binding.dispose();
            this.ytextBindings.delete(oldRelativePath);
        }

        // Create new binding if the document is open
        const document = vscode.workspace.textDocuments.find(
            (doc) => this.getRelativeFilePath(doc.uri.fsPath) === newRelativePath
        );
        
        if (document) {
            await this.createOrUpdateBinding(newRelativePath, document);
        }
    }

    /**
     * Rename all bindings in a directory
     */
    private async renameDirectoryBindings(
        oldRelativePath: string,
        newRelativePath: string
    ): Promise<void> {
        const normalizedOldPath = this.toPosixPath(oldRelativePath);
        const normalizedNewPath = this.toPosixPath(newRelativePath);

        const bindingsToRename = Array.from(this.ytextBindings.keys()).filter(
            (key) =>
                key
                    .toLowerCase()
                    .startsWith(normalizedOldPath.toLowerCase() + path.posix.sep)
        );

        for (const oldKey of bindingsToRename) {
            const suffix = oldKey.substring(normalizedOldPath.length);
            const newKey = normalizedNewPath + suffix;
            await this.renameFileBinding(oldKey, newKey);
        }
    }

    /**
     * Remove all bindings in a workspace folder
     */
    private removeWorkspaceFolderBindings(folderName: string): void {
        const bindingsToRemove = Array.from(this.ytextBindings.keys()).filter(
            (key) => key.startsWith(`${folderName}/`)
        );

        for (const key of bindingsToRemove) {
            this.removeBinding(key);
        }
    }

    public async showChangesDiff(relativePath: string) {
        await this.changeTracker.showDiff(relativePath);
    }

    private async handleAcceptCurrentVersion(relativePath: string) {
        const binding = this.ytextBindings.get(relativePath);
        if (!binding) {
            return;
        }

        const currentContent = binding.getYTextSnapshot();
        
        // Force update the instructor snapshot (clears changes flag)
        this.changeTracker.forceUpdateInstructorSnapshot(relativePath, currentContent);
    }

    private async handleRollbackChanges(relativePath: string) {
        const snapshot = this.changeTracker.getInstructorSnapshot(relativePath);
        if (!snapshot) {
            return;
        }

        const yText = this.fileYMap.get(relativePath);
        if (!yText) {
            return;
        }

        // Revert Y.Text to instructor's version
        yText.doc?.transact(() => {
            yText.delete(0, yText.length);
            yText.insert(0, snapshot);
        }, 'vscode-instructor');
        
        // After reverting, update the snapshot to match
        const binding = this.ytextBindings.get(relativePath);
        if (binding) {
            this.changeTracker.forceUpdateInstructorSnapshot(relativePath, snapshot);
        }
    }

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

    // Function to check if a file has changes tracked
    public hasChangesTracked(filePath: string): boolean {
        return this.changeTracker?.hasChanges(filePath) || false;
    }

    // Function to handle changes in excluded file extensions
    private async handleFileExtensionChanges(
        oldExcluded: Set<string>,
        newExcluded: Set<string>,
        taskData: any
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
                        `'${file}' contains client changes. Please resolve these changes before excluding '${ext}' files.`,
                        "Ok"
                    );

                    // Remove the file extension from the excluded list in the settings
                    await this.removeSettingValue(
                        "exclusion.excludedFileExtensions",
                        ext
                    );

                    break;
                }
            }

            if (!hasChanges) {
                await this.removeFilesByExtension(ext, taskData);
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
        newExcluded: Set<string>,
        taskData: any
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
                        `'${dir}' contains files with client changes. Please resolve these changes before excluding the directory.`,
                        "Ok"
                    );

                    // Remove the directory from the excluded list in settings
                    await this.removeSettingValue(
                        "exclusion.excludedDirectories",
                        dir
                    );

                    break;
                }
            }

            if (!hasChanges) {
                await this.removeAllFilesInDirectory(dir, taskData);
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
    private async loadSettings() {
        // Fetch configuration settings
        const config = vscode.workspace.getConfiguration("coducate");

        const excludedDirs = config.get<string[]>(
            "exclusion.excludedDirectories",
            []
        );
        const excludedExts = config.get<string[]>(
            "exclusion.excludedFileExtensions",
            []
        );
        const mirrorOnlyCoducateTerminals = config.get<boolean>(
            "terminal.mirrorOnlyCoducateTerminals",
            true
        );

        const oldExcludedDirectories = this.excludedDirectories;
        const oldExcludedFileExtensions = this.excludedFileExtensions;

        this.excludedDirectories = new Set(excludedDirs);
        this.excludedFileExtensions = new Set(excludedExts);
        this.terminalShellIntegration.setMirrorOnlyCoducateTerminals(
            mirrorOnlyCoducateTerminals
        );

        // Request task data from server to warn the user if the task description or learning goals files would be excluded
        const fetchTaskData = async () => {
            try {
                const taskData = await this.sendWebSocketRequest(
                    "get_task_data_request",
                    { roomId: this.roomId },
                    {
                        responseType: "get_task_data_response",
                    }
                );
                return taskData;
            } catch (error) {
                vscode.window.showErrorMessage(
                    error instanceof Error ? error.message : String(error)
                );
                return;
            }
        };
        const taskData = await fetchTaskData();

        // Handle changes in excluded directories
        this.handleDirectoryChanges(
            oldExcludedDirectories,
            this.excludedDirectories,
            taskData
        );

        // Handle changes in excluded file extensions
        this.handleFileExtensionChanges(
            oldExcludedFileExtensions,
            this.excludedFileExtensions,
            taskData
        );
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
                
                // Create binding if document is open in editor
                const openDocument = vscode.workspace.textDocuments.find(
                    (doc) => this.getRelativeFilePath(doc.uri.fsPath) === relativeFilePath
                );
                if (openDocument) {
                    await this.createOrUpdateBinding(relativeFilePath, openDocument);
                }
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
    private async removeFilesByExtension(extension: string, taskData: any) {
        for (const key of Array.from(this.fileYMap.keys())) {
            if (key.endsWith(extension)) {
                if (key === taskData.taskDescriptionPath) {
                    vscode.window.showWarningMessage(
                        `Cannot remove '${key}' from synchronization. This file is used for the task description.`,
                        "Ok"
                    );
                    continue;
                } else if (key === taskData.learningGoalsPath) {
                    vscode.window.showWarningMessage(
                        `Cannot remove '${key}' from synchronization. This file is used for the learning goals.`,
                        "Ok"
                    );
                    continue;
                }
                this.fileYMap.delete(key);
            }
        }
    }

    // Function to remove all files within a directory from fileYMap
    private async removeAllFilesInDirectory(dir: string, taskData: any) {
        for (const key of Array.from(this.fileYMap.keys())) {
            if (
                key.startsWith(`${dir}/`) ||
                key.includes(`/${dir}/`) ||
                key.endsWith(`/${dir}`)
            ) {
                if (key === taskData?.taskDescriptionPath) {
                    vscode.window.showWarningMessage(
                        `Cannot remove '${key}' from synchronization. This file is used for the task description.`,
                        "Ok"
                    );
                    continue;
                } else if (key === taskData?.learningGoalsPath) {
                    vscode.window.showWarningMessage(
                        `Cannot remove '${key}' from synchronization. This file is used for the learning goals.`,
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
            key
                .toLowerCase()
                .startsWith(normalizedOldPath.toLowerCase() + path.posix.sep)
        );

        for (const oldKey of keysToRename) {
            // Get the part of the path after the old folder path
            const suffix = oldKey.substring(normalizedOldPath.length);
            // Create the new key with the new folder path
            const newKey = normalizedNewPath + suffix;

            // Reuse renameFileInYMap to handle each file rename
            await this.renameFileInYMap(oldKey, newKey);
        }
    }

    /*
     * Cleanup and Disposal
     */

    public dispose() {
        // Dispose all bindings
        for (const binding of this.ytextBindings.values()) {
            binding.dispose();
        }
        this.ytextBindings.clear();

        // Dispose change tracker
        this.changeTracker.dispose();

        // Disconnect from the WebSocket server
        this.wsControl.close();

        // Reset awareness state
        this.provider.awareness.setLocalState(null);

        // Destroy the Yjs document
        this.yDoc.destroy();

        // Disconnect and clean up the provider
        this.provider.disconnect();
        this.provider.destroy();

        // Dispose the terminal shell integration
        this.terminalShellIntegration.dispose();

        // Dispose all registered disposables
        this.disposables.forEach((disposable) => disposable.dispose());
        this.disposables = [];
    }
}
