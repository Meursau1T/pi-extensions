# Skill Manager

`capability-manager` is a standalone Pi extension for managing Skills. It has no MCP integration or adapter dependency.

Open `/caps` to manage Pi Skills in one panel.

Tab or Ctrl+G switches between global and trusted-project scope. Type to search, use the arrow keys to move, and press Space or Enter to change a state. Ctrl+S saves all staged changes and reloads Pi. Esc clears the search first, then closes without saving.

Skills stored below the same first-level directory under a `skills/` root are shown as one folder. The folder row displays how many child Skills are enabled. `[~]` means that the folder contains both enabled and disabled Skills. Skill paths are grouped before symbolic links are resolved, so a linked category such as `skills/lark/` keeps its visible folder structure.

Toggling a folder creates one persistent recursive rule. The rule applies to every current Skill below that directory and to Skills added there later. A folder operation clears older child overrides so the directory starts with one uniform state. Individual child Skills can then be toggled as exceptions. Folders from different local roots or packages are kept separate even when they have the same name.

Project state is inherited until explicitly enabled or disabled. A project folder can also override its inherited global folder state. Select a project folder and press Ctrl+R to remove its project folder rule and all child exceptions, returning the directory to inheritance.

State is persisted through Pi's normal `skills` and package filters. A disabled local folder uses a recursive path rule ending in `/skills/lark/**`; an absolute path keeps identically named folders from different roots isolated. Skill files are never moved or rewritten.

Skills injected only for the current process are shown as read-only and are not included in writable folder groups.
