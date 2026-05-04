/**
 * lsp-overlay.ts — Definition overlay for LSP-powered go-to-definition
 *
 * Manages an internal stack of definition contexts. Visually only the
 * topmost context is rendered. Arrow Right pushes deeper, Arrow Left pops.
 * Up/Down/PgUp/PgDn scroll within the current view.
 */

import type { Location } from "./lsp-client.js";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { readFileSync } from "node:fs";
import { LspClient } from "./lsp-client.js";

export type DefinitionContext = {
  filePath: string;
  lines: string[];
  defStartLine: number;
  defEndLine: number;
  scrollOffset: number;
};

export class DefinitionOverlay {
  private stack: DefinitionContext[] = [];
  private theme: Theme;
  private tui: { terminal: { rows: number }; requestRender: () => void };
  private lsp: LspClient;
  private repoDir: string;
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  // Picker state
  private _pickerMode = false;
  private _pickerItems: string[] = [];
  private _pickerIndex = 0;

  constructor(options: {
    theme: Theme;
    tui: { terminal: { rows: number }; requestRender: () => void };
    lsp: LspClient;
    repoDir: string;
  }) {
    this.theme = options.theme;
    this.tui = options.tui;
    this.lsp = options.lsp;
    this.repoDir = options.repoDir;
  }

  get active(): boolean {
    return this.stack.length > 0;
  }

  get pickerMode(): boolean {
    return this._pickerMode;
  }

  /** Push a new definition from a diff/definition line (file URI + line + char). */
  async push(uri: string, line: number, character: number): Promise<void> {
    const locations = await this.lsp.goToDefinition(uri, line, character);
    if (locations.length === 0) return;

    // Use first definition location
    const loc = locations[0];
    const filePath = this.uriToPath(loc.uri);
    if (!filePath) return;

    const content = this.readFile(filePath);
    if (!content) return;

    const lines = content.split("\n");
    // If trailing newline creates an extra empty line, strip it
    if (lines.at(-1) === "") lines.pop();

    this.stack.push({
      filePath,
      lines,
      defStartLine: loc.range.start.line,
      defEndLine: loc.range.end.line,
      scrollOffset: Math.max(0, loc.range.start.line - 3),
    });

    this.invalidate();
    this.tui.requestRender();
  }

  /** Pop the current definition. Returns false if stack is now empty. */
  pop(): boolean {
    this.stack.pop();
    this.invalidate();
    this.tui.requestRender();
    return this.stack.length > 0;
  }

  /** Clear all definitions and return to diff view. */
  clear(): void {
    this.stack = [];
    this.invalidate();
    this.tui.requestRender();
  }

  /** Scroll within the current definition view. */
  scroll(delta: number): void {
    const ctx = this.currentContext();
    if (!ctx) return;
    ctx.scrollOffset = Math.max(0, Math.min(ctx.lines.length - 1, ctx.scrollOffset + delta));
    this.invalidate();
    this.tui.requestRender();
  }

  /** Try go-to-definition on the currently visible line in the definition view. */
  async diveDeeper(): Promise<void> {
    const ctx = this.currentContext();
    if (!ctx) return;
    const lineIdx = ctx.scrollOffset;
    const line = ctx.lines[lineIdx];
    if (!line) return;
    const items = [...line.matchAll(/[a-zA-Z_$][a-zA-Z0-9_$]*/g)].map((m) => m[0]);
    if (items.length === 0) return;
    if (items.length === 1) {
      const col = line.indexOf(items[0]!);
      if (col < 0) return;
      await this.push(`file://${ctx.filePath}`, lineIdx, col);
      return;
    }
    this._pickerMode = true;
    this._pickerItems = items;
    this._pickerIndex = 0;
    this.invalidate();
    this.tui.requestRender();
  }

  navigatePicker(delta: number): void {
    if (!this._pickerMode || this._pickerItems.length === 0) return;
    this._pickerIndex = (this._pickerIndex + delta + this._pickerItems.length) % this._pickerItems.length;
    this.invalidate();
    this.tui.requestRender();
  }

  cancelPicker(): void {
    this._pickerMode = false;
    this._pickerItems = [];
    this.invalidate();
    this.tui.requestRender();
  }

