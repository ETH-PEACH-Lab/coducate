# Change Log

## [0.4.0] - 2025-02-04

### Added

-   Introduced extension settings for excluding specific directories and file extensions from syncing. The extension supports both user and workspace settings.
-   Added commands to toggle the room ID display, showing it large on full screen for better readability on the instructor's projection. It can also be toggled by clicking on the room ID in the web view.

### Changed

-   Enforced multi-root workspace within the same VS Code window, ensuring a more seamless workflow. This prevents the instructor from accidentally coding in the wrong VS Code window.
-   Improved the command prompts by adding clear cancellation instructions, enhancing the user experience.
-   Enhanced Coducate's web view by making pop-ups closable by clicking outside the pop-up window.

### Fixed

-   Fixed a bug where the extension indicated that WebSockets were connected even when the connection was lost.

## [0.3.1] - 2025-01-16

### Added

-   Added full-resolution logo for improved visual quality in the VS Code marketplace.

### Changed

-   Updated information messages for consistency.

### Removed

-   Deleted outdated low-resolution logo.
-   Cleaned up unused code, including commented-out sections and unnecessary console logs.

## [0.3.0] - 2025-01-15

### Changed

-   Added reconnection logic for WebSockets to improve connection stability. This ensures the connection is automatically re-established in scenarios such as networking issues or standby mode.
-   Files containing participant changes are now set to read-only. If the instructor disables read-only mode and attempts to edit these files, a warning is displayed.

### Fixed

-   When Coducate creates a workspace for the user while creating a new session or joining an existing session, it now restores the open files in the new workspace window.
-   Ensured notes are automatically deleted from VS Code's global state when the corresponding room is removed.
-   Fixed a bug where the diff view failed to update if modified files became identical.

## [0.2.0] - 2024-12-23

### Added

-   Added notifications to the web view to inform users about their write access status.

### Changed

-   The pseudo-terminal now uses WSL (Bash) for Windows users. This change was made to ensure that the terminal behaves consistently across different operating systems.
-   Coducate now recommends to save the workspace as a workspace file before starting a session. This guarantees that multiple sessions on different VS Code windows do not conflict with each other.

### Fixed

-   Fixed an issue where adding a second root folder to the workspace would require the user to restart the session. This occurred because the workspace storage was lost when transitioning to a multi-root workspace.

## [0.1.0] - 2024-12-19

### Added

-   Added command to change the theme of the instructor's web view.

### Changed

-   Task description and learning goals are no longer mandatory when creating a session.
-   After starting, restoring or joining a session, the room ID can be copied to the clipboard by clicking on the information message (clicking on the Coducate status bar item also works).

### Fixed

-   The room ID is now stored in the workspace storage and no longer in the global storage to prevent conflicts between different workspaces.
-   Removed error messages when cancelling commands. Instead, commands are now silently cancelled.
-   Refactored the use of error, warning, and information messages to provide a more consistent user experience.

## [0.0.1] - 2024-12-18

### Added

-   Initial release of Coducate.
-   Added functionality to start and end live coding sessions.
-   Included participant access management (grant/revoke write access).
-   Added session management tools.
-   Introduced terminal and explorer controls (open/close/emulate).
-   Added dynamic font size adjustment for sessions.
-   Included note creation and management.
-   Added commands to adjust the web view UI of Coducate.

---
