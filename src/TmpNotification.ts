import * as vscode from "vscode";

let activeCancellationToken: vscode.CancellationTokenSource | null = null;

/**
 * Show a temporary notification in the bottom right corner of the screen.
 *
 * @param {string} message - The message to be displayed in the notification.
 * @param {number} [duration=5000] - The duration in milliseconds for which the notification should be displayed.
 *
 * @returns {vscode.Disposable} A disposable object that cancels the notification.
 */
export function showTmpNotification(
    message: string,
    duration: number = 5000
): vscode.Disposable {
    if (activeCancellationToken) {
        activeCancellationToken.cancel(); // Cancel any ongoing notification
    }

    const cancellationToken = new vscode.CancellationTokenSource();
    activeCancellationToken = cancellationToken;

    vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
        },
        async (progress, token) => {
            const steps = 100;
            const delay = duration / steps;

            for (let i = 0; i < steps; i++) {
                if (cancellationToken.token.isCancellationRequested) {
                    return; // Stop updating progress if canceled
                }

                await new Promise<void>((resolve) => {
                    setTimeout(() => {
                        progress.report({ increment: 1, message: message });
                        resolve();
                    }, delay);
                });
            }
        }
    );

    return {
        dispose: () => {
            cancellationToken.cancel();
        },
    };
}
