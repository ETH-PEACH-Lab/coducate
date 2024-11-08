import * as vscode from "vscode";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import path from "path";
import * as fs from "fs";
import { Awareness } from "y-protocols/awareness";
import * as os from "os";
import { WebSocket } from "ws";

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

export class DisposableWebSocket {
    private provider: WebsocketProvider;
    private controlWebSocket: WebSocket;
    private roomId: string;
    private yDoc: Y.Doc;
    private awareness: Awareness;
    private fileYMap: Y.Map<Y.Text>; // A shared map to store file names and their corresponding Y.Text objects

    constructor(urlYjs: string, urlControlWebsocket: string, roomId: string) {
        this.roomId = roomId;
        this.yDoc = new Y.Doc();
        this.provider = new WebsocketProvider(urlYjs, roomId, this.yDoc, {
            WebSocketPolyfill: require("ws"),
        });
        this.controlWebSocket = new WebSocket(urlControlWebsocket);

        // Initialize awareness for the provider
        this.awareness = this.provider.awareness;

        // Initialize the shared file list in the Y.Doc
        this.fileYMap = this.yDoc.getMap("fileYMap");

        // Sync initial files from each workspace folder
        vscode.workspace.workspaceFolders?.forEach((folder) => {
            this.addAllFilesInDirectory(folder.uri.fsPath);
        });

        this.setupVSCodeListeners();
    }

    public getProvider() {
        return this.provider;
    }

    public getWebControlWebSocket() {
        return this.controlWebSocket;
    }

    public getRoomId() {
        return this.roomId;
    }

