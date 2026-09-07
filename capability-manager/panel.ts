import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
  AggregateCapabilityState,
  CapabilityChange,
  CapabilityPanelResult,
  CapabilityScope,
  CapabilityState,
  SkillCapability,
  SkillFolderCapability,
} from "./types.ts";

interface PanelTui {
  requestRender(): void;
}

type PanelEntry =
  | { kind: "folder"; folder: SkillFolderCapability }
  | { kind: "skill"; row: SkillCapability; nested: boolean };

interface EntryBlock {
  name: string;
  entries: PanelEntry[];
}

class SkillManagerPanel {
  private scope: CapabilityScope = "global";
  private query = "";
  private selectedIndex = 0;
  private staged = new Map<string, CapabilityChange>();
  private readonly maxVisible = 10;

  constructor(
    private rows: SkillCapability[],
    private folders: SkillFolderCapability[],
    private projectAvailable: boolean,
    private tui: PanelTui,
    private theme: Theme,
    private keybindings: KeybindingsManager,
    private done: (result: CapabilityPanelResult) => void,
  ) {}

  private stageKey(kind: CapabilityChange["kind"], key: string, scope = this.scope): string {
    return `${scope}\0${kind}\0${key}`;
  }

  private skillStage(row: SkillCapability, scope = this.scope): CapabilityChange | undefined {
    const change = this.staged.get(this.stageKey("skill", row.key, scope));
    return change?.kind === "skill" ? change : undefined;
  }

  private folderStage(folder: SkillFolderCapability, scope = this.scope): CapabilityChange | undefined {
    const change = this.staged.get(this.stageKey("folder", folder.key, scope));
    return change?.kind === "folder" ? change : undefined;
  }

  private folderFor(row: SkillCapability): SkillFolderCapability | undefined {
    return row.folderKey ? this.folders.find((folder) => folder.key === row.folderKey) : undefined;
  }

