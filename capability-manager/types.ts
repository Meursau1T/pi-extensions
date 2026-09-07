import type { ResolvedResource } from "@earendil-works/pi-coding-agent";

export type CapabilityScope = "global" | "project";
export type CapabilityState = "enabled" | "disabled" | "inherit";
export type AggregateCapabilityState = "enabled" | "disabled" | "mixed";

export interface SkillCapability {
  key: string;
  name: string;
  description: string;
  sourceLabel: string;
  path: string;
  resource?: ResolvedResource;
  folderKey?: string;
  readOnly: boolean;
  globalState: CapabilityState;
  projectState: CapabilityState;
  inheritedEnabled: boolean;
  effectiveEnabled: boolean;
  visibleIn: CapabilityScope[];
}

export interface SkillFolderCapability {
  key: string;
  name: string;
  sourceLabel: string;
  path: string;
  pattern: string;
  resource: ResolvedResource;
  childKeys: string[];
  visibleIn: CapabilityScope[];
  globalState: AggregateCapabilityState;
  projectState: CapabilityState;
  effectiveState: AggregateCapabilityState;
}

export interface SkillCapabilityChange {
  kind: "skill";
  row: SkillCapability;
  scope: CapabilityScope;
  state: CapabilityState;
}

export interface SkillFolderChange {
  kind: "folder";
  folder: SkillFolderCapability;
  scope: CapabilityScope;
  state: CapabilityState;
}

export type CapabilityChange = SkillCapabilityChange | SkillFolderChange;

export interface CapabilityPanelResult {
  save: boolean;
  changes: CapabilityChange[];
}
