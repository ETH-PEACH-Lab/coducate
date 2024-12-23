# Change Log

All notable changes to the "Coducate" extension will be documented in this file.

## [0.2.0] - 2024-12-23

### Added

-   Added notifications to the web view to inform users about their write access status.

### Changed

-   The emulated terminal now uses WSL (Bash) for Windows users. This change was made to ensure that the terminal behaves consistently across different operating systems.
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
