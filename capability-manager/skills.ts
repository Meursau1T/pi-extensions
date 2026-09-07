import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  parseFrontmatter,
  type PackageSource,
  type ResolvedResource,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { CapabilityChange, CapabilityState, SkillCapability } from "./types.ts";

export interface SkillCatalog {
  skills: SkillCapability[];
  globalCount: number;
  projectCount: number;
}

function canonicalize(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return resolve(filePath);
  }
}

function skillFilePath(resourcePath: string): string {
  try {
    return statSync(resourcePath).isDirectory() ? join(resourcePath, "SKILL.md") : resourcePath;
  } catch {
    return resourcePath;
  }
}

function readSkillInfo(resourcePath: string): { name: string; description: string; path: string } {
  const path = skillFilePath(resourcePath);
  const fallbackName = basename(dirname(path));
  try {
    const parsed = parseFrontmatter(readFileSync(path, "utf8"));
    return {
      name: typeof parsed.frontmatter.name === "string" && parsed.frontmatter.name.trim()
        ? parsed.frontmatter.name.trim()
        : fallbackName,
      description: typeof parsed.frontmatter.description === "string"
        ? parsed.frontmatter.description.replace(/\s+/g, " ").trim()
        : "",
      path,
    };
  } catch {
    return { name: fallbackName, description: "", path };
  }
}

function sourceLabel(resource: ResolvedResource): string {
  const { metadata } = resource;
  if (metadata.origin === "package") {
    return `${metadata.source} · ${metadata.scope}`;
  }
  if (metadata.source === "auto") {
    return metadata.scope === "project" ? "project" : "user";
  }
  return `${metadata.source} · ${metadata.scope}`;
}

function loadedSourceLabel(skill: Skill): string {
  const info = skill.sourceInfo;
  return `${info.source} · ${info.scope}`;
}

function directiveTarget(entry: string): string {
  return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-")
    ? entry.slice(1)
    : entry;
}

function getOverrideState(
  entries: string[],
  patterns: Set<string>,
  emptyArrayIsDisabled: boolean,
): CapabilityState {
  if (entries.length === 0 && emptyArrayIsDisabled) return "disabled";
  let state: CapabilityState = "inherit";
  for (const entry of entries) {
    if (!patterns.has(directiveTarget(entry))) continue;
    state = entry.startsWith("!") || entry.startsWith("-") ? "disabled" : "enabled";
  }
  return state;
}

function topLevelBaseDir(scope: "global" | "project", cwd: string, agentDir: string): string {
  return scope === "project" ? join(cwd, CONFIG_DIR_NAME) : agentDir;
}

function resourcePatternForScope(
  resource: ResolvedResource,
  scope: "global" | "project",
  cwd: string,
  agentDir: string,
): string {
  const sourceScope = resource.metadata.scope === "project" ? "project" : "global";
  if (scope !== sourceScope) return resource.path;
  const baseDir = resource.metadata.baseDir ?? topLevelBaseDir(sourceScope, cwd, agentDir);
  return relative(baseDir, resource.path);
}

function topLevelPatterns(
  resource: ResolvedResource,
  scope: "global" | "project",
  cwd: string,
  agentDir: string,
): Set<string> {
  const baseDir = topLevelBaseDir(scope, cwd, agentDir);
  const patterns = new Set([
    resourcePatternForScope(resource, scope, cwd, agentDir),
    resource.path,
    relative(baseDir, resource.path),
  ]);
  if (resource.metadata.baseDir) patterns.add(relative(resource.metadata.baseDir, resource.path));
  return patterns;
}

function packageResourcePattern(resource: ResolvedResource): string {
  return relative(resource.metadata.baseDir ?? dirname(resource.path), resource.path);
}

function isLocalSource(source: string): boolean {
  return source === "."
    || source === ".."
    || source.startsWith("./")
    || source.startsWith("../")
    || source.startsWith("/")
    || source.startsWith("~/")
    || /^[A-Za-z]:[\\/]/.test(source);
}

