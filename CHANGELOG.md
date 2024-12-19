# Change Log

All notable changes to the "Coducate" extension will be documented in this file.

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

---
