import * as vscode from "vscode";
import { parse } from "@suin/osc633-parser";
import { SessionManager } from "./SessionManager";

export class TerminalShellIntegration {
    private sessionManager: SessionManager;
    private terminalProfileName: string;
    private mirrorOnlyCoducateTerminals: boolean = true;
    private pendingCommands: Map<string, string> = new Map();
    private outputFilePath: string;
    private commandOutputBuffer: string = "";
    private isTerminalOpen: boolean = false;
    private disposables: vscode.Disposable[] = [];

    constructor(
        context: vscode.ExtensionContext,
        sessionManager: SessionManager
    ) {
        this.sessionManager = sessionManager;
        this.terminalProfileName = `Coducate Terminal (${sessionManager.getRoomId()})`;
        this.outputFilePath = `coducateOutput_${sessionManager.getRoomId()}.txt`;
        this.clearFile();

        // Setup terminal listener
        const listenerDisposables = this.setupTerminalListener();

        // Track disposables for cleanup in the dispose method
        this.disposables.push(...listenerDisposables);
        context.subscriptions.push(...this.disposables);
    }

    public setMirrorOnlyCoducateTerminals(flag: boolean) {
        this.mirrorOnlyCoducateTerminals = flag;
    }

    public setTerminalFlag(flag: boolean) {
        this.isTerminalOpen = flag;
    }