  async selectPicker(): Promise<void> {
    if (!this._pickerMode) return;
    const symbol = this._pickerItems[this._pickerIndex];
    if (!symbol) return;
    const ctx = this.currentContext();
    if (!ctx) return;
    const lineIdx = ctx.scrollOffset;
    const line = ctx.lines[lineIdx];
    if (!line) return;
    const col = line.indexOf(symbol);
    if (col < 0) return;
    this._pickerMode = false;
    this._pickerItems = [];
    await this.push(`file://${ctx.filePath}`, lineIdx, col);
  }

  render(width: number): string[] {
    if (this.cachedLines.length > 0 && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const ctx = this.currentContext();
    if (!ctx) return this.emptyRender(width);

    const th = this.theme;
    const lines: string[] = [];
    const add = (s: string) => lines.push(s);
    const borderChar = "─";

    // Top border
    add(th.fg("border", borderChar.repeat(width)));

    // File path header
    const depthLabel = this.stack.length > 1 ? ` (${this.stack.length} deep)` : "";
    add(" " + th.fg("accent", th.bold(`Definition${depthLabel}`)));
    add(" " + th.fg("text", ctx.filePath));
    add(th.fg("border", borderChar.repeat(width)));

    // Content area
    const contentRows = Math.max(5, this.tui.terminal.rows - 10);

    // Picker mode — inline symbol selection
    if (this._pickerMode) {
      add(" " + th.fg("accent", "Select symbol to jump to definition:"));
      for (let i = 0; i < this._pickerItems.length; i++) {
        const arrow = i === this._pickerIndex ? th.fg("accent", "►") : " ";
        const item = this._pickerItems[i]!;
        const styled = i === this._pickerIndex ? th.bold(th.fg("text", item)) : th.fg("text", item);
        add(`  ${arrow} ${styled}`);
      }
      while (lines.length < contentRows + 4) add("");
      add(th.fg("border", borderChar.repeat(width)));
      add(" " + th.fg("dim", "[↑↓/j/k] navigate  [Enter/→] jump  [Esc/←] cancel"));
      add(th.fg("border", borderChar.repeat(width)));
      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
    }

    const end = Math.min(ctx.scrollOffset + contentRows, ctx.lines.length);

    for (let i = ctx.scrollOffset; i < end; i++) {
      const isDef = i >= ctx.defStartLine && i <= ctx.defEndLine;
      const lineNum = String(i + 1).padStart(4, " ");
      const text = ctx.lines[i] ?? "";
      const prefix = isDef ? th.fg("accent", `>${lineNum}`) : th.fg("dim", ` ${lineNum}`);
      const styled = isDef ? th.fg("text", text) : th.fg("muted", text);
      const full = `${prefix} │ ${styled}`;
      add(truncateToWidth(full, width));
    }

    // Pad if needed
    while (lines.length < contentRows + 4) {
      add("");
    }

    // Bottom border + help
    add(th.fg("border", borderChar.repeat(width)));
    add(" " + th.fg("dim", "[→] deeper  [←] back  [↑↓/PgUp/PgDn] scroll  [Esc] close"));
    const target = this.definitionTarget();
    if (target) add(" " + th.fg("accent", `→ ${target}`));
    add(th.fg("border", borderChar.repeat(width)));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = [];
  }

  // ── Private ────────────────────────────────────────────

  private currentContext(): DefinitionContext | undefined {
    return this.stack[this.stack.length - 1];
  }

  private emptyRender(width: number): string[] {
    const th = this.theme;
    const borderChar = "─";
    return [
      th.fg("border", borderChar.repeat(width)),
      " " + th.fg("muted", "No definition loaded"),
      th.fg("border", borderChar.repeat(width)),
    ];
  }

  private uriToPath(uri: string): string | null {
    if (uri.startsWith("file://")) return uri.slice("file://".length);
    return null;
  }

  private readFile(path: string): string | null {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }

  /** Find column of first identifier on a line, or -1 if none. */
  private findFirstIdentifier(line: string): number {
    const m = line.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/);
    return m ? (m.index ?? -1) : -1;
  }

  private definitionTarget(): string {
    const ctx = this.currentContext();
    if (!ctx) return "";
    const line = ctx.lines[ctx.scrollOffset];
    if (!line) return "";
    const m = line.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/);
    return m ? m[0] : "";
  }
}
