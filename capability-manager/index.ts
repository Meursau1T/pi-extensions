import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getMcpCapabilities, updateMcpCapabilities } from "./mcp-bridge.ts";
import { createCapabilitiesPanel } from "./panel.ts";
import { applySkillCapabilityChanges, discoverSkillCapabilities } from "./skills.ts";
import type {
  CapabilityChange,
  CapabilityPanelResult,
  CapabilityRow,
  CapabilityScope,
  McpServerCapability,
} from "./types.ts";

function mcpSourceLabel(server: McpServerCapability): string {
  if (server.source === "import") return server.importKind ? `import · ${server.importKind}` : "import";
  if (server.source === "cache") return "orphaned cache";
  return server.source;
}

function mcpDescription(server: McpServerCapability): string {
  if (server.status === "stale-cache") {
    return "Cached metadata remains, but the server is no longer configured.";
  }
  if (server.status === "disabled") return "Disabled. It will not start, search, or accept calls.";
  if (server.status === "needs-auth") return "Authentication is required before this server can connect.";
  if (server.status === "failed") return "The most recent connection attempt failed.";
  if (server.status === "connected") return "Connected for this session.";
  if (server.status === "cached") return "Tool metadata is available from cache; connection is lazy.";
  return "Configured. It will connect when first used.";
}

function mcpRows(pi: ExtensionAPI, cwd: string, projectAvailable: boolean): CapabilityRow[] {
  const snapshot = getMcpCapabilities(pi, cwd);
  if (!snapshot) {
    return [{
      kind: "mcp",
      key: "mcp:unavailable",
      name: "pi-mcp-adapter unavailable",
      description: "The MCP adapter did not expose its capability bridge.",
      sourceLabel: "read-only",
      readOnly: true,
      globalState: "disabled",
      projectState: "inherit",
      inheritedEnabled: false,
      effectiveEnabled: false,
      visibleIn: projectAvailable ? ["global", "project"] : ["global"],
      status: "disabled",
      toolCount: 0,
      directToolCount: 0,
    }];
  }

  return snapshot.servers
    .map((server): CapabilityRow => {
      const globalEnabled = server.globalOverride !== false;
      const projectState = server.projectOverride === undefined
        ? "inherit"
        : server.projectOverride ? "enabled" : "disabled";
      return {
        kind: "mcp",
        key: `mcp:${server.name}`,
        name: server.name,
        description: mcpDescription(server),
        sourceLabel: mcpSourceLabel(server),
        readOnly: server.readOnly === true || server.status === "stale-cache",
        globalState: globalEnabled ? "enabled" : "disabled",
        projectState,
        inheritedEnabled: globalEnabled,
        effectiveEnabled: server.enabled,
        visibleIn: projectAvailable ? ["global", "project"] : ["global"],
        status: server.status,
        toolCount: server.toolCount,
        directToolCount: server.directToolCount,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function loadRows(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<CapabilityRow[]> {
  const projectAvailable = ctx.isProjectTrusted();
  const loadedSkills = ctx.getSystemPromptOptions().skills ?? [];
  const catalog = await discoverSkillCapabilities(ctx.cwd, projectAvailable, loadedSkills);
  return [
    ...catalog.skills,
    ...mcpRows(pi, ctx.cwd, projectAvailable),
  ];
}

function groupMcpChanges(changes: CapabilityChange[]): Map<CapabilityScope, Record<string, boolean | null>> {
  const grouped = new Map<CapabilityScope, Record<string, boolean | null>>();
  for (const change of changes) {
    if (change.row.kind !== "mcp" || change.row.readOnly) continue;
    const target = grouped.get(change.scope) ?? {};
    target[change.row.name] = change.state === "inherit" ? null : change.state === "enabled";
    grouped.set(change.scope, target);
  }
  return grouped;
}

async function saveChanges(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  changes: CapabilityChange[],
): Promise<void> {
  const mcpChanges = groupMcpChanges(changes);
  for (const [scope, values] of mcpChanges) {
    const result = updateMcpCapabilities(pi, ctx.cwd, scope, values);
    if (!result.ok) throw new Error(result.error ?? "Failed to update MCP server states");
  }

  await applySkillCapabilityChanges(ctx.cwd, ctx.isProjectTrusted(), changes);
}

async function updateStatus(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  try {
    const projectAvailable = ctx.isProjectTrusted();
    const catalog = await discoverSkillCapabilities(
      ctx.cwd,
      projectAvailable,
      [],
    );
    const currentSkills = catalog.skills.filter((skill) =>
      skill.visibleIn.includes(projectAvailable ? "project" : "global"),
    );
    const skillEnabled = currentSkills.filter((skill) =>
      projectAvailable ? skill.effectiveEnabled : skill.globalState === "enabled",
    ).length;
    const snapshot = getMcpCapabilities(pi, ctx.cwd);
    const configuredServers = snapshot?.servers.filter((server) => server.status !== "stale-cache") ?? [];
    const mcpEnabled = configuredServers.filter((server) => server.enabled).length;
    ctx.ui.setStatus(
      "capability-manager",
      ctx.ui.theme.fg(
        "dim",
        `caps S${skillEnabled}/${currentSkills.length} M${mcpEnabled}/${configuredServers.length}`,
      ),
    );
  } catch {
    ctx.ui.setStatus("capability-manager", undefined);
  }
}

export default function capabilityManager(pi: ExtensionAPI) {
  pi.registerCommand("caps", {
    description: "Manage Skills and MCP servers",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      let rows: CapabilityRow[];
      try {
        rows = await loadRows(pi, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      const result = await ctx.ui.custom<CapabilityPanelResult>(
        (tui, theme, keybindings, done) => createCapabilitiesPanel(
          rows,
          ctx.isProjectTrusted(),
          tui,
          theme,
          keybindings,
          done,
        ),
        {
          overlay: true,
          overlayOptions: {
            width: "90%",
            minWidth: 62,
            maxHeight: "90%",
            anchor: "center",
            margin: 1,
          },
        },
      );

      if (!result?.save || result.changes.length === 0) return;
      try {
        await saveChanges(pi, ctx, result.changes);
        ctx.ui.notify(`Saved ${result.changes.length} capability change${result.changes.length === 1 ? "" : "s"}`, "info");
        await ctx.reload();
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await updateStatus(pi, ctx);
  });
}
