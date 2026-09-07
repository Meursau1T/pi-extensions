# Skill Manager

`capability-manager` is a standalone Pi extension for managing Skills. It has no MCP integration or adapter dependency.

Open `/caps` to manage Pi Skills in one panel.

Tab or Ctrl+G switches between global and trusted-project scope. Type to search, use the arrow keys to move, and press Space or Enter to change a state. Ctrl+S saves all staged changes and reloads Pi. Esc clears the search first, then closes without saving.

Project state is inherited until explicitly enabled or disabled. Skill state is persisted through Pi's normal `skills` and package filters. Skill files are never moved or rewritten.

Skills injected only for the current process are shown as read-only.
