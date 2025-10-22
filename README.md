# Coducate

**Coducate** makes instructor-led live coding sessions more interactive, structured, and efficient. Whether you are teaching programming concepts, demonstrating coding techniques, or guiding participants through hands-on exercises, Coducate simplifies the process with powerful tools. It allows instructors to share their code in real-time, grant participants write access for interactive participation, and manage contributions with a built-in diff editor. Features like AI-powered code suggestions, terminal mirroring, interactive notes, and a customizable **[web view](https://coducate.me)**—inspired by PowerPoint’s presentation mode—help create an engaging and structured learning environment. The web view **separates the instructor’s view from the participants’ view**, allowing instructors to maintain their preferred setup while participants access a distraction-free interface on any browser-accessible device. This also enables the use of in-editor notes and AI code suggestions without exposing them to participants.

## Features and Commands

### Start and End Live Sessions

Effortlessly begin or end your live coding sessions with Coducate.

-   **Command:** `Coducate: Start Session`
    -   Starts a new session or joins an existing session. Allows the instructor to set a room name, password, and optionally add a task description and/or learning goals.
-   **Command:** `Coducate: End Session`
    -   Ends the current live coding session.

**Demo:**

**Start Session:**
![Start Session](https://media.githubusercontent.com/media/madbeamer/coducate-gifs/refs/heads/master/start_session.gif)

**End Session:**
![End Session](https://media.githubusercontent.com/media/madbeamer/coducate-gifs/refs/heads/master/end_session.gif)

---

### Manage Sessions

Easily manage past and ongoing sessions.

-   **Command:** `Coducate: Manage Sessions`
    -   View, rename, or delete previous sessions and retrieve room passwords.

**Demo:**

![Manage Sessions](https://media.githubusercontent.com/media/madbeamer/coducate-gifs/refs/heads/master/manage_sessions.gif)

---

### Participant Access Management

Control participant permissions to foster collaborative coding.

-   **Command:** `Coducate: Grant Write Access`
    -   Grant editing permissions to specific participants or all participants.
-   **Command:** `Coducate: Revoke Write Access`
    -   Revoke editing permissions from specific participants or all participants.
-   **Diff-Editor View:** Compare the instructor's code with the participants' code in a side-by-side view to manage contributions effectively.
    -   **Accept Changes:** Write the participants' code back to the instructor's VS Code editor.
    -   **Reject Changes:** Discard the participants' code and retain the instructor's version, rolling back the participants' changes in the web view.

**Demo:**

![Grant and Revoke Write Access](https://media.githubusercontent.com/media/madbeamer/coducate-gifs/refs/heads/master/grant_revoke_write_access.gif)

---

### Terminal Mirroring

Provide participants with a real-time view of the instructor's terminal activity.

> **Note:** The terminal displayed in the web view is mirrored from the instructor's environment and is always read-only for participants. The instructor interacts with the actual terminal directly within VS Code.

-   **Command:** `Coducate: Create Coducate Terminal`
-   Creates a native integrated terminal in the instructor's VS Code environment. Input and output from this terminal are synchronized and displayed in the mirrored terminal across all web views.
-   Uses your default terminal settings (shell, environment variables, working directory, etc.) configured in VS Code
-   Supported shells:
    -   Linux/macOS: bash, fish, pwsh, zsh
    -   Windows: Git Bash, pwsh

**Configuration:**

-   Use the `coducate.terminal.mirrorOnlyCoducateTerminals` setting to control whether all integrated terminals or only Coducate Terminals are mirrored to the web view.

**Demo:**

![Create Coducate Terminal](https://media.githubusercontent.com/media/madbeamer/coducate-gifs/refs/heads/master/mirror_terminal.gif)

---

### Notes Management

Enhance your session with dynamic in-editor notes.

-   **Command:** `Coducate: Create Note`

    -   Replace selected lines of code with a named note, providing inline suggestions in multiple modes:
        -   type it manually
        -   reveal it word-by-word (`Ctrl+Right` (Windows/Linux), `Cmd+Right` (Mac))
        -   line-by-line (`Ctrl+Shift+Right` (Windows/Linux), `Cmd+Shift+Right` (Mac))
        -   display it all at once (`Tab`).

-   **Command:** `Coducate: Remove Notes`
    -   Delete notes from the current file, the entire workspace, or specific notes by clicking their Code Lens.

**Demo:**

![Create and Remove Notes](https://media.githubusercontent.com/media/madbeamer/coducate-gifs/refs/heads/master/create_use_remove_notes.gif)

---

### Toggle Code Suggestions

Use AI-driven inline suggestions based on your notes or merge them with other AI tools like GitHub Copilot.

-   **Command:** `Coducate: Toggle Suggestions`
    -   Enables or disables inline code suggestions which are based on the notes. Suggestions from other AI tools remain visible.
-   **Keybinding:** `Ctrl+Shift+U`

---

### Customize Web View

Modify the web view appearance to create an optimal teaching environment, such as adjusting the font size to ensure readability. Customizations can also be made directly within the web view.

> **Note:** This command affects all web views, including those of the instructor and participants.

-   **Command:** `Coducate: Open Terminal` / `Coducate: Close Terminal`

    -   Open or close the mirrored terminal in the web view.

> **Note:** The following commmands only affect the instructor's web view.

-   **Command:** `Coducate: Open Explorer` / `Coducate: Close Explorer`

    -   Open or close the file explorer in the instructor's web view.

-   **Command:** `Coducate: Show Room ID` / `Coducate: Hide Room ID`

    -   Display the room ID on full screen in the instructor's web view.

-   **Command:** `Coducate: Change Font Size`

    -   Adjust the font size of the editor and the mirrored terminal in the instructor's web view.

-   **Command:** `Coducate: Change Theme`
    -   Switch between light and dark themes in the instructor's web view.

**Demo:**

![Customize Web View](https://media.githubusercontent.com/media/madbeamer/coducate-gifs/refs/heads/master/adjust_web_view.gif)

---

### Task Description and Learning Goals

Set the task description and learning goals for your live coding session by selecting two Markdown files when starting a new session.

**Demo:**

![Task Description and Learning Goals](https://media.githubusercontent.com/media/madbeamer/coducate-gifs/refs/heads/master/show_task_data.gif)

## Requirements

Coducate requires the following:

-   **VS Code Version:** 1.95.0 or higher.
-   **Internet Connection**

# Settings

Coducate includes the following settings. These can be set in user or workspace settings.

The `coducate.exclusion.excludedDirectories` setting is used to exclude directories from syncing. By default, the following directories are excluded:

```json
{
    "coducate.exclusion.excludedDirectories": [
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
        "__pycache__",
        ".DS_Store",
        ".idea",
        ".next",
        ".expo",
        "venv",
        "target"
    ]
}
```

The `coducate.exclusion.excludedFileExtensions` setting is used to exclude files with specific extensions from syncing. By default, the following file extensions are excluded:

```json
{
    "coducate.exclusion.excludedFileExtensions": [
        ".DS_Store",
        ".env",
        ".env.local",
        ".env.development",
        ".env.production",
        ".env.test",
        ".env.example",
        ".ipynb"
    ]
}
```

The `coducate.terminal.mirrorOnlyCoducateTerminals` setting controls which terminals are mirrored to the web view:

```json
{
    "coducate.terminal.mirrorOnlyCoducateTerminals": true
}
```

-   When set to `true` (default): Only terminals created with the `Coducate: Create Coducate Terminal` command will be mirrored.
-   When set to `false`: All integrated terminals will be mirrored to the web view.

## Keybindings

Coducate includes the following default keybindings:

-   **Toggle Suggestions:** `Ctrl+Shift+U`
-   **Accept Next Line Suggestion:** `Ctrl+Shift+Right` (Windows/Linux), `Cmd+Shift+Right` (Mac) when inline suggestions are visible.

## Known Issues

### Terminal Shell Integration

-   **ZSH Theme Compatibility**: Some ZSH themes, particularly those with complex prompts like `powerlevel10k`, may interfere with terminal output detection. This can result in missing or incorrectly displayed content in the mirrored terminal.

    If you experience issues with complex ZSH themes:

    1. Edit your `~/.zshrc` file
    2. Find the line with `ZSH_THEME="powerlevel10k/powerlevel10k"` (or similar)
    3. Change to a simpler theme: `ZSH_THEME="robbyrussell"`
    4. Reload your configuration: `source ~/.zshrc`