    public getRelativeFilePath(filePath: string): string {
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(
            (folder) => filePath.startsWith(folder.uri.fsPath)
        );

        if (workspaceFolder) {
            const workspaceFolderPath = workspaceFolder.uri.fsPath;
            const relativePath = path.relative(workspaceFolderPath, filePath);
            return `${workspaceFolder.name}/${relativePath}`;
        }

        return filePath; // Return absolute path if file is not within any workspace folder
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
                    console.log(
                        `Folder renamed: ${oldRelativePath} -> ${newRelativePath}`
                    );
                    await this.renameAllFilesInDirectory(
                        oldRelativePath,
                        newRelativePath
                    );
                }
            }
        });

        // Listen to workspace folder changes
        vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
            console.log("Workspace folders changed.");

            // Handle added workspace folders
            for (const addedFolder of event.added) {
                const folderPath = addedFolder.uri.fsPath;
                console.log("Workspace folder added: " + folderPath);

                // Add all files in the new folder to fileYMap
                await this.addAllFilesInDirectory(folderPath);
            }

            // Handle removed workspace folders
            for (const removedFolder of event.removed) {
                const folderPath = removedFolder.uri.fsPath;
                console.log("Workspace folder removed: " + folderPath);

                // Remove all files in the folder from fileYMap
                this.removeAllFilesInDirectory(folderPath, removedFolder.name);
            }
        });

        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document === vscode.window.activeTextEditor?.document) {
                this.applyIncrementalChanges(
                    event.document.fileName,
                    event.contentChanges
                );

                // Send the instructor file name to the server
                this.controlWebSocket.send(
                    JSON.stringify({
                        type: "setInstructorFile",
                        payload: {
                            roomId: this.roomId,
                            instructorFile: this.getRelativeFilePath(
                                event.document.fileName
                            ),
                        },
                    })
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

                // Send the instructor file name to the server
                this.controlWebSocket.send(
                    JSON.stringify({
                        type: "setInstructorFile",
                        payload: {
                            roomId: this.roomId,
                            instructorFile: relativeFilePath,
                        },
                    })
                );
            }
        });

        // Listen for active editor changes (e.g., when a different file is opened)
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                const relativeFilePath = this.getRelativeFilePath(
                    editor.document.fileName
                );

                const clientState = {
                    filePath: relativeFilePath,
                };
                this.awareness.setLocalStateField("vsCodeClient", clientState);
            }
        });

        // Clean up awareness state when editor is closed or session ends
        vscode.workspace.onDidCloseTextDocument(() => {
            this.awareness.setLocalStateField("vsCodeClient", null);
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
                    console.log(`Folder created: ${relativeFilePath}`);
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
                    key.startsWith(relativeFilePath + path.sep)
                );

                if (isFolder) {
                    // If it's a folder, delete all entries within that path
                    console.log(`Folder deleted: ${relativeFilePath}`);
                    for (const key of Array.from(this.fileYMap.keys())) {
                        if (key.startsWith(relativeFilePath + path.sep)) {
                            this.fileYMap.delete(key);
                            console.log(
                                `File deleted from folder in fileYMap: ${key}`
                            );
                        }
                    }
                } else {
                    // If it's a single file, delete only that specific entry
                    if (this.fileYMap.has(relativeFilePath)) {
                        this.fileYMap.delete(relativeFilePath);
                        console.log(
                            `File deleted from fileYMap: ${relativeFilePath}`
                        );
                    }
                }
            }
        });
    }

    public addOutputToYMap(outputFilePath: string, content: string) {
        const yText = new Y.Text();
        yText.insert(0, content);
        const relativeFilePath = this.getRelativeFilePath(outputFilePath);
        this.fileYMap.set(relativeFilePath, yText);
    }

    // Public method to expose addTmpFileToYMap functionality
    public async addTemporaryFileToYMap() {
        await this.addTmpFileToYMap();
    }

    // Function to add the /tmp file directly to fileYMap
    private async addTmpFileToYMap() {
        const tmpFilePath = path.join(os.tmpdir(), "coducateSetup.jsonc");

        // Check if file exists before trying to add it
        if (fs.existsSync(tmpFilePath)) {
            await this.addFileToYMap(tmpFilePath, tmpFilePath);
        } else {
            console.log("Temporary file does not exist in /tmp directory.");
        }
    }

    // Function to add a single file to fileYMap
    private async addFileToYMap(filePath: string, relativeFilePath: string) {
        if (!this.fileYMap.has(relativeFilePath)) {
            const yText = new Y.Text();
            this.fileYMap.set(relativeFilePath, yText);

            try {
                const document = await vscode.workspace.openTextDocument(
                    filePath
                );
                const content = document.getText();
                yText.insert(0, content);

                console.log(`File added to fileYMap: ${relativeFilePath}`);
            } catch (error) {
                console.log(
                    `Error opening file: ${relativeFilePath}. Probably binary.`
                );
            }
        }
    }

    // Function to add all files within a directory to fileYMap
    private async addAllFilesInDirectory(folderPath: string) {
        // Find all files in the created directory
        const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folderPath, "**/*")
        );

        for (const file of files) {
            const filePath = file.fsPath;
            const relativeFilePath = this.getRelativeFilePath(filePath);

            // Skip files in excluded directories
            if (this.isExcludedDirectory(filePath)) {
                continue;
            }

            const fileStat = await vscode.workspace.fs.stat(file);
            if (fileStat.type === vscode.FileType.File) {
                await this.addFileToYMap(filePath, relativeFilePath);
            }
        }
    }

    // Helper function to check if a file is within an excluded directory
    private isExcludedDirectory(filePath: string): boolean {
        const pathSegments = filePath.split(path.sep);
        return pathSegments.some((segment) =>
            EXCLUDED_DIRECTORIES.has(segment)
        );
    }

    // Function to remove all files within a directory from fileYMap
    private removeAllFilesInDirectory(folderPath: string, folderName: string) {
        // Identify files in fileYMap that are within the specified folder path
        for (const key of Array.from(this.fileYMap.keys())) {
            if (key.startsWith(`${folderName}/`)) {
                this.fileYMap.delete(key);
                console.log(`File removed from fileYMap: ${key}`);
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

            // Remove the old entry and add the new one
            this.fileYMap.delete(oldRelativePath);
            this.fileYMap.set(newRelativePath, newYText!);

            console.log(`Renamed: ${oldRelativePath} -> ${newRelativePath}`);
        } else {
            console.log(
                `Rename error: ${oldRelativePath} not found in fileYMap.`
            );
        }
    }

    // Function to rename all files within a directory in fileYMap
    private async renameAllFilesInDirectory(
        oldRelativePath: string,
        newRelativePath: string
    ) {
        // Find all entries in fileYMap that start with the old folder path
        const keysToRename = Array.from(this.fileYMap.keys()).filter((key) =>
            key.startsWith(oldRelativePath + path.sep)
        );

        for (const oldKey of keysToRename) {
            const newKey = oldKey.replace(oldRelativePath, newRelativePath);
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
        this.provider.disconnect();
        this.provider.destroy();
        this.yDoc.destroy();
        this.awareness.setLocalState(null);
    }
}