  private folderChildren(folder: SkillFolderCapability, scope = this.scope): SkillCapability[] {
    const keys = new Set(folder.childKeys);
    return this.rows
      .filter((row) => keys.has(row.key) && row.visibleIn.includes(scope))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private baselineState(row: SkillCapability, scope = this.scope): CapabilityState {
    return scope === "global" ? row.globalState : row.projectState;
  }

  private stateFor(row: SkillCapability, scope = this.scope): CapabilityState {
    const own = this.skillStage(row, scope);
    if (own?.kind === "skill") return own.state;
    const folder = this.folderFor(row);
    const folderChange = folder && this.folderStage(folder, scope);
    if (folderChange?.kind === "folder") return folderChange.state;
    return this.baselineState(row, scope);
  }

  private inheritedFor(row: SkillCapability): boolean {
    const own = this.skillStage(row, "global");
    if (own?.kind === "skill") {
      if (own.state === "inherit") return this.baseEffectiveFor(row, "global");
      return own.state === "enabled";
    }
    const folder = this.folderFor(row);
    const folderChange = folder && this.folderStage(folder, "global");
    if (folderChange?.kind === "folder") return folderChange.state === "enabled";
    return row.inheritedEnabled;
  }

  private baseEffectiveFor(row: SkillCapability, scope = this.scope): boolean {
    const folder = this.folderFor(row);
    if (!folder) {
      return scope === "project" ? this.inheritedFor(row) : row.globalState === "enabled";
    }

    const folderChange = this.folderStage(folder, scope);
    if (folderChange?.kind === "folder") {
      if (scope === "project" && folderChange.state === "inherit") return this.inheritedFor(row);
      return folderChange.state === "enabled";
    }

    if (scope === "project") {
      if (folder.projectState === "enabled") return true;
      if (folder.projectState === "disabled") return false;
      return this.inheritedFor(row);
    }

    if (folder.globalState === "enabled") return true;
    if (folder.globalState === "disabled") return false;
    return row.globalState === "enabled";
  }

  private effectiveFor(row: SkillCapability, scope = this.scope): boolean {
    const own = this.skillStage(row, scope);
    if (own?.kind === "skill") {
      return own.state === "inherit" ? this.baseEffectiveFor(row, scope) : own.state === "enabled";
    }
    const folder = this.folderFor(row);
    const folderChange = folder && this.folderStage(folder, scope);
    if (folderChange?.kind === "folder") {
      if (scope === "project" && folderChange.state === "inherit") return this.inheritedFor(row);
      return folderChange.state === "enabled";
    }
    if (scope === "project" && row.projectState === "inherit") {
      const hasStagedGlobal = this.skillStage(row, "global") !== undefined
        || (folder ? this.folderStage(folder, "global") !== undefined : false);
      if (hasStagedGlobal || (folder && folder.projectState !== "inherit")) {
        return this.baseEffectiveFor(row, scope);
      }
    }
    return scope === "project" ? row.effectiveEnabled : row.globalState === "enabled";
  }

  private aggregate(values: boolean[]): AggregateCapabilityState {
    if (values.length === 0) return "mixed";
    if (values.every(Boolean)) return "enabled";
    if (values.every((value) => !value)) return "disabled";
    return "mixed";
  }

  private folderEffectiveState(folder: SkillFolderCapability): AggregateCapabilityState {
    return this.aggregate(this.folderChildren(folder).map((row) => this.effectiveFor(row)));
  }

  private folderIsInherited(folder: SkillFolderCapability): boolean {
    if (this.scope !== "project") return false;
    const folderChange = this.folderStage(folder);
    if (folderChange?.kind === "folder") {
      if (folderChange.state !== "inherit") return false;
    } else if (folder.projectState !== "inherit") {
      return false;
    }
    return this.folderChildren(folder).every((row) => this.stateFor(row) === "inherit");
  }

  private visibleEntries(): PanelEntry[] {
    const query = this.query.trim().toLowerCase();
    const scopedRows = this.rows.filter((row) => row.visibleIn.includes(this.scope));
    const rowByKey = new Map(scopedRows.map((row) => [row.key, row]));
    const claimed = new Set<string>();
    const blocks: EntryBlock[] = [];

    for (const folder of this.folders) {
      if (!folder.visibleIn.includes(this.scope)) continue;
      const children = folder.childKeys
        .map((key) => rowByKey.get(key))
        .filter((row): row is SkillCapability => row !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (children.length === 0) continue;
      for (const child of children) claimed.add(child.key);

      const folderMatches = !query
        || `${folder.name} ${folder.pattern} ${folder.sourceLabel}`.toLowerCase().includes(query);
      const matchingChildren = query && !folderMatches
        ? children.filter((row) =>
          `${row.name} ${row.description} ${row.sourceLabel}`.toLowerCase().includes(query),
        )
        : children;
      if (matchingChildren.length === 0) continue;
      blocks.push({
        name: folder.name,
        entries: [
          { kind: "folder", folder },
          ...matchingChildren.map((row) => ({ kind: "skill" as const, row, nested: true })),
        ],
      });
    }

    for (const row of scopedRows) {
      if (claimed.has(row.key)) continue;
      if (query && !`${row.name} ${row.description} ${row.sourceLabel}`.toLowerCase().includes(query)) {
        continue;
      }
      blocks.push({ name: row.name, entries: [{ kind: "skill", row, nested: false }] });
    }

    return blocks
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((block) => block.entries);
  }

  private clampSelection(): void {
    const entries = this.visibleEntries();
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, entries.length - 1)));
  }

  private switchScope(): void {
    if (!this.projectAvailable) return;
    this.scope = this.scope === "global" ? "project" : "global";
    this.selectedIndex = 0;
  }

  private nextProjectState(row: SkillCapability, current: CapabilityState): CapabilityState {
    const inheritedEnabled = this.inheritedFor(row);
    if (current === "inherit") return inheritedEnabled ? "disabled" : "enabled";
    if (current === "disabled") return inheritedEnabled ? "enabled" : "inherit";
    return inheritedEnabled ? "inherit" : "disabled";
  }

  private toggleSkill(row: SkillCapability): void {
    if (row.readOnly) return;
    const folder = this.folderFor(row);
    let next: CapabilityState;

    if (folder) {
      const targetEnabled = !this.effectiveFor(row);
      next = targetEnabled === this.baseEffectiveFor(row)
        ? "inherit"
        : targetEnabled ? "enabled" : "disabled";
    } else {
      const current = this.stateFor(row);
      next = this.scope === "project"
        ? this.nextProjectState(row, current)
        : current === "enabled" ? "disabled" : "enabled";
    }

    const key = this.stageKey("skill", row.key);
    const folderChange = folder && this.folderStage(folder);
    const baseline = folderChange ? "inherit" : this.baselineState(row);
    if (next === baseline) {
      this.staged.delete(key);
    } else {
      this.staged.set(key, { kind: "skill", row, scope: this.scope, state: next });
    }
  }

  private stageFolder(folder: SkillFolderCapability, state: CapabilityState): void {
    for (const row of this.folderChildren(folder)) {
      this.staged.delete(this.stageKey("skill", row.key));
    }

    const key = this.stageKey("folder", folder.key);
    const baselineEffective = this.scope === "global" ? folder.globalState : folder.effectiveState;
    if (state !== "inherit" && state === baselineEffective) {
      this.staged.delete(key);
      return;
    }
    if (
      this.scope === "project"
      && state === "inherit"
      && folder.projectState === "inherit"
      && this.folderChildren(folder).every((row) => row.projectState === "inherit")
    ) {
      this.staged.delete(key);
      return;
    }
    this.staged.set(key, { kind: "folder", folder, scope: this.scope, state });
  }

  private toggleFolder(folder: SkillFolderCapability): void {
    const state = this.folderEffectiveState(folder);
    this.stageFolder(folder, state === "enabled" ? "disabled" : "enabled");
  }

  private inheritSelectedFolder(): void {
    if (this.scope !== "project") return;
    const entry = this.visibleEntries()[this.selectedIndex];
    if (entry?.kind !== "folder") return;
    this.stageFolder(entry.folder, "inherit");
  }

  private toggleSelected(): void {
    const entry = this.visibleEntries()[this.selectedIndex];
    if (!entry) return;
    if (entry.kind === "folder") this.toggleFolder(entry.folder);
    else this.toggleSkill(entry.row);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.done({ save: false, changes: [] });
      return;
    }
    if (matchesKey(data, "ctrl+s")) {
      this.done({ save: true, changes: [...this.staged.values()] });
      return;
    }
    if (matchesKey(data, "ctrl+r")) {
      this.inheritSelectedFolder();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.input.tab") || matchesKey(data, "ctrl+g")) {
      this.switchScope();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape")) {
      if (this.query) {
        this.query = "";
        this.selectedIndex = 0;
        this.tui.requestRender();
      } else {
        this.done({ save: false, changes: [] });
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selectedIndex--;
      this.clampSelection();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.selectedIndex++;
      this.clampSelection();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.selectedIndex -= this.maxVisible;
      this.clampSelection();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.selectedIndex += this.maxVisible;
      this.clampSelection();
      this.tui.requestRender();
      return;
    }
    if (data === " " || this.keybindings.matches(data, "tui.select.confirm")) {
      this.toggleSelected();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (this.query) {
        this.query = [...this.query].slice(0, -1).join("");
        this.selectedIndex = 0;
        this.tui.requestRender();
      }
      return;
    }
    if (!data.includes("\x1b") && [...data].every((char) => (char.codePointAt(0) ?? 0) >= 32)) {
      this.query += data;
      this.selectedIndex = 0;
      this.tui.requestRender();
    }
  }

  private fit(text: string, width: number): string {
    const clipped = truncateToWidth(text, width, "…");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }

  private frame(text: string, innerWidth: number): string {
    return this.theme.fg("border", "│")
      + this.fit(` ${text}`, innerWidth)
      + this.theme.fg("border", "│");
  }

  private divider(innerWidth: number): string {
    return this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
  }

  private skillStateIcon(row: SkillCapability): string {
    if (row.readOnly) return this.theme.fg("dim", "[·]");
    const state = this.stateFor(row);
    if (state === "inherit") {
      const inherited = this.baseEffectiveFor(row) ? "on" : "off";
      return this.theme.fg("dim", `[= ${inherited}]`);
    }
    return this.effectiveFor(row)
      ? this.theme.fg("success", "[x]")
      : this.theme.fg("dim", "[ ]");
  }

  private folderStateIcon(folder: SkillFolderCapability): string {
    const state = this.folderEffectiveState(folder);
    if (this.folderIsInherited(folder)) {
      const inherited = state === "mixed" ? "~" : state === "enabled" ? "on" : "off";
      return this.theme.fg("dim", `[= ${inherited}]`);
    }
    if (state === "mixed") return this.theme.fg("warning", "[~]");
    return state === "enabled"
      ? this.theme.fg("success", "[x]")
      : this.theme.fg("dim", "[ ]");
  }

  private summary(): string {
    const rows = this.rows.filter((row) => row.visibleIn.includes(this.scope));
    const enabled = rows.filter((row) => this.effectiveFor(row)).length;
    return `${enabled}/${rows.length} skills enabled`;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const lines: string[] = [];
    const entries = this.visibleEntries();
    this.clampSelection();

    lines.push(this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`));
    lines.push(this.frame(this.theme.fg("accent", this.theme.bold("Skill Manager")), innerWidth));

    const globalScope = this.scope === "global"
      ? this.theme.fg("accent", this.theme.bold("[ Global ]"))
      : this.theme.fg("dim", "  Global  ");
    const projectScope = this.scope === "project"
      ? this.theme.fg("accent", this.theme.bold("[ Project ]"))
      : this.theme.fg("dim", "  Project  ");
    lines.push(this.frame(
      this.projectAvailable ? `${globalScope}  ${projectScope}` : globalScope,
      innerWidth,
    ));
    lines.push(this.frame(
      this.query
        ? `${this.theme.fg("accent", "search")} ${this.query}▌`
        : this.theme.fg("dim", "type to search"),
      innerWidth,
    ));
    lines.push(this.divider(innerWidth));

    if (entries.length === 0) {
      lines.push(this.frame(this.theme.fg("dim", "No matching skills"), innerWidth));
    } else {
      const start = Math.max(0, Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        Math.max(0, entries.length - this.maxVisible),
      ));
      const end = Math.min(entries.length, start + this.maxVisible);
      for (let index = start; index < end; index++) {
        const entry = entries[index];
        const selected = index === this.selectedIndex;
        const cursor = selected ? this.theme.fg("accent", "›") : " ";
        if (entry.kind === "folder") {
          const folder = entry.folder;
          const children = this.folderChildren(folder);
          const enabled = children.filter((row) => this.effectiveFor(row)).length;
          const name = selected ? this.theme.bold(`${folder.name}/`) : `${folder.name}/`;
          const dirty = this.staged.has(this.stageKey("folder", folder.key))
            ? this.theme.fg("warning", " *")
            : "";
          lines.push(this.frame(
            `${cursor} ${this.folderStateIcon(folder)} ▾ ${name}${dirty}  ${this.theme.fg("muted", `${enabled}/${children.length} · ${folder.sourceLabel}`)}`,
            innerWidth,
          ));
          continue;
        }

        const row = entry.row;
        const name = selected ? this.theme.bold(row.name) : row.name;
        const dirty = this.staged.has(this.stageKey("skill", row.key))
          ? this.theme.fg("warning", " *")
          : "";
        const indent = entry.nested ? "  " : "";
        lines.push(this.frame(
          `${indent}${cursor} ${this.skillStateIcon(row)} ${name}${dirty}  ${this.theme.fg("muted", row.sourceLabel)}`,
          innerWidth,
        ));
      }
      if (entries.length > this.maxVisible) {
        lines.push(this.frame(this.theme.fg("dim", `${this.selectedIndex + 1}/${entries.length}`), innerWidth));
      }
    }

    lines.push(this.divider(innerWidth));
    const selected = entries[this.selectedIndex];
    let detail = "Space or Enter changes its state";
    if (selected?.kind === "folder") {
      detail = `${selected.folder.pattern}/** · persistent rule for current and future Skills`;
    } else if (selected?.kind === "skill") {
      detail = selected.row.description
        || (selected.row.readOnly ? "Read-only injected skill" : detail);
    }
    lines.push(this.frame(this.theme.fg("muted", detail), innerWidth));
    const scopeKeyHint = this.projectAvailable ? " · Tab/Ctrl+G scope" : "";
    const inheritHint = this.scope === "project" && selected?.kind === "folder" ? " · Ctrl+R inherit" : "";
    lines.push(this.frame(`${this.summary()} · ${this.staged.size} unsaved${scopeKeyHint}`, innerWidth));
    lines.push(this.frame(`↑↓ move · Space toggle${inheritHint} · Ctrl+S save · Esc close`, innerWidth));
    lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  invalidate(): void {}
}

export function createSkillManagerPanel(
  rows: SkillCapability[],
  folders: SkillFolderCapability[],
  projectAvailable: boolean,
  tui: PanelTui,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: CapabilityPanelResult) => void,
): SkillManagerPanel {
  return new SkillManagerPanel(rows, folders, projectAvailable, tui, theme, keybindings, done);
}
