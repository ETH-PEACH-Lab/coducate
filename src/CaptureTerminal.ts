import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import { SessionManager } from "./SessionManager";

const defaultLine = "$ ";
export class CaptureTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<void>();
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    onDidClose: vscode.Event<void> = this.closeEmitter.event;

    private outputFilePath: string;
    private inputBuffer: string = defaultLine; // The prompt for user input
    private cursorPosition: number = this.inputBuffer.length;
    private commandOutputBuffer: string = ""; // Buffer for storing command outputs
    private shellProcess: ChildProcessWithoutNullStreams | null = null;
    private cwd: string = os.homedir();

    constructor(private sessionManager: SessionManager) {
        this.outputFilePath = path.join(
            os.tmpdir(),
            `coducateOutput_${sessionManager.getRoomId()}.txt`
        );
        this.clearFile();
        this.setCwd();
    }

    private setCwd() {
        const activeEditor = vscode.window.activeTextEditor;

        if (activeEditor) {
            const activeWorkspaceFolder = vscode.workspace.getWorkspaceFolder(
                activeEditor.document.uri
            );
            if (activeWorkspaceFolder) {
                this.cwd = activeWorkspaceFolder.uri.fsPath;
                return;
            }
        }

        // Default to the home directory if no active workspace is found
        this.cwd = os.homedir();
    }

    open(): void {
        this.writeToTerminal(this.inputBuffer);
        this.syncFile();
        this.runShell();
    }

    close(): void {
        if (this.shellProcess) {
            this.shellProcess.kill();
        }
        this.closeEmitter.fire();
    }

    handleInput = (data: string) => {
        switch (data) {
            case "\r": // Enter key
                this.writeToTerminal(`\r${this.inputBuffer}\r\n`);
                const command = this.inputBuffer.slice(2).trim();

                if (command.startsWith("cd ")) {
                    const targetDir = command.slice(3).trim();
                    this.changeDirectory(targetDir);
                } else if (command === "cd") {
                    this.changeDirectory("~");
                } else if (command === "clear") {
                    this.clearTerminal();
                } else if (command === "exit") {
                    this.terminateShell();
                    return;
                } else if (command.length > 0) {
                    this.shellProcess?.stdin.write(command + "\n");

                    // Add the command to the output buffer
                    this.commandOutputBuffer += `\r${this.inputBuffer}\r\n`;
                }

                // Reset the input buffer after executing the command
                this.inputBuffer = defaultLine;
                this.cursorPosition = this.inputBuffer.length;
                this.syncFile();
                break;

            case "\x7f": // Backspace key
                if (this.cursorPosition > 2) {
                    this.inputBuffer =
                        this.inputBuffer.slice(0, this.cursorPosition - 1) +
                        this.inputBuffer.slice(this.cursorPosition);
                    this.cursorPosition--;

                    // Redraw the input buffer to shift characters left
                    this.redrawInputBuffer();
                    this.syncFile();
                }
                break;

            case "\x1b[D": // Left arrow key
                if (this.cursorPosition > 2) {
                    this.cursorPosition--;
                    this.writeEmitter.fire("\x1b[D");
                }
                break;

            case "\x1b[C": // Right arrow key
                if (this.cursorPosition < this.inputBuffer.length) {
                    this.cursorPosition++;
                    this.writeEmitter.fire("\x1b[C");
                }
                break;

            case "\x1b[A": // Up arrow key (disabled)
            case "\x1b[B": // Down arrow key (disabled)
                // Do nothing
                break;

            default: // Handle regular character input
                this.inputBuffer =
                    this.inputBuffer.slice(0, this.cursorPosition) +
                    data +
                    this.inputBuffer.slice(this.cursorPosition);
                this.cursorPosition++;
                this.redrawInputBuffer();
                this.syncFile();
                break;
        }
    };

    private runShell() {
        const env = {
            ...process.env,
            TERM: "xterm-256color",
        };

        const isWindows = os.platform() === "win32";
        const shellCommand = isWindows ? "wsl.exe" : "bash";

        try {
            const cwd = this.cwd;

            this.shellProcess = spawn(shellCommand, [], {
                cwd: cwd,
                env: env,
                stdio: ["pipe", "pipe", "pipe"],
            });

            this.shellProcess.stdout.on("data", (data) => {
                this.handleShellOutput(data.toString());
            });

            this.shellProcess.stderr.on("data", (data) => {
                this.handleShellOutput(data.toString());
            });

            this.shellProcess.on("close", () => {
                this.writeToTerminal("\r\nProcess completed.\r\n");
                this.close();
            });
        } catch (error: any) {
            this.writeToTerminal(`Error spawning shell: ${error.message}\r\n`);
            this.close();
        }
    }

    private terminateShell() {
        const message = "Process completed.";

        // Write the message to the terminal
        this.commandOutputBuffer += `\r${this.inputBuffer}\r\nProcess completed.`;
        this.writeToTerminal(message + "\r\n");

        // Sync the file and YMap before closing
        fs.writeFileSync(this.outputFilePath, this.commandOutputBuffer);
        this.sessionManager.addOutputToYMap(
            this.outputFilePath,
            this.commandOutputBuffer
        );

        // Terminate the shell process if it exists
        if (this.shellProcess) {
            this.shellProcess.kill();
            this.shellProcess = null;
        }

        // Close the terminal
        this.close();

        // Close the terminal panel
        vscode.commands.executeCommand(
            "workbench.action.terminal.toggleTerminal"
        );

        // Request the terminal to open
        vscode.commands.executeCommand("coducate.closeTerminal");
    }

    private handleShellOutput(data: string) {
        // Write the actual shell output to the terminal
        this.writeToTerminal(data);
        this.commandOutputBuffer += data;

        // Add a new line after each command output
        this.commandOutputBuffer += "\r\n";

        // Only show the prompt if not expecting further user input
        this.writeToTerminal("\r\n" + this.inputBuffer);

        this.syncFile();
    }

    private changeDirectory(targetDir: string) {
        // Record the `cd` command in the output buffer
        this.commandOutputBuffer += `\r${this.inputBuffer}\r\n`;

        let message = "";

        // If no directory is specified, go to the home directory
        if (targetDir === "~") {
            this.cwd = os.homedir();
        } else {
            const newPath = path.isAbsolute(targetDir)
                ? targetDir
                : path.join(this.cwd, targetDir);

            if (fs.existsSync(newPath) && fs.statSync(newPath).isDirectory()) {
                this.cwd = newPath;
            } else {
                message = `cd: no such file or directory: ${targetDir}\r\n`;
            }
        }

        // Write the result to the terminal and the output buffer
        this.writeToTerminal(message + "\r\n");
        this.commandOutputBuffer += message + "\r\n";

        // Write the updated prompt to the terminal
        this.inputBuffer = defaultLine;
        this.cursorPosition = this.inputBuffer.length;
        this.runShell();
        this.writeToTerminal(this.inputBuffer);

        // Sync the updated buffer to the file and YMap
        this.syncFile();
    }

    // Helper function to redraw the input buffer after inserting/deleting characters
    private redrawInputBuffer() {
        // Clear the current line and rewrite the prompt and inputBuffer
        this.writeEmitter.fire("\r\x1b[2K"); // Clear the current line
        this.writeEmitter.fire(this.inputBuffer);

        // Move the cursor to the correct position
        const cursorOffset = this.inputBuffer.length - this.cursorPosition;
        if (cursorOffset > 0) {
            this.writeEmitter.fire(`\x1b[${cursorOffset}D`);
        }
    }

    private clearTerminal() {
        // Clear the command output buffer
        this.commandOutputBuffer = "";

        // Reset the input buffer
        this.inputBuffer = defaultLine;

        // Clear the terminal display
        this.writeEmitter.fire("\x1b[2J\x1b[H");

        // Write the prompt to the terminal after clearing
        this.writeToTerminal(this.inputBuffer);

        // Sync the cleared state to the file and YMap
        this.syncFile();
    }

    private writeToTerminal(data: string) {
        this.writeEmitter.fire(data.replace(/\n/g, "\r\n"));
    }

    // Helper function to sync the command output buffer and input buffer to the output file
    private syncFile() {
        const fullContent = this.commandOutputBuffer + this.inputBuffer;
        fs.writeFileSync(this.outputFilePath, fullContent);
        this.sessionManager.addOutputToYMap(this.outputFilePath, fullContent);
    }

    private clearFile() {
        fs.writeFileSync(this.outputFilePath, "");
        this.sessionManager.addOutputToYMap(this.outputFilePath, "");
    }
}
