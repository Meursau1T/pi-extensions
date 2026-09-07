import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createSkillManagerPanel } from "./panel.ts";
import {
  applySkillCapabilityChanges,
  discoverSkillCapabilities,
  type SkillCatalog,
} from "./skills.ts";
import type { CapabilityPanelResult } from "./types.ts";

async function loadSkills(ctx: ExtensionCommandContext): Promise<SkillCatalog> {
  const projectAvailable = ctx.isProjectTrusted();
  const loadedSkills = ctx.getSystemPromptOptions().skills ?? [];
  return discoverSkillCapabilities(ctx.cwd, projectAvailable, loadedSkills);
}

async function updateStatus(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  try {
    const projectAvailable = ctx.isProjectTrusted();
    const catalog = await discoverSkillCapabilities(ctx.cwd, projectAvailable, []);
    const currentSkills = catalog.skills.filter((skill) =>
      skill.visibleIn.includes(projectAvailable ? "project" : "global"),
    );
    const enabled = currentSkills.filter((skill) =>
      projectAvailable ? skill.effectiveEnabled : skill.globalState === "enabled",
    ).length;
    ctx.ui.setStatus(
      "capability-manager",
      ctx.ui.theme.fg("dim", `skills ${enabled}/${currentSkills.length}`),
    );
  } catch {
    ctx.ui.setStatus("capability-manager", undefined);
  }
}

export default function capabilityManager(pi: ExtensionAPI) {
  pi.registerCommand("caps", {
    description: "Manage Skills",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      let catalog: SkillCatalog;
      try {
        catalog = await loadSkills(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      const result = await ctx.ui.custom<CapabilityPanelResult>(
        (tui, theme, keybindings, done) => createSkillManagerPanel(
          catalog.skills,
          catalog.folders,
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
        await applySkillCapabilityChanges(ctx.cwd, ctx.isProjectTrusted(), result.changes);
        ctx.ui.notify(
          `Saved ${result.changes.length} Skill change${result.changes.length === 1 ? "" : "s"}`,
          "info",
        );
        await ctx.reload();
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await updateStatus(ctx);
  });
}
