import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
  CapabilityChange,
  CapabilityPanelResult,
  CapabilityScope,
  CapabilityState,
  SkillCapability,
} from "./types.ts";

interface PanelTui {
  requestRender(): void;
}

class SkillManagerPanel {
  private scope: CapabilityScope = "global";
  private query = "";
  private selectedIndex = 0;
  private staged = new Map<string, CapabilityChange>();
  private readonly maxVisible = 9;

  constructor(
    private rows: SkillCapability[],
    private projectAvailable: boolean,
    private tui: PanelTui,
    private theme: Theme,
    private keybindings: KeybindingsManager,
    private done: (result: CapabilityPanelResult) => void,
  ) {}

  private stageKey(row: SkillCapability, scope = this.scope): string {
    return `${scope}\0${row.key}`;
  }

  private baselineState(row: SkillCapability, scope = this.scope): CapabilityState {
    return scope === "global" ? row.globalState : row.projectState;
  }

  private stateFor(row: SkillCapability, scope = this.scope): CapabilityState {
    return this.staged.get(this.stageKey(row, scope))?.state ?? this.baselineState(row, scope);
  }

  private inheritedFor(row: SkillCapability): boolean {
    const stagedGlobal = this.staged.get(this.stageKey(row, "global"));
    return stagedGlobal ? stagedGlobal.state === "enabled" : row.inheritedEnabled;
  }

  private effectiveFor(row: SkillCapability, scope = this.scope): boolean {
    const state = this.stateFor(row, scope);
    if (scope === "project" && state === "inherit") return this.inheritedFor(row);
    return state === "enabled";
  }

  private visibleRows(): SkillCapability[] {
    const query = this.query.trim().toLowerCase();
    return this.rows.filter((row) => {
      if (!row.visibleIn.includes(this.scope)) return false;
      if (!query) return true;
      return `${row.name} ${row.description} ${row.sourceLabel}`.toLowerCase().includes(query);
    });
  }

  private clampSelection(): void {
    const rows = this.visibleRows();
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, rows.length - 1)));
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

  private toggleSelected(): void {
    const row = this.visibleRows()[this.selectedIndex];
    if (!row || row.readOnly) return;

    const current = this.stateFor(row);
    const next = this.scope === "project"
      ? this.nextProjectState(row, current)
      : current === "enabled" ? "disabled" : "enabled";
    const key = this.stageKey(row);
    if (next === this.baselineState(row)) {
      this.staged.delete(key);
    } else {
      this.staged.set(key, { row, scope: this.scope, state: next });
    }
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

  private stateIcon(row: SkillCapability): string {
    if (row.readOnly) return this.theme.fg("dim", "[·]");
    const state = this.stateFor(row);
    if (this.scope === "project" && state === "inherit") {
      const inherited = this.inheritedFor(row) ? "on" : "off";
      return this.theme.fg("dim", `[= ${inherited}]`);
    }
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
    const rows = this.visibleRows();
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

    if (rows.length === 0) {
      lines.push(this.frame(this.theme.fg("dim", "No matching skills"), innerWidth));
    } else {
      const start = Math.max(0, Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        Math.max(0, rows.length - this.maxVisible),
      ));
      const end = Math.min(rows.length, start + this.maxVisible);
      for (let index = start; index < end; index++) {
        const row = rows[index];
        const selected = index === this.selectedIndex;
        const cursor = selected ? this.theme.fg("accent", "›") : " ";
        const name = selected ? this.theme.bold(row.name) : row.name;
        const dirty = this.staged.has(this.stageKey(row)) ? this.theme.fg("warning", " *") : "";
        lines.push(this.frame(
          `${cursor} ${this.stateIcon(row)} ${name}${dirty}  ${this.theme.fg("muted", row.sourceLabel)}`,
          innerWidth,
        ));
      }
      if (rows.length > this.maxVisible) {
        lines.push(this.frame(this.theme.fg("dim", `${this.selectedIndex + 1}/${rows.length}`), innerWidth));
      }
    }

    lines.push(this.divider(innerWidth));
    const selected = rows[this.selectedIndex];
    const detail = selected?.description
      || (selected?.readOnly ? "Read-only injected skill" : "Space or Enter changes its state");
    lines.push(this.frame(this.theme.fg("muted", detail), innerWidth));
    const scopeKeyHint = this.projectAvailable ? " · Tab/Ctrl+G scope" : "";
    lines.push(this.frame(`${this.summary()} · ${this.staged.size} unsaved${scopeKeyHint}`, innerWidth));
    lines.push(this.frame("↑↓ move · Space toggle · Ctrl+S save · Esc close", innerWidth));
    lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  invalidate(): void {}
}

export function createSkillManagerPanel(
  rows: SkillCapability[],
  projectAvailable: boolean,
  tui: PanelTui,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: CapabilityPanelResult) => void,
): SkillManagerPanel {
  return new SkillManagerPanel(rows, projectAvailable, tui, theme, keybindings, done);
}