    private setupTerminalListener(): vscode.Disposable[] {
        return [
            // Listen for terminal shell execution
            vscode.window.onDidStartTerminalShellExecution(async (event) => {
                if (
                    this.mirrorOnlyCoducateTerminals &&
                    event.terminal.name !== this.terminalProfileName
                ) {
                    // Ignore non-Coducate terminals
                    return;
                }

                const stream = event.execution.read();

                let output = "";
                let isCollecting = false;
                for await (const entry of parse(stream)) {
                    if (entry.type === "C") {
                        // command execution started
                        isCollecting = true;
                    } else if (entry.type === "D") {
                        // command execution finished
                        isCollecting = false;
                    } else if (entry.type === "output" && isCollecting) {
                        output += entry.value;
                    }
                }

                // let rawOutput = "";
                // for await (const chunk of stream) {
                //     rawOutput += chunk;
                // }

                // console.log("=================================");
                // console.log("Before terminal shell execution:\n");
                // console.log("Raw output:\n", rawOutput);
                // console.log("\n");
                // console.log("Command output:\n", output);
                // console.log("\n");
                // // const cleanedOutput = output.split("%")[0].trim();

                // // const outputLines = output.trim().split("\n");
                // // const cleanedOutput = outputLines
                // //     .filter((line) => !line.startsWith("%"))
                // //     .join("\n");

                // console.log("Command output cleaned:\n", cleanedOutput);

                // console.log(
                //     this.summarizeCommandLine(event.execution.commandLine)
                // );

                // console.log("=================================");

                const cleanedOutput = this.cleanTerminalOutput(output);

                // let commandLineAndOutput = "";
                // if (cleanedOutput !== "") {
                //     commandLineAndOutput = `$ <exitCode>${exitCode}</exitCode><command>${commandLine.value}</command>\n${cleanedOutput}\n\n`;
                // } else {
                //     commandLineAndOutput = `$ <exitCode>${exitCode}</exitCode><command>${commandLine.value}</command>\n\n`;
                // }

                // this.commandOutputBuffer += commandLineAndOutput;
                // this.syncFile();

                // Store the command and output in the pending list
                this.pendingCommands.set(
                    event.execution.commandLine.value,
                    cleanedOutput
                );
            }),

            vscode.window.onDidEndTerminalShellExecution(async (event) => {
                if (
                    this.mirrorOnlyCoducateTerminals &&
                    event.terminal.name !== this.terminalProfileName
                ) {
                    // Ignore non-Coducate terminals
                    return;
                }

                const commandLine = event.execution.commandLine;
                let output = this.pendingCommands.get(commandLine.value);

                // Check if the output is set, if not, wait for 10ms and try again
                if (output === undefined) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }

                output = this.pendingCommands.get(commandLine.value);

                if (output === undefined) {
                    // Ignore untracked command lines
                    vscode.window.showErrorMessage(
                        "Coducate: Problem detecting command line. Please try again. If the problem persists, please contact lukasmast07@gmail.com."
                    );
                    return;
                }

                if (!commandLine.isTrusted) {
                    // Ignore untrusted command lines
                    vscode.window.showErrorMessage(
                        "Coducate: Problem detecting command line. Please try again. If the problem persists, please contact lukasmast07@gmail.com."
                    );
                    return;
                }

                if (!this.isTerminalOpen) {
                    // Request the terminal to open
                    vscode.commands.executeCommand("coducate.openTerminal");
                }

                if (commandLine.value === "") {
                    // Ignore empty command lines
                    return;
                }

                if (commandLine.value === "exit") {
                    // Should be handled by the terminal close event
                    // Added here for extra safety
                    return;
                }

                if (commandLine.value === "clear") {
                    this.commandOutputBuffer = "";
                    this.clearFile();
                    return;
                }

                const exitCode = event.exitCode;

                if (exitCode === undefined) {
                    // Ignore undefined exit codes
                    vscode.window.showErrorMessage(
                        "Coducate: Problem detecting exit code. Please try again. If the problem persists, please contact lukasmast07@gmail.com."
                    );
                    return;
                }

                // Format output with exit code
                let commandLineAndOutput = "";
                if (output !== "") {
                    commandLineAndOutput = `$ <exitCode>${exitCode}</exitCode><command>${commandLine.value}</command>\n${output}\n\n`;
                } else {
                    commandLineAndOutput = `$ <exitCode>${exitCode}</exitCode><command>${commandLine.value}</command>\n\n`;
                }

                console.log(commandLineAndOutput);

                // Append to buffer and sync
                this.commandOutputBuffer += commandLineAndOutput;
                this.syncFile();

                // Remove from pending commands
                this.pendingCommands.delete(commandLine.value);
            }),

            // Create a Coducate terminal profile provider (allows Coducate terminal to be opened using the '+' button)
            vscode.window.registerTerminalProfileProvider(
                "coducate.coducate-terminal",
                {
                    provideTerminalProfile: () => {
                        return {
                            options: {
                                name: this.terminalProfileName,
                            },
                        };
                    },
                }
            ),

            // NOTE: Uncomment this to open the Coducate web terminal on terminal creation and not only on command execution
            // Listen for terminal open
            // vscode.window.onDidOpenTerminal((terminal) => {
            //     if (
            //         this.mirrorOnlyCoducateTerminals &&
            //         terminal.creationOptions.name !== this.terminalProfileName
            //     ) {
            //         return;
            //     }

            //     if (!this.isTerminalOpen) {
            //         vscode.commands.executeCommand("coducate.openTerminal");
            //     }
            // }),

            // Listen for terminal close
            vscode.window.onDidCloseTerminal((terminal) => {
                if (
                    this.mirrorOnlyCoducateTerminals &&
                    terminal.creationOptions.name !== this.terminalProfileName
                ) {
                    return;
                }

                if (this.isTerminalOpen) {
                    // Request the terminal to close
                    vscode.commands.executeCommand("coducate.closeTerminal");
                }
            }),
        ];
    }

    private cleanTerminalOutput(rawOutput: string): string {
        // Remove everything after ]2; (OSC sequence that sets window titles)
        rawOutput = rawOutput.replace(/\x1b\]2;.*$/, "");

        // Remove other escape sequences (color codes, OSC sequences)
        let cleanedOutput = rawOutput
            .replace(/\x1b\[[0-9;]*m/g, "") // Remove ANSI color codes
            .replace(/\x1b\][^\x07]*\x07/g, "") // Remove OSC sequences
            .replace(/\x1b\][^\x5c]*\x5c/g, "") // Remove sequences ending in \
            .replace(/\x1b[^\x07]*\x07/g, "") // Remove unknown sequences
            .replace(/\x1b[^\x5c]*\x5c/g, "") // Remove sequences ending in \
            .replace(/\r/g, ""); // Remove carriage returns

        // Remove the last line if it's just a '%' (might appear because of ohmyzsh customizations)
        let outputLines = cleanedOutput.trim().split("\n");
        if (
            outputLines.length > 0 &&
            outputLines[outputLines.length - 1].trim() === "%"
        ) {
            outputLines.pop();
        }

        return outputLines.join("\n").trim();
    }

    // private summarizeCommandLine(
    //     commandLine: vscode.TerminalShellExecutionCommandLine
    // ) {
    //     return [
    //         `  Command line: ${commandLine.value}`,
    //         `  Confidence: ${commandLine.confidence}`,
    //         `  Trusted: ${commandLine.isTrusted}`,
    //     ].join("\n");
    // }

    // This might be needed for powerlevel10k theme (and potentially other themes)
    // private parseTerminalOutputOSC133(rawOutput: string) {
    //     // Extract the command line from the OSC 2 sequence (window title)
    //     const commandMatch = rawOutput.match(/\x1b\]2;([^\x07]*)/);
    //     const commandLine = commandMatch ? commandMatch[1] : "Unknown";

    //     // Extract the exit code from the OSC 133;D sequence
    //     const exitCodeMatch = rawOutput.match(/\x1b\]133;D;([0-9]+)/);
    //     const exitCode = exitCodeMatch
    //         ? parseInt(exitCodeMatch[1], 10)
    //         : "Unknown";

    //     // Remove all escape sequences from the raw output
    //     let cleanedOutput = rawOutput
    //         .replace(/\x1b\[[^m]*m/g, "") // Remove ANSI color codes
    //         .replace(/\x1b\][^\x07]*\x07/g, "") // Remove OSC sequences
    //         .replace(/\x1b\][^\x5c]*\x5c/g, "") // Remove OSC sequences ending in \
    //         .replace(/\x1b[^\x07]*\x07/g, "") // Remove unknown sequences
    //         .replace(/\x1b[^\x5c]*\x5c/g, ""); // Remove sequences ending in \

    //     // Extract output by removing command line and special characters
    //     const outputLines = cleanedOutput.trim().split("\n");
    //     const output = outputLines
    //         .filter((line) => !line.startsWith("%"))
    //         .join("\n");

    //     return {
    //         commandLine,
    //         output,
    //         exitCode,
    //     };
    // }

    private syncFile() {
        this.sessionManager.addOutputToYMap(
            this.outputFilePath,
            this.commandOutputBuffer
        );
    }

    private clearFile() {
        this.sessionManager.addOutputToYMap(this.outputFilePath, "");
    }

    public dispose() {
        this.disposables.forEach((disposable) => disposable.dispose());
        this.disposables = [];
    }
}
