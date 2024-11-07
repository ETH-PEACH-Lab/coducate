import * as vscode from "vscode";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn } from "child_process";
import { DisposableWebSocket } from "./DisposableWebSocket";

export class CaptureTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<void>();
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    onDidClose: vscode.Event<void> = this.closeEmitter.event;
    private outputFilePath: string;
    private outputStream: fs.WriteStream;

    constructor(
        private filePath: string,
        private disposableWebSocket: DisposableWebSocket
    ) {
        this.outputFilePath = path.join(os.tmpdir(), "output.txt");

        // Initialize a write stream to the output file for real-time writing
        this.outputStream = fs.createWriteStream(this.outputFilePath, {
            flags: "w",
        });
    }

    open(): void {
        this.writeEmitter.fire(`Running Python file: ${this.filePath}\r\n`);

        // Run the Python file and capture its output
        this.runPythonFileAndCaptureOutput(this.filePath);
    }

    close(): void {
        this.outputStream.close();
        this.closeEmitter.fire();
    }

    private async runPythonFileAndCaptureOutput(filePath: string) {
        // Spawn a Python process
        const process = spawn("python", [filePath]);

        // Capture stdout in real-time
        process.stdout.on("data", (data) => {
            const text = data.toString();
            this.writeToTerminalAndFile(text);
        });

        // Capture stderr in real-time
        process.stderr.on("data", (data) => {
            const text = data.toString();
            this.writeToTerminalAndFile(text);
        });

        // When the process exits, finish up
        process.on("close", () => {
            this.writeEmitter.fire("\r\nProcess completed.\r\n");

            // Sync the captured output to fileYMap
            this.disposableWebSocket.addOutputToYMap(
                this.outputFilePath,
                fs.readFileSync(this.outputFilePath, "utf-8")
            );

            this.close();
        });
    }

    private writeToTerminalAndFile(text: string) {
        // Write output to the terminal in real-time
        this.writeEmitter.fire(text.replace(/\n/g, "\r\n"));

        // Write to the output file in real-time
        this.outputStream.write(text);

        // Optionally update fileYMap with the current output buffer
        // This ensures fileYMap is updated with each new chunk of data
        const currentOutput = fs.readFileSync(this.outputFilePath, "utf-8");
        this.disposableWebSocket.addOutputToYMap(
            this.outputFilePath,
            currentOutput
        );
    }
}
