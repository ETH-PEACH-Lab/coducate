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

const EXCLUDED_DIRECTORIES = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".vscode",
    "coverage",
    "out",
    "tmp",
    "logs",
    ".cache",
]);

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

        // Sync initial files from each workspace folder
        vscode.workspace.workspaceFolders?.forEach((folder) => {
            this.addAllFilesInDirectory(this.toPosixPath(folder.uri.fsPath));
        });

        this.notebookFilePath = path.posix.join(
            os.tmpdir(),
            `coducateNotebook_${this.roomId}.txt`
        );
        fs.writeFileSync(this.notebookFilePath, "");

        this.setupVSCodeListeners();
    }

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

        ws.onerror = (error) => {
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
                    // console.log(
                    //     `Folder renamed: ${oldRelativePath} -> ${newRelativePath}`
                    // );
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
                // console.log("Workspace folder added: " + folderPath);

                // Add all files in the new folder to fileYMap
                await this.addAllFilesInDirectory(folderPath);
            }

            // Handle removed workspace folders
            for (const removedFolder of event.removed) {
                // const folderPath = removedFolder.uri.fsPath;
                // console.log("Workspace folder removed: " + folderPath);

                // Remove all files in the folder from fileYMap
                this.removeAllFilesInDirectory(removedFolder.name);
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
                    event.document.fileName,
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
                        // console.log(
                        //     `Instructor file sent: ${relativeFilePath}`
                        // );
                    } catch (error) {
                        // console.error("Error sending instructor file:", error);
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
                } else if (fileStat.type === vscode.FileType.Directory) {
                    // Folder detected - add all files within this folder to fileYMap
                    // console.log(`Folder created: ${relativeFilePath}`);
                    await this.addAllFilesInDirectory(filePath);
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
                    // console.log(`Folder deleted: ${relativeFilePath}`);
                    for (const key of Array.from(this.fileYMap.keys())) {
                        if (key.startsWith(relativeFilePath + path.posix.sep)) {
                            this.fileYMap.delete(key);
                            // console.log(
                            //     `File deleted from folder in fileYMap: ${key}`
                            // );
                        }
                    }
                } else {
                    // If it's a single file, delete only that specific entry
                    if (this.fileYMap.has(relativeFilePath)) {
                        this.fileYMap.delete(relativeFilePath);
                        // console.log(
                        //     `File deleted from fileYMap: ${relativeFilePath}`
                        // );
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

    // Helper function to determine the MIME type of the item based on its mime property
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

    public addOutputToYMap(outputFilePath: string, content: string) {
        const yText = new Y.Text();
        yText.insert(0, content);
        const relativeFilePath = this.getRelativeFilePath(outputFilePath);
        this.fileYMap.set(relativeFilePath, yText);
    }

    // Function to add a single file to fileYMap
    public async addFileToYMap(filePath: string, relativeFilePath: string) {
        if (!this.fileYMap.has(relativeFilePath)) {
            const yText = new Y.Text();
            this.fileYMap.set(relativeFilePath, yText);

            try {
                const document = await vscode.workspace.openTextDocument(
                    filePath
                );
                const content = document.getText();
                yText.insert(0, content);

                // console.log(`File added to fileYMap: ${relativeFilePath}`);
            } catch (error) {
                // console.log(
                //     `Error opening file: ${relativeFilePath}. Probably binary.`
                // );
            }
        }
    }

    // Function to add all files within a directory to fileYMap
    private async addAllFilesInDirectory(folderPath: string) {
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
            if (this.isExcludedDirectory(normalizedFilePath)) {
                continue;
            }

            const fileStat = await vscode.workspace.fs.stat(file);
            if (fileStat.type === vscode.FileType.File) {
                await this.addFileToYMap(normalizedFilePath, relativeFilePath);
            }
        }
    }

    // Helper function to check if a file is within an excluded directory
    private isExcludedDirectory(filePath: string): boolean {
        const pathSegments = filePath.split(path.posix.sep);
        return pathSegments.some((segment) =>
            EXCLUDED_DIRECTORIES.has(segment)
        );
    }

    // Function to remove all files within a directory from fileYMap
    private removeAllFilesInDirectory(folderName: string) {
        const normalizedFolderName = this.toPosixPath(folderName);
        for (const key of Array.from(this.fileYMap.keys())) {
            if (key.startsWith(`${normalizedFolderName}/`)) {
                this.fileYMap.delete(key);
                // console.log(`File removed from fileYMap: ${key}`);
            }
        }
    }

    // Method to handle renaming of files or directories with added safety checks
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

                // console.log(
                //     `Renamed: ${oldRelativePath} -> ${newRelativePath}`
                // );
            } else {
                // console.log(
                //     `Rename error: ${newRelativePath} not found in fileYMap.`
                // );
            }
        } else {
            // console.log(
            //     `Rename error: ${oldRelativePath} not found in fileYMap.`
            // );
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

    private applyIncrementalChanges(
        fileName: string,
        contentChanges: readonly vscode.TextDocumentContentChangeEvent[]
    ) {
        const relativeFileName = this.getRelativeFilePath(fileName);

        const yText = this.fileYMap.get(relativeFileName);
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
