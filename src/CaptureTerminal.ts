import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import { DisposableWebSocket } from "./DisposableWebSocket";

const defaultLine = "$ ";
export class CaptureTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<void>();
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    onDidClose: vscode.Event<void> = this.closeEmitter.event;

    private outputFilePath: string;
    private inputBuffer: string = defaultLine; // The prompt for user input
    private cursorPosition: number = this.inputBuffer.length; // Track cursor position
    private commandOutputBuffer: string = ""; // Buffer for storing command outputs
    private shellProcess: ChildProcessWithoutNullStreams | null = null;
    private cwd: string = os.homedir();
    private isExpectingInput: boolean = false;

    constructor(private disposableWebSocket: DisposableWebSocket) {
        this.outputFilePath = path.join(os.tmpdir(), "coducateOutput.txt");
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
                console.log(`Active workspace folder set to: ${this.cwd}`);
                return;
            }
        }

        // Default to the home directory if no active workspace is found
        this.cwd = os.homedir();
        console.log(
            `No active workspace. Defaulting to home directory: ${this.cwd}`
        );
    }

    open(): void {
        // Write the initial prompt to the terminal and sync with fileYMap
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

                if (command === "clear") {
                    this.clearTerminal();
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

    private handleShellOutput(data: string) {
        // Detect if bash is ready for a new command
        if (data.includes("[READY]")) {
            this.isExpectingInput = false;
            this.writeToTerminal("\r\n" + this.inputBuffer);
        } else if (data.includes("[PROMPT]$ ")) {
            this.isExpectingInput = false;
        } else if (data.includes("[INPUT]> ")) {
            this.isExpectingInput = true;
        } else {
            this.isExpectingInput = false;
        }

        // Write the actual shell output to the terminal
        this.writeToTerminal(data);
        this.commandOutputBuffer += data;

        // Only show the prompt if not expecting further user input
        if (!this.isExpectingInput) {
            this.writeToTerminal("\r\n" + this.inputBuffer);
        }

        this.syncFile();
    }

    private runShell() {
        const env = {
            ...process.env,
            TERM: "xterm-256color",
            PS1: "[PROMPT]$ ", // Unique prompt marker for the main prompt
            PS2: "[INPUT]> ", // Unique prompt marker for multiline inputs
            PROMPT_COMMAND: `echo '[READY]'`, // Indicator for when a command finishes
        };

        try {
            this.shellProcess = spawn("bash", [], {
                cwd: this.cwd,
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

    private clearTerminal() {
        // Clear the command output buffer
        this.commandOutputBuffer = "";

        // Reset the input buffer
        this.inputBuffer = defaultLine;

        // Clear the terminal display
        this.writeEmitter.fire("\x1b[2J\x1b[H"); // Clears the terminal screen

        // Write the prompt to the terminal after clearing
        this.writeToTerminal(this.inputBuffer);

        // Sync the cleared state to the file and YMap
        this.syncFile();
    }

    private writeToTerminal(data: string) {
        this.writeEmitter.fire(data.replace(/\n/g, "\r\n"));
    }

    private syncFile() {
        // Combine the command output buffer and the current input buffer
        const fullContent = this.commandOutputBuffer + this.inputBuffer;
        fs.writeFileSync(this.outputFilePath, fullContent);
        this.disposableWebSocket.addOutputToYMap(
            this.outputFilePath,
            fullContent
        );
    }

    private clearFile() {
        fs.writeFileSync(this.outputFilePath, "");
        this.disposableWebSocket.addOutputToYMap(this.outputFilePath, "");
    }
}
