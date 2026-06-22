# Change Log

## [0.8.2] - 2026-06-22

### Changed

-   Updated the repository URL in the extension manifest

## [0.8.1] - 2026-06-22

### Added

-   Open-sourced Coducate under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
-   Added a link to the public source code repository in the extension manifest.

## [0.8.0] - 2026-06-22

### Added

-   Added a Coducate Control Panel in the Activity Bar sidebar with clickable buttons for all commands, grouped by category (Session, Access Control, Terminal, Web View, Appearance, Notes, Session Data). All commands remain available via the command palette.

### Changed

-   Starting a session no longer creates a temporary workspace file. Sessions now run directly in the open folder, removing the disruptive window reload when starting or ending a session.
-   Ending a session no longer closes and reopens the VS Code window. The session simply ends in-place.
-   Ending a session is now blocked if there are unresolved web client changes. A warning with a "Review Changes" button is shown instead.

### Fixed

-   Fixed sessions intermittently failing to persist, caused by VS Code's internal storage size limit (approx. 1.5 MB) being exceeded
-   Fixed second session not being saved when using multiple VS Code windows simultaneously
-   Fixed files appearing empty or corrupted after restoring a session, caused by files being added before synchronization completed

## [0.7.0] - 2026-03-04

### Added

-   Added `Coducate: Export Session` command to export a session as a ZIP file containing workspace files and hidden notes (stored in a `.coducate.json` file). Files and directories matching `coducate.exclusion.excludedFilePatterns` or `coducate.exclusion.excludedDirectories` are excluded from the exported ZIP file.

### Changed

-   Renamed the `coducate.exclusion.excludedFileExtensions` setting to `coducate.exclusion.excludedFilePatterns` to better reflect that entries are filename patterns, not just file extensions

-   Web participants can no longer join a session after it has been ended by the instructor. If a web participants was joined before the session was ended, they will be removed from the session and see a message indicating that the session has ended.

### Fixed

-   Fixed some files not being properly excluded from synchronization due to incorrect file extension matching
-   Fixed WebSocket reconnection loops after ending a session
-   Improved session security by preventing participants from hijacking another participant's client ID

## [0.6.0] - 2026-02-20

### Changed

-   Migrated production domain from coducate.me to coducate.live
-   Improved session security with token-based authentication
-   Changes made by web participants are now immediately visible in the instructor's VS Code, without needing to accept changes first. The instructor can still choose to accept the current version of the file or roll back to the last accepted version using the diff view.

### Fixed

-   Fixed synchronization issues between the shared editor and VS Code files when web participants are rapidly making changes, ensuring a more consistent collaborative experience

## [0.5.2] - 2025-10-22

### Changed

-   Migrated to new production domain at https://coducate.me

## [0.5.1] - 2025-04-09

### Added

-   Added icons to quickpick options across all commands for better visual distinction

### Changed

-   The `Coducate: Revoke Write Access` command now asks for confirmation before revoking write access from all participants
-   Minor improvements to the web view's design and layout for better usability

### Fixed

-   Fixed a bug where the `Coducate: Change Font Size` command was not responding to mouse clicks on quickpick options
-   Fixed GIF links in README to support Git LFS

## [0.5.0] - 2025-04-06

### Added

-   Implemented Terminal Shell Integration replacing the previous pseudoterminal approach, enabling seamless use of VS Code's native integrated terminal with broad shell support:
    -   Linux/macOS: bash, fish, pwsh, zsh
    -   Windows: Git Bash, pwsh
-   Added new `coducate.terminal.mirrorOnlyCoducateTerminals` setting to control which terminals are mirrored to the web view
-   Terminal background color is now set to white in light mode to improve readability

### Changed

-   Overhauled Coducate's web view with a modern design featuring fully resizable panels for enhanced workspace customization
-   Replaced the overlay menu with a new side menu for better accessibility and usability
-   Replaced `Coducate: Emulate Terminal` command with the new `Coducate: Create Coducate Terminal` command
-   Reorganized settings structure: moved exclusion settings under a dedicated `coducate.exclusion` namespace
    -   `coducate.excludedDirectories` → `coducate.exclusion.excludedDirectories`
    -   `coducate.excludedFileExtensions` → `coducate.exclusion.excludedFileExtensions`

### Fixed

-   Fixed numerous bugs in Coducate's web view, particularly related to the panel resizing functionality

## [0.4.1] - 2025-02-05

### Changed

-   Information messages now automatically disappear after five seconds. This makes them less distracting and reduces interruptions, as users no longer need to manually dismiss them.

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