function resolveLocalSource(source: string, baseDir: string): string {
  const expanded = source === "~"
    ? homedir()
    : source.startsWith("~/")
      ? join(homedir(), source.slice(2))
      : source;
  return resolve(baseDir, expanded);
}

function packageSourcesMatch(
  left: string,
  leftScope: "global" | "project",
  right: string,
  rightScope: "global" | "project",
  cwd: string,
  agentDir: string,
): boolean {
  if (left === right) return true;
  if (!isLocalSource(left) || !isLocalSource(right)) return false;
  return resolveLocalSource(left, topLevelBaseDir(leftScope, cwd, agentDir))
    === resolveLocalSource(right, topLevelBaseDir(rightScope, cwd, agentDir));
}

function findPackage(
  packages: PackageSource[],
  resource: ResolvedResource,
  targetScope: "global" | "project",
  cwd: string,
  agentDir: string,
): PackageSource | undefined {
  const sourceScope = resource.metadata.scope === "project" ? "project" : "global";
  return packages.find((pkg) => packageSourcesMatch(
    resource.metadata.source,
    sourceScope,
    typeof pkg === "string" ? pkg : pkg.source,
    targetScope,
    cwd,
    agentDir,
  ));
}

function projectOverrideState(
  resource: ResolvedResource,
  settingsManager: SettingsManager,
  cwd: string,
  agentDir: string,
): CapabilityState {
  const projectSettings = settingsManager.getProjectSettings();
  if (resource.metadata.origin === "top-level") {
    return getOverrideState(
      projectSettings.skills ?? [],
      topLevelPatterns(resource, "project", cwd, agentDir),
      false,
    );
  }

  const pkg = findPackage(projectSettings.packages ?? [], resource, "project", cwd, agentDir);
  if (!pkg || typeof pkg === "string" || pkg.skills === undefined) return "inherit";
  return getOverrideState(
    pkg.skills,
    new Set([packageResourcePattern(resource)]),
    pkg.autoload !== false,
  );
}

export async function discoverSkillCapabilities(
  cwd: string,
  projectTrusted: boolean,
  loadedSkills: Skill[],
): Promise<SkillCatalog> {
  const agentDir = getAgentDir();
  const globalSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const globalResolved = await new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: globalSettings,
  }).resolve();

  const projectSettings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const projectResolved = projectTrusted
    ? await new DefaultPackageManager({ cwd, agentDir, settingsManager: projectSettings }).resolve()
    : globalResolved;

  const byKey = new Map<string, SkillCapability>();
  const globalByPath = new Map(
    globalResolved.skills.map((resource) => [canonicalize(skillFilePath(resource.path)), resource]),
  );

  for (const resource of globalResolved.skills) {
    const info = readSkillInfo(resource.path);
    const key = canonicalize(info.path);
    byKey.set(key, {
      key: `skill:${key}`,
      name: info.name,
      description: info.description,
      sourceLabel: sourceLabel(resource),
      path: info.path,
      resource,
      readOnly: false,
      globalState: resource.enabled ? "enabled" : "disabled",
      projectState: "inherit",
      inheritedEnabled: resource.enabled,
      effectiveEnabled: resource.enabled,
      visibleIn: ["global"],
    });
  }

  for (const resource of projectResolved.skills) {
    const info = readSkillInfo(resource.path);
    const canonicalPath = canonicalize(info.path);
    const existing = byKey.get(canonicalPath);
    const inherited = globalByPath.get(canonicalPath)?.enabled
      ?? (resource.metadata.scope === "user" ? resource.enabled : true);
    const projectState = projectOverrideState(resource, projectSettings, cwd, agentDir);

    if (existing) {
      existing.projectState = projectState;
      existing.inheritedEnabled = inherited;
      existing.effectiveEnabled = resource.enabled;
      if (!existing.visibleIn.includes("project")) existing.visibleIn.push("project");
      continue;
    }

    byKey.set(canonicalPath, {
      key: `skill:${canonicalPath}`,
      name: info.name,
      description: info.description,
      sourceLabel: sourceLabel(resource),
      path: info.path,
      resource,
      readOnly: false,
      globalState: "enabled",
      projectState,
      inheritedEnabled: inherited,
      effectiveEnabled: resource.enabled,
      visibleIn: ["project"],
    });
  }

  for (const skill of loadedSkills) {
    const canonicalPath = canonicalize(skill.filePath);
    const existing = byKey.get(canonicalPath);
    if (existing) {
      const metadata = existing.resource?.metadata;
      const injected = !metadata
        || skill.sourceInfo.source !== metadata.source
        || skill.sourceInfo.scope !== metadata.scope
        || skill.sourceInfo.origin !== metadata.origin;
      if (injected) {
        existing.readOnly = true;
        existing.sourceLabel = `${loadedSourceLabel(skill)} · injected`;
        existing.description = `${skill.description.replace(/\s+/g, " ").trim()} (Current-process injection)`;
        existing.effectiveEnabled = true;
      }
      continue;
    }
    const visibleIn = skill.sourceInfo.scope === "user"
      ? ["global", "project"] as const
      : ["project"] as const;
    byKey.set(canonicalPath, {
      key: `skill:${canonicalPath}`,
      name: skill.name,
      description: skill.description.replace(/\s+/g, " ").trim(),
      sourceLabel: loadedSourceLabel(skill),
      path: skill.filePath,
      readOnly: true,
      globalState: "enabled",
      projectState: "inherit",
      inheritedEnabled: true,
      effectiveEnabled: true,
      visibleIn: [...visibleIn],
    });
  }

  const skills = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    skills,
    globalCount: skills.filter((skill) => skill.visibleIn.includes("global")).length,
    projectCount: skills.filter((skill) => skill.visibleIn.includes("project")).length,
  };
}

