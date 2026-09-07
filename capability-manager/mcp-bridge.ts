import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CapabilityScope, McpCapabilitySnapshot } from "./types.ts";

interface BridgeUpdateResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export function getMcpCapabilities(pi: ExtensionAPI, cwd: string): McpCapabilitySnapshot | null {
  let snapshot: McpCapabilitySnapshot | null = null;
  pi.events.emit("pi-mcp-adapter:capabilities:get", {
    cwd,
    respond(value: unknown) {
      if (!value || typeof value !== "object") return;
      const candidate = value as Partial<McpCapabilitySnapshot>;
      if (candidate.version === 1 && Array.isArray(candidate.servers)) {
        snapshot = candidate as McpCapabilitySnapshot;
      }
    },
  });
  return snapshot;
}

export function updateMcpCapabilities(
  pi: ExtensionAPI,
  cwd: string,
  scope: CapabilityScope,
  changes: Record<string, boolean | null>,
): BridgeUpdateResult {
  let result: BridgeUpdateResult = {
    ok: false,
    error: "pi-mcp-adapter capability bridge is unavailable",
  };

  pi.events.emit("pi-mcp-adapter:capabilities:update", {
    cwd,
    scope,
    changes,
    respond(value: unknown) {
      if (!value || typeof value !== "object") return;
      const candidate = value as Partial<BridgeUpdateResult>;
      if (typeof candidate.ok === "boolean") {
        result = {
          ok: candidate.ok,
          path: typeof candidate.path === "string" ? candidate.path : undefined,
          error: typeof candidate.error === "string" ? candidate.error : undefined,
        };
      }
    },
  });

  return result;
}
