import type { ResolvedResource } from "@earendil-works/pi-coding-agent";

export type CapabilityKind = "skill" | "mcp";
export type CapabilityScope = "global" | "project";
export type CapabilityState = "enabled" | "disabled" | "inherit";

export interface SkillCapability {
  kind: "skill";
  key: string;
  name: string;
  description: string;
  sourceLabel: string;
  path: string;
  resource?: ResolvedResource;
  readOnly: boolean;
  globalState: CapabilityState;
  projectState: CapabilityState;
  inheritedEnabled: boolean;
  effectiveEnabled: boolean;
  visibleIn: CapabilityScope[];
}

export interface McpCapabilitySnapshot {
  version: number;
  servers: McpServerCapability[];
}

export interface McpServerCapability {
  name: string;
  enabled: boolean;
  status: "connected" | "needs-auth" | "failed" | "cached" | "idle" | "disabled" | "stale-cache";
  toolCount: number;
  directToolCount: number;
  cacheValid: boolean;
  source: "user" | "project" | "import" | "cache";
  importKind?: string;
  globalOverride?: boolean;
  projectOverride?: boolean;
  readOnly?: boolean;
}

export interface CapabilityRow {
  kind: CapabilityKind;
  key: string;
  name: string;
  description: string;
  sourceLabel: string;
  readOnly: boolean;
  globalState: CapabilityState;
  projectState: CapabilityState;
  inheritedEnabled: boolean;
  effectiveEnabled: boolean;
  visibleIn: CapabilityScope[];
  status?: McpServerCapability["status"];
  toolCount?: number;
  directToolCount?: number;
}

export interface CapabilityChange {
  row: CapabilityRow;
  scope: CapabilityScope;
  state: CapabilityState;
}

export interface CapabilityPanelResult {
  save: boolean;
  changes: CapabilityChange[];
}
