# Capability fork

This local package is based on `pi-mcp-adapter` 2.10.0. It adds `settings.serverStates`, hard server-disable gates, disabled-state rendering, and the synchronous `pi-mcp-adapter:capabilities:get` / `pi-mcp-adapter:capabilities:update` event bridge used by `capability-manager`.

The package is loaded from `./npm/local/pi-mcp-adapter` in `~/.pi/agent/settings.json`, so an npm package refresh does not overwrite these changes.
