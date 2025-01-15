# Coducate

**Coducate** is a VS Code extension designed to streamline instructor-led live coding sessions. Whether you are teaching programming concepts, demonstrating coding techniques, or running an exercise class as a teaching assistant, Coducate provides all the necessary tools to make your live coding experience seamless and engaging.

---

## Features and Commands

### Start and End Live Sessions

Effortlessly begin or end your live coding sessions with Coducate.

-   **Command:** `Coducate: Start Session`
    -   Starts a new session or joins an existing session. Allows the instructor to set a room name, password, and optionally add a task description and/or learning goals.
-   **Command:** `Coducate: End Session`
    -   Ends the current live coding session.

**Demo:**

**Start Session:**
![Start Session](https://raw.githubusercontent.com/madbeamer/coducate-gifs/master/start_session.gif)

**End Session:**
![End Session](https://raw.githubusercontent.com/madbeamer/coducate-gifs/master/end_session.gif)

---

### Manage Sessions

Easily manage past and ongoing sessions.

-   **Command:** `Coducate: Manage Sessions`
    -   View, rename, or delete previous sessions and retrieve room passwords.

**Demo:**

![Manage Sessions](https://raw.githubusercontent.com/madbeamer/coducate-gifs/master/manage_sessions.gif)

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

![Grant and Revoke Write Access](https://raw.githubusercontent.com/madbeamer/coducate-gifs/master/grant_revoke_write_access.gif)

---

### Terminal Emulation

Provide participants with a real-time view of the instructor's terminal activity.

> **Note:** The terminal displayed in the web view is an emulated terminal and is always read-only for participants. The instructor interacts with the actual pseudo-terminal directly within VS Code.

-   **Command:** `Coducate: Emulate Terminal`
    -   Opens a pseudo-terminal running Bash (or WSL for Windows) in the instructor's environment. Input and output from the pseudo-terminal are synchronized and displayed in the emulated terminal across all web views.

**Demo:**

![Emulate Terminal](https://raw.githubusercontent.com/madbeamer/coducate-gifs/master/emulate_terminal.gif)

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

![Create and Remove Notes](https://raw.githubusercontent.com/madbeamer/coducate-gifs/master/create_use_remove_notes.gif)

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

    -   Open or close the emulated terminal in the web view.

> **Note:** The following commmands only affect the instructor's web view.

-   **Command:** `Coducate: Open Explorer` / `Coducate: Close Explorer`

    -   Open or close the file explorer in the instructor's web view.

-   **Command:** `Coducate: Change Font Size`

    -   Adjust the font size of the editor and the emulated terminal in the instructor's web view.

-   **Command:** `Coducate: Change Theme`
    -   Switch between light and dark themes in the instructor's web view.

**Demo:**

![Customize Web View](https://raw.githubusercontent.com/madbeamer/coducate-gifs/master/adjust_web_view.gif)

---

### Task Description and Learning Goals

Set the task description and learning goals for your live coding session by selecting two Markdown files when starting a new session.

**Demo:**

![Task Description and Learning Goals](https://raw.githubusercontent.com/madbeamer/coducate-gifs/master/task_description_learning_goals.gif)

---

## Requirements

Coducate requires the following:

-   **VS Code Version:** 1.95.0 or higher.
-   **Internet Connection**

---

## Keybindings

Coducate includes the following default keybindings:

-   **Toggle Suggestions:** `Ctrl+Shift+U`
-   **Accept Next Line Suggestion:** `Ctrl+Shift+Right` (Windows/Linux), `Cmd+Shift+Right` (Mac) when inline suggestions are visible.
