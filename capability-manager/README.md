# Capability Manager

Open `/caps` to manage Skills and MCP servers in one panel.

Tab switches between Skills and MCP. Ctrl+G switches between global and trusted-project scope. Type to search, use the arrow keys to move, and press Space or Enter to change a state. Ctrl+S saves all staged changes and reloads Pi. Esc clears the search first, then closes without saving.

Project state is inherited until explicitly enabled or disabled. Skill state is persisted through Pi's normal `skills` and package filters. MCP state is persisted as `settings.serverStates` in Pi-owned MCP config. Disabling an MCP server prevents startup, metadata search, proxy calls, and direct-tool registration while keeping the server definition, cache, and OAuth data.

Skills injected only for the current process and orphaned MCP cache entries are shown as read-only.
