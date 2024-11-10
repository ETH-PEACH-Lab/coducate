import * as vscode from "vscode";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { DisposableWebSocket } from "./DisposableWebSocket";

export class CaptureTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<void>();
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    onDidClose: vscode.Event<void> = this.closeEmitter.event;

    private outputFilePath: string;
    private pythonProcess: ChildProcessWithoutNullStreams | null = null;

    private inputBuffer: string = ""; // Buffer for user input

    constructor(
        private filePath: string,
        private disposableWebSocket: DisposableWebSocket
    ) {
        this.outputFilePath = path.join(os.tmpdir(), "output.txt");

        // Clear the output file at the start
        fs.writeFileSync(this.outputFilePath, "");
    }

    open(): void {
        this.writeToTerminalOnly(
            `Running Python file: ${this.filePath}\r\n\r\n`
        );
        this.runPythonFileAndCaptureOutput(this.filePath);
    }

    close(): void {
        if (this.pythonProcess) {
            this.pythonProcess.kill();
        }
        this.closeEmitter.fire();
    }

    handleInput(data: string): void {
        if (data === "\r") {
            // User pressed Enter; send the buffered input to the Python process
            if (this.pythonProcess) {
                this.writeToTerminalAndFile(`\r\n`);
                this.pythonProcess.stdin.write(this.inputBuffer + "\n");
            }
            this.inputBuffer = ""; // Clear the buffer after sending input
        } else if (data === "\x7f") {
            // Handle backspace
            if (this.inputBuffer.length > 0) {
                this.inputBuffer = this.inputBuffer.slice(0, -1);
                this.writeEmitter.fire("\b \b"); // Remove character from terminal
                this.removeLastCharacterFromFile();
            }
        } else {
            // Add character to the buffer and display it in terminal/file in real-time
            this.inputBuffer += data;
            this.writeToTerminalAndFile(data);
        }
    }

    private async runPythonFileAndCaptureOutput(filePath: string) {
        this.pythonProcess = spawn("python", [filePath], {
            stdio: ["pipe", "pipe", "pipe"],
        });

        if (!this.pythonProcess) {
            this.writeToTerminalOnly("Failed to start the Python process.\r\n");
            this.close();
            return;
        }

        // Capture stdout in real-time
        this.pythonProcess.stdout.on("data", (data) => {
            this.writeToTerminalAndFile(data.toString());
        });

        // Capture stderr in real-time
        this.pythonProcess.stderr.on("data", (data) => {
            this.writeToTerminalAndFile(data.toString());
        });

        // Handle process exit
        this.pythonProcess.on("close", () => {
            this.writeToTerminalOnly("\r\nProcess completed.\r\n");
            this.close();
        });
    }

    private writeToTerminalAndFile(text: string) {
        // Write to the terminal
        this.writeEmitter.fire(text.replace(/\n/g, "\r\n"));

        // Append to the output file in real-time
        fs.appendFileSync(this.outputFilePath, text);

        const currentOutput = fs.readFileSync(this.outputFilePath, "utf-8");
        this.disposableWebSocket.addOutputToYMap(
            this.outputFilePath,
            currentOutput
        );
    }

    private writeToTerminalOnly(text: string) {
        // Write to the terminal but not to the file
        this.writeEmitter.fire(text.replace(/\n/g, "\r\n"));
    }

    private removeLastCharacterFromFile() {
        const content = fs.readFileSync(this.outputFilePath, "utf-8");

        // Remove the last character
        const updatedContent = content.slice(0, -1);

        fs.writeFileSync(this.outputFilePath, updatedContent);

        this.disposableWebSocket.addOutputToYMap(
            this.outputFilePath,
            updatedContent
        );
    }
}
