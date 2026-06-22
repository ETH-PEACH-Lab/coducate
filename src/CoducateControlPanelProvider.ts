import * as vscode from "vscode";

interface CommandDefinition {
    label: string;
    command: string;
    icon: string;
    when: "always" | "sessionActive" | "noSession";
}

interface GroupDefinition {
    label: string;
    icon: string;
    when: "always" | "sessionActive";
    commands: CommandDefinition[];
}

const GROUPS: GroupDefinition[] = [
    {
        label: "Session",
        icon: "broadcast",
        when: "always",
        commands: [
            { label: "Start Session", command: "coducate.startSession", icon: "coducate-create", when: "noSession" },
            { label: "End Session", command: "coducate.endSession", icon: "debug-stop", when: "sessionActive" },
            { label: "Manage Sessions", command: "coducate.manageSessions", icon: "coducate-workspace", when: "always" },
        ],
    },
    {
        label: "Access Control",
        icon: "coducate-people-add",
        when: "sessionActive",
        commands: [
            { label: "Grant Write Access", command: "coducate.grantWriteAccess", icon: "coducate-person-add", when: "sessionActive" },
            { label: "Revoke Write Access", command: "coducate.revokeWriteAccess", icon: "coducate-person-delete", when: "sessionActive" },
        ],
    },
    {
        label: "Terminal",
        icon: "terminal",
        when: "sessionActive",
        commands: [
            { label: "Create Coducate Terminal", command: "coducate.createCoducateTerminal", icon: "add", when: "sessionActive" },
        ],
    },
    {
        label: "Web View",
        icon: "browser",
        when: "sessionActive",
        commands: [
            { label: "Open Explorer", command: "coducate.openExplorer", icon: "eye", when: "sessionActive" },
            { label: "Close Explorer", command: "coducate.closeExplorer", icon: "eye-closed", when: "sessionActive" },
            { label: "Open Terminal", command: "coducate.openTerminal", icon: "eye", when: "sessionActive" },
            { label: "Close Terminal", command: "coducate.closeTerminal", icon: "eye-closed", when: "sessionActive" },
            { label: "Show Room ID", command: "coducate.showRoomId", icon: "eye", when: "sessionActive" },
            { label: "Hide Room ID", command: "coducate.hideRoomId", icon: "eye-closed", when: "sessionActive" },
        ],
    },
    {
        label: "Appearance",
        icon: "symbol-color",
        when: "sessionActive",
        commands: [
            { label: "Increase Font Size", command: "coducate.increaseFontSize", icon: "coducate-increase", when: "sessionActive" },
            { label: "Decrease Font Size", command: "coducate.decreaseFontSize", icon: "coducate-decrease", when: "sessionActive" },
            { label: "Light Theme", command: "coducate.setLightTheme", icon: "coducate-light-mode", when: "sessionActive" },
            { label: "Dark Theme", command: "coducate.setDarkTheme", icon: "coducate-dark-mode", when: "sessionActive" },
        ],
    },
    {
        label: "Notes",
        icon: "note",
        when: "sessionActive",
        commands: [
            { label: "Create Note", command: "coducate.createNote", icon: "coducate-create", when: "sessionActive" },
            { label: "Remove Notes", command: "coducate.removeNotes", icon: "coducate-delete", when: "sessionActive" },
            { label: "Toggle Suggestions", command: "coducate.toggleSuggestions", icon: "coducate-rename", when: "sessionActive" },
        ],
    },
    {
        label: "Session Data",
        icon: "archive",
        when: "sessionActive",
        commands: [
            { label: "Export Session", command: "coducate.exportSession", icon: "cloud-download", when: "sessionActive" },
            { label: "Review Changes", command: "coducate.reviewChanges", icon: "diff", when: "sessionActive" },
        ],
    },
];

export class ControlPanelItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly groupId?: string
    ) {
        super(label, collapsibleState);
    }
}

export class CoducateControlPanelProvider implements vscode.TreeDataProvider<ControlPanelItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ControlPanelItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private isSessionActive = false;

    setSessionActive(active: boolean): void {
        this.isSessionActive = active;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ControlPanelItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ControlPanelItem): ControlPanelItem[] {
        if (!element) {
            return GROUPS
                .filter((g) => g.when === "always" || (g.when === "sessionActive" && this.isSessionActive))
                .map((g) => {
                    const item = new ControlPanelItem(g.label, vscode.TreeItemCollapsibleState.Expanded, g.label);
                    item.iconPath = new vscode.ThemeIcon(g.icon);
                    return item;
                });
        }

        const group = GROUPS.find((g) => g.label === element.groupId);
        if (!group) {
            return [];
        }

        return group.commands
            .filter((cmd) => {
                if (cmd.when === "always") { return true; }
                if (cmd.when === "sessionActive") { return this.isSessionActive; }
                if (cmd.when === "noSession") { return !this.isSessionActive; }
                return true;
            })
            .map((cmd) => {
                const item = new ControlPanelItem(cmd.label, vscode.TreeItemCollapsibleState.None);
                item.command = { command: cmd.command, title: cmd.label };
                item.iconPath = new vscode.ThemeIcon(cmd.icon);
                return item;
            });
    }
}
