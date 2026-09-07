import type { ResolvedResource } from "@earendil-works/pi-coding-agent";

export type CapabilityScope = "global" | "project";
export type CapabilityState = "enabled" | "disabled" | "inherit";

export interface SkillCapability {
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

export interface CapabilityChange {
  row: SkillCapability;
  scope: CapabilityScope;
  state: CapabilityState;
}

export interface CapabilityPanelResult {
  save: boolean;
  changes: CapabilityChange[];
}