function removeMatchingEntries(entries: string[], patterns: Set<string>): string[] {
  return entries.filter((entry) => !patterns.has(directiveTarget(entry)));
}

function applyTopLevelGlobal(
  settingsManager: SettingsManager,
  resource: ResolvedResource,
  state: CapabilityState,
  cwd: string,
  agentDir: string,
): void {
  const pattern = resourcePatternForScope(resource, "global", cwd, agentDir);
  const current = settingsManager.getGlobalSettings().skills ?? [];
  const updated = removeMatchingEntries(current, topLevelPatterns(resource, "global", cwd, agentDir));
  updated.push(`${state === "enabled" ? "+" : "-"}${pattern}`);
  settingsManager.setSkillPaths(updated);
}

function applyTopLevelProject(
  settingsManager: SettingsManager,
  resource: ResolvedResource,
  state: CapabilityState,
  inherited: boolean,
  cwd: string,
  agentDir: string,
): void {
  const current = settingsManager.getProjectSettings().skills ?? [];
  const pattern = inherited ? resource.path : resourcePatternForScope(resource, "project", cwd, agentDir);
  const patterns = topLevelPatterns(resource, "project", cwd, agentDir);
  let updated = removeMatchingEntries(current, patterns);
  if (state === "inherit" && inherited) {
    updated = updated.filter((entry) => directiveTarget(entry) !== pattern);
  } else if (state !== "inherit") {
    if (inherited && !updated.includes(pattern)) updated.push(pattern);
    updated.push(`${state === "enabled" ? "+" : "-"}${pattern}`);
  }
  settingsManager.setProjectSkillPaths(updated);
}

function applyPackageGlobal(
  settingsManager: SettingsManager,
  resource: ResolvedResource,
  state: CapabilityState,
  cwd: string,
  agentDir: string,
): void {
  const packages = [...(settingsManager.getGlobalSettings().packages ?? [])];
  const index = packages.findIndex((pkg) => packageSourcesMatch(
    resource.metadata.source,
    resource.metadata.scope === "project" ? "project" : "global",
    typeof pkg === "string" ? pkg : pkg.source,
    "global",
    cwd,
    agentDir,
  ));
  if (index < 0) return;

  const currentPackage = packages[index];
  const pkg = typeof currentPackage === "string" ? { source: currentPackage } : { ...currentPackage };
  const pattern = packageResourcePattern(resource);
  const updated = (pkg.skills ?? []).filter((entry) => directiveTarget(entry) !== pattern);
  updated.push(`${state === "enabled" ? "+" : "-"}${pattern}`);
  pkg.skills = updated;
  packages[index] = pkg;
  settingsManager.setPackages(packages);
}

