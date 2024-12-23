# Coducate

**Coducate** is a VS Code extension designed to streamline instructor-led live coding sessions. Whether you are teaching programming concepts, demonstrating coding techniques, or running an exercise class as a teaching assistant, Coducate provides all the necessary tools to make your live coding experience seamless and engaging.

---

## Features

-   **Start and End Live Sessions:** Easily begin or finish your live coding sessions.
-   **Manage Participant Access:** Grant or revoke write access to participants during the session.
-   **Diff-Editor view:** Compare the instructor's code with the participant's code in a side-by-side view.
    -   **Accept:** You can accept the participant's code to merge it with the instructor's code.
    -   **Reject:** You can reject the participant's code to keep the instructor's code and rollback the participant's changes.
-   **Notes Management:** Create and manage notes directly within the session. This allows you to prepare your live coding session in advance.
-   **Code Suggestions:** Toggle suggestions on and off to have inline (copilot-like) code suggestions based on the created notes.
    -   **Accept Next Word Suggestion:** Accept the next word suggestion to quickly add code to the editor.
    -   **Accept Next Line Suggestion:** Accept the next line suggestion to quickly add code to the editor.
    -   **Accept All Suggestions:** Accept all suggestions to quickly add all code suggestions to the editor.
-   **Terminal and Explorer Controls:**
    -   Open/close terminal and explorer views for a focused teaching environment.
    -   Emulate terminal inside VS Code with input and output shown in the web view in real-time.
-   **Font Size Adjustments:** Dynamically adjust font size to ensure readability for participants.
-   **Change Web View Theme:** Change the theme of the instructor's web view to suit your preferences.
-   **Session Management Tools:**
    -   Copy Room ID for easy sharing with participants.
    -   Manage ongoing sessions and previous sessions.

> Screenshot examples and animated walkthroughs coming soon!

---

## Requirements

Coducate requires the following:

-   **VS Code Version:** 1.95.0 or higher.

---

## Extension Settings

Coducate currently provides the following settings for customization:

-   **`coducate.enable`:** Enable or disable the Coducate extension.
-   **`coducate.allowSuggestions`:** Toggle inline code suggestions (from notes) during sessions.

---

## Keybindings

Coducate includes the following default keybindings:

-   **Toggle Suggestions:** `Ctrl+Shift+U` (Windows/Linux), `Cmd+Shift+U` (Mac).
-   **Accept Next Line Suggestion:** `Ctrl+Shift+Right` (Windows/Linux), `Cmd+Shift+Right` (Mac) when inline suggestions are visible.

---

## Known Issues

-   No known issues at this time.

---

## Release Notes

### 0.2.0

-   The emulated terminal now uses WSL (Bash) for Windows users. This change was made to ensure that the terminal behaves consistently across different operating systems.
-   Coducate now recommends to save the workspace as a workspace file before starting a session. This guarantees that multiple sessions on different VS Code windows do not conflict with each other.
-   Notifications added to the web view to inform users about their write access status.

### 0.1.0

-   Added a command to change the web view theme.
-   Task descriptions and learning goals are now optional when creating a session.
-   Copy room ID from information message or status bar.
-   Improved session organization with room ID stored in workspace-specific storage.

### 0.0.1

-   Initial release of Coducate.
-   Core features implemented:
    -   Start and end sessions.
    -   Grant and revoke write access to participants.
    -   Create and manage notes for copilot-like inline suggestions.
    -   Terminal and Explorer controls.
    -   Commands to adjust the web view UI of Coducate.

---