function createProjectPackageOverride(
  resource: ResolvedResource,
  cwd: string,
  agentDir: string,
): Exclude<PackageSource, string> {
  const source = resource.metadata.source;
  if (!isLocalSource(source)) return { source, autoload: false };
  const sourceScope = resource.metadata.scope === "project" ? "project" : "global";
  const absolute = resolveLocalSource(source, topLevelBaseDir(sourceScope, cwd, agentDir));
  return {
    source: relative(topLevelBaseDir("project", cwd, agentDir), absolute) || ".",
    autoload: false,
  };
}

function applyPackageProject(
  settingsManager: SettingsManager,
  resource: ResolvedResource,
  state: CapabilityState,
  cwd: string,
  agentDir: string,
): void {
  const packages = [...(settingsManager.getProjectSettings().packages ?? [])];
  let index = packages.findIndex((pkg) => packageSourcesMatch(
    resource.metadata.source,
    resource.metadata.scope === "project" ? "project" : "global",
    typeof pkg === "string" ? pkg : pkg.source,
    "project",
    cwd,
    agentDir,
  ));

  if (index < 0) {
    if (state === "inherit") return;
    packages.push(createProjectPackageOverride(resource, cwd, agentDir));
    index = packages.length - 1;
  }

  const currentPackage = packages[index];
  if (currentPackage === undefined) return;
  const pkg = typeof currentPackage === "string" ? { source: currentPackage } : { ...currentPackage };
  const pattern = packageResourcePattern(resource);
  const updated = (pkg.skills ?? []).filter((entry) => directiveTarget(entry) !== pattern);
  if (state !== "inherit") updated.push(`${state === "enabled" ? "+" : "-"}${pattern}`);
  pkg.skills = updated.length > 0 ? updated : undefined;

  const hasFilters = pkg.extensions !== undefined
    || pkg.skills !== undefined
    || pkg.prompts !== undefined
    || pkg.themes !== undefined;
  if (!hasFilters) {
    if (pkg.autoload === false) packages.splice(index, 1);
    else packages[index] = pkg.source;
  } else {
    packages[index] = pkg;
  }
  settingsManager.setProjectPackages(packages);
}

export async function applySkillCapabilityChanges(
  cwd: string,
  projectTrusted: boolean,
  changes: CapabilityChange[],
): Promise<void> {
  const relevant = changes.filter(
    (change) => !change.row.readOnly && change.state !== "inherit",
  );
  const projectInheritChanges = changes.filter(
    (change) => !change.row.readOnly && change.scope === "project" && change.state === "inherit",
  );
  if (relevant.length === 0 && projectInheritChanges.length === 0) return;

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });

  for (const change of [...relevant, ...projectInheritChanges]) {
    const skill = change.row;
    const resource = skill.resource;
    if (!resource) continue;
    const inherited = skill.visibleIn.includes("global");

    if (change.scope === "global") {
      if (resource.metadata.origin === "package") {
        applyPackageGlobal(settingsManager, resource, change.state, cwd, agentDir);
      } else {
        applyTopLevelGlobal(settingsManager, resource, change.state, cwd, agentDir);
      }
      continue;
    }

    if (!projectTrusted) throw new Error("Project is not trusted");
    if (resource.metadata.origin === "package") {
      applyPackageProject(settingsManager, resource, change.state, cwd, agentDir);
    } else {
      applyTopLevelProject(settingsManager, resource, change.state, inherited, cwd, agentDir);
    }
  }

  await settingsManager.flush();
}
