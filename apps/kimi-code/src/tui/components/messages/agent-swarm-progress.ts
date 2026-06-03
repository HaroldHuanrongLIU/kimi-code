import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

const MIN_CELL_WIDTH = 32;
const CELL_GAP = '  ';
const FRAME_INTERVAL_MS = 80;
const BRAILLE_BAR_MIN_WIDTH = 5;
const BRAILLE_BAR_MAX_WIDTH = 8;
const BRAILLE_EMPTY = '⣀';
const BRAILLE_SPAWNING_RIGHT = '⣷';
const BRAILLE_SPAWNING_LEFT = '⣾';
const BRAILLE_RIGHT_COLUMN_FULL = '⢸';
const BRAILLE_LEVELS = ['⡀', '⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'] as const;
const SPAWNING_PHASE_GROUP_SIZE = 2;
const PHASE_LABEL_WIDTH = 'Completed'.length;
const MIN_LABEL_WIDTH = PHASE_LABEL_WIDTH;
const MAX_LATEST_MODEL_CHARS = 2_000;
const COMPLETE_FILL_MS = 360;
const FAILED_PLACEHOLDER_RED_FACTOR = 0.75;
const FAILED_PLACEHOLDER_NON_RED_FACTOR = 0.25;
const ORCHESTRATING_LABEL = 'Orchestrating...';
const SPAWNING_LABEL = 'Spawning...';

type AgentSwarmPhase = 'pending' | 'spawning' | 'working' | 'completed' | 'failed' | 'cancelled';

interface AgentSwarmMember {
  readonly index: number;
  readonly id: string;
  agentId?: string;
  phase: AgentSwarmPhase;
  ticks: number;
  itemText: string;
  latestModelText: string;
  completedAtMs?: number;
  failedAtMs?: number;
}

interface AgentSwarmSnapshot {
  readonly phase: AgentSwarmPhase;
  readonly ticks: number;
  readonly latestModelText: string;
  readonly phaseElapsedMs: number;
}

interface AgentSwarmResultStatus {
  readonly index: number;
  readonly status: 'completed' | 'failed';
}

interface AgentSwarmSummary {
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface AgentSwarmProgressOptions {
  readonly description: string;
  readonly colors: ColorPalette;
  readonly requestRender?: () => void;
}

const PHASE_LABELS: Record<AgentSwarmPhase, string> = {
  pending: 'Spawning',
  spawning: 'Spawning',
  working: 'Working',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export class AgentSwarmProgressComponent implements Component {
  private members: AgentSwarmMember[];
  private readonly seenToolCalls = new Set<string>();
  private description: string;
  private readonly colors: ColorPalette;
  private readonly requestRender: (() => void) | undefined;
  private inputComplete = false;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AgentSwarmProgressOptions) {
    this.description = options.description;
    this.colors = options.colors;
    this.requestRender = options.requestRender;
    this.members = [];
  }

  dispose(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  invalidate(): void {}

  updateArgs(
    args: Record<string, unknown>,
    options: { readonly streamingArguments?: string | undefined } = {},
  ): void {
    const description = agentSwarmDescriptionFromArgs(args);
    if (description.length > 0 || this.description.length === 0) {
      this.description = description;
    }
    const fullItemsCount = agentSwarmItemsFromArgs(args).length;
    const partialItems =
      options.streamingArguments === undefined
        ? []
        : agentSwarmPartialItemsFromArguments(options.streamingArguments);
    const fullItems = agentSwarmItemsFromArgs(args);
    const itemCount = Math.max(fullItemsCount, partialItems.length);
    if (itemCount > 0) this.ensureMemberCount(itemCount);
    this.updateItemTexts(fullItems, partialItems);
  }

  markInputComplete(): void {
    if (!this.inputComplete) {
      this.inputComplete = true;
      for (const member of this.members) {
        if (member.phase === 'pending') member.phase = 'spawning';
      }
    }
    this.startAnimationIfNeeded();
  }

  registerSubagent(input: {
    readonly agentId: string;
    readonly description?: string | undefined;
  }): void {
    const member = this.findMemberForSubagent(input.agentId, input.description);
    if (member === undefined) return;
    member.agentId = input.agentId;
    if (this.inputComplete && member.phase === 'pending') member.phase = 'spawning';
    this.startAnimationIfNeeded();
  }

  recordToolCall(input: {
    readonly agentId: string;
    readonly toolCallId: string;
  }): void {
    const key = `${input.agentId}:${input.toolCallId}`;
    if (this.seenToolCalls.has(key)) return;
    this.seenToolCalls.add(key);
    const member = this.findMemberByAgentId(input.agentId);
    if (member === undefined) return;
    member.ticks += 1;
    if (member.phase === 'pending' || member.phase === 'spawning') member.phase = 'working';
  }

  appendModelDelta(input: {
    readonly agentId: string;
    readonly delta: string;
  }): void {
    const member = this.findMemberByAgentId(input.agentId);
    if (member === undefined || input.delta.length === 0) return;
    member.latestModelText = `${member.latestModelText}${input.delta}`.slice(
      -MAX_LATEST_MODEL_CHARS,
    );
  }

  appendAssistantDelta(input: {
    readonly agentId: string;
    readonly delta: string;
  }): void {
    this.appendModelDelta(input);
  }

  markCompleted(agentId: string): void {
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined || member.phase === 'failed' || member.phase === 'cancelled') return;
    if (member.phase !== 'completed') member.completedAtMs = Date.now();
    delete member.failedAtMs;
    member.phase = 'completed';
    this.startAnimationIfNeeded();
  }

  markFailed(agentId: string): void {
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined) return;
    if (member.phase !== 'failed') member.failedAtMs = Date.now();
    member.phase = 'failed';
    delete member.completedAtMs;
    this.startAnimationIfNeeded();
  }

  markCancelled(agentId: string): void {
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined) return;
    member.phase = 'cancelled';
    delete member.completedAtMs;
    delete member.failedAtMs;
  }

  applyResult(output: string): void {
    for (const entry of parseAgentSwarmResultStatuses(output)) {
      this.ensureMemberCount(entry.index);
      const member = this.members[entry.index - 1];
      if (member === undefined) continue;
      if (entry.status === 'completed' && member.phase !== 'completed') {
        member.completedAtMs = Date.now();
      }
      if (entry.status === 'completed') delete member.failedAtMs;
      if (entry.status === 'failed' && member.phase !== 'failed') {
        member.failedAtMs = Date.now();
      }
      if (entry.status === 'failed') delete member.completedAtMs;
      member.phase = entry.status;
    }
    this.startAnimationIfNeeded();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width);
    if (this.members.length === 0) {
      const lines = [
        this.renderHeader(innerWidth, undefined),
        chalk.hex(this.colors.primary)('─'.repeat(innerWidth)),
        '',
        chalk.hex(this.colors.textMuted)(` ${ORCHESTRATING_LABEL}`),
        '',
        chalk.hex(this.colors.primary)('─'.repeat(innerWidth)),
      ];
      return lines.map((line) => truncateToWidth(line, innerWidth));
    }

    const snapshots = this.members.map((member): AgentSwarmSnapshot => ({
      phase: member.phase,
      ticks: member.ticks,
      latestModelText: member.latestModelText,
      phaseElapsedMs: terminalPhaseElapsedMs(member),
    }));
    const summary = summarizeSnapshots(snapshots);
    const lines = [
      this.renderHeader(innerWidth, summary),
      chalk.hex(this.colors.primary)('─'.repeat(innerWidth)),
      '',
      ...this.renderGrid(innerWidth, snapshots),
      '',
      chalk.hex(this.colors.primary)('─'.repeat(innerWidth)),
    ];
    return lines.map((line) => truncateToWidth(line, innerWidth));
  }

  private renderHeader(width: number, summary: AgentSwarmSummary | undefined): string {
    const title = chalk.hex(this.colors.primary).bold(' Agent swarm');
    const description =
      this.description.length > 0
        ? chalk.hex(this.colors.text)(`: ${this.description}`)
        : '';
    void summary;
    return truncateToWidth(title + description, width);
  }

  private renderGrid(width: number, snapshots: readonly AgentSwarmSnapshot[]): string[] {
    const columns = columnsForWidth(width, this.members.length);
    const gapWidth = visibleWidth(CELL_GAP);
    const cellWidth = Math.max(
      1,
      Math.floor((width - gapWidth * Math.max(0, columns - 1)) / columns),
    );
    const rows = Math.ceil(this.members.length / columns);
    const lines: string[] = [];

    for (let row = 0; row < rows; row += 1) {
      const cells: string[] = [];
      for (let col = 0; col < columns; col += 1) {
        const index = row * columns + col;
        const member = this.members[index];
        const snapshot = snapshots[index];
        if (member === undefined || snapshot === undefined) continue;
        cells.push(padAnsi(this.renderCell(member, snapshot, cellWidth), cellWidth));
      }
      lines.push(cells.join(CELL_GAP));
    }
    return lines;
  }

  private renderCell(member: AgentSwarmMember, snapshot: AgentSwarmSnapshot, width: number): string {
    if (snapshot.phase === 'pending') {
      return renderPendingCell(member, width, this.colors);
    }

    const fixedWidth = member.id.length + 1 + 2 + 1 + MIN_LABEL_WIDTH;
    const availableForBar = width - fixedWidth - 2;
    const barWidth =
      availableForBar >= BRAILLE_BAR_MIN_WIDTH
        ? Math.min(BRAILLE_BAR_MAX_WIDTH, availableForBar)
        : Math.max(1, availableForBar);
    const id = chalk.hex(this.colors.textDim)(member.id);
    const bar = brailleBar(
      snapshot.ticks,
      snapshot.phase,
      barWidth,
      this.colors,
      this.frame,
      member.index,
      snapshot.phaseElapsedMs,
    );
    const prefix = `${id} ${bar} `;
    const labelWidth = Math.max(1, width - visibleWidth(prefix));
    const label = renderCellLabel(snapshot, labelWidth, this.colors);
    return prefix + label;
  }

  private findMemberForSubagent(
    agentId: string,
    description: string | undefined,
  ): AgentSwarmMember | undefined {
    const existing = this.findMemberByAgentId(agentId);
    if (existing !== undefined) return existing;

    const index = parseAgentSwarmDescriptionIndex(description);
    if (index !== undefined) {
      this.ensureMemberCount(index);
      const byDescription = this.members[index - 1];
      if (byDescription !== undefined) return byDescription;
    }

    const unassigned = this.members.find((member) => member.agentId === undefined);
    if (unassigned !== undefined) return unassigned;

    this.ensureMemberCount(this.members.length + 1);
    return this.members.at(-1);
  }

  private findMemberByAgentId(agentId: string): AgentSwarmMember | undefined {
    return this.members.find((member) => member.agentId === agentId);
  }

  private ensureMemberCount(count: number): void {
    if (count <= this.members.length) return;
    this.members = [
      ...this.members,
      ...createMembers(count, this.inputComplete ? 'spawning' : 'pending').slice(this.members.length),
    ];
  }

  private updateItemTexts(fullItems: readonly string[], partialItems: readonly string[]): void {
    const count = Math.max(fullItems.length, partialItems.length, this.members.length);
    for (let index = 0; index < count; index += 1) {
      const member = this.members[index];
      if (member === undefined) continue;
      const itemText = fullItems[index] ?? partialItems[index];
      if (itemText !== undefined) member.itemText = itemText;
    }
  }

  private startAnimationIfNeeded(): void {
    if (this.requestRender === undefined || this.timer !== undefined) return;
    if (!this.hasAnimatedMembers()) return;
    const requestRender = this.requestRender;
    this.timer = setInterval(() => {
      this.frame += 1;
      requestRender();
      if (!this.hasAnimatedMembers()) this.dispose();
    }, FRAME_INTERVAL_MS);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  private hasAnimatedMembers(): boolean {
    const now = Date.now();
    return this.members.some((member) => {
      if (member.phase === 'spawning') return true;
      return (
        member.phase === 'completed' &&
        member.completedAtMs !== undefined &&
        now - member.completedAtMs < COMPLETE_FILL_MS
      ) || (
        member.phase === 'failed' &&
        member.failedAtMs !== undefined &&
        now - member.failedAtMs < COMPLETE_FILL_MS
      );
    });
  }
}

function createMembers(count: number, phase: AgentSwarmPhase): AgentSwarmMember[] {
  return Array.from({ length: count }, (_item, index) => ({
    index,
    id: String(index + 1).padStart(3, '0'),
    phase,
    ticks: 0,
    itemText: '',
    latestModelText: '',
  }));
}

function terminalPhaseElapsedMs(member: AgentSwarmMember): number {
  const startedAtMs = member.phase === 'completed'
    ? member.completedAtMs
    : member.phase === 'failed'
      ? member.failedAtMs
      : undefined;
  return startedAtMs === undefined ? 0 : Math.max(0, Date.now() - startedAtMs);
}

export function agentSwarmItemsFromArgs(args: Record<string, unknown>): string[] {
  const items = args['items'];
  if (!Array.isArray(items)) return [];
  return items.map(String);
}

export function agentSwarmPartialItemsCountFromArguments(argumentsText: string): number {
  return agentSwarmPartialItemsFromArguments(argumentsText).length;
}

export function agentSwarmPartialItemsFromArguments(argumentsText: string): string[] {
  const match = /"items"\s*:\s*\[/.exec(argumentsText);
  if (match === null) return [];
  const items: string[] = [];
  for (let i = match.index + match[0].length; i < argumentsText.length; i += 1) {
    const ch = argumentsText[i];
    if (ch === ']') return items;
    if (ch !== '"') continue;

    const parsed = parsePartialJsonString(argumentsText, i + 1);
    items.push(parsed.value);
    if (parsed.closed) {
      i = parsed.nextIndex;
      continue;
    }
    return items;
  }
  return items;
}

export function agentSwarmDescriptionFromArgs(args: Record<string, unknown>): string {
  const description = args['description'];
  return typeof description === 'string' ? description : '';
}

function parseAgentSwarmDescriptionIndex(description: string | undefined): number | undefined {
  if (description === undefined) return undefined;
  const match = /#(\d+)(?:\s|$|\()/.exec(description);
  if (match === null) return undefined;
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : undefined;
}

function parseAgentSwarmResultStatuses(output: string): AgentSwarmResultStatus[] {
  const result: AgentSwarmResultStatus[] = [];
  const blocks = output.split(/\n(?=\[agent \d+\]\n)/);
  for (const block of blocks) {
    const indexMatch = /^\[agent (\d+)\]$/m.exec(block);
    const statusMatch = /^status: (completed|failed)$/m.exec(block);
    if (indexMatch === null || statusMatch === null) continue;
    result.push({
      index: Number(indexMatch[1]),
      status: statusMatch[1] as 'completed' | 'failed',
    });
  }
  return result;
}

function columnsForWidth(width: number, count: number): number {
  if (count <= 1) return 1;
  const gapWidth = visibleWidth(CELL_GAP);
  const columns = Math.floor((width + gapWidth) / (MIN_CELL_WIDTH + gapWidth));
  return Math.max(1, Math.min(count, columns));
}

function summarizeSnapshots(snapshots: readonly AgentSwarmSnapshot[]): AgentSwarmSummary {
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  for (const snapshot of snapshots) {
    if (snapshot.phase === 'completed') completed += 1;
    if (snapshot.phase === 'failed') failed += 1;
    if (snapshot.phase === 'cancelled') cancelled += 1;
  }
  return {
    active: snapshots.length - completed - failed - cancelled,
    completed,
    failed,
    cancelled,
  };
}

function brailleBar(
  ticks: number,
  phase: AgentSwarmPhase,
  width: number,
  colors: ColorPalette,
  frame: number,
  memberIndex: number,
  phaseElapsedMs: number,
): string {
  const innerWidth = Math.max(1, width);
  switch (phase) {
    case 'pending':
      return '';
    case 'spawning':
      return bracketBar(spawningBrailleBar(innerWidth, frame, memberIndex, colors), colors);
    case 'working':
      return bracketBar(accumulatedBrailleBar(ticks, innerWidth, colors.success, colors), colors);
    case 'completed':
      return bracketBar(
        accumulatedBrailleBar(
          completedDisplayTicks(ticks, innerWidth, phaseElapsedMs),
          innerWidth,
          colors.success,
          colors,
        ),
        colors,
      );
    case 'failed':
      return bracketBar(failedBrailleBar(ticks, innerWidth, phaseElapsedMs, colors), colors);
    case 'cancelled':
      return bracketBar(accumulatedBrailleBar(ticks, innerWidth, colors.warning, colors), colors);
  }
}

function bracketBar(content: string, colors: ColorPalette): string {
  const bracket = chalk.hex(colors.textMuted);
  return bracket('[') + content + bracket(']');
}

function phaseColor(phase: AgentSwarmPhase, colors: ColorPalette): string {
  switch (phase) {
    case 'pending':
      return colors.textDim;
    case 'spawning':
      return colors.textDim;
    case 'working':
      return colors.primary;
    case 'completed':
      return colors.success;
    case 'failed':
      return colors.error;
    case 'cancelled':
      return colors.warning;
  }
}

function renderCellLabel(
  snapshot: AgentSwarmSnapshot,
  width: number,
  colors: ColorPalette,
): string {
  const latestLine = latestNonEmptyLine(snapshot.latestModelText);
  if (snapshot.phase === 'working' && latestLine.length > 0) {
    return truncateWithColor(latestLine, width, colors.textDim);
  }
  return truncateWithColor(PHASE_LABELS[snapshot.phase], width, phaseColor(snapshot.phase, colors));
}

function renderPendingCell(
  member: AgentSwarmMember,
  width: number,
  colors: ColorPalette,
): string {
  const id = chalk.hex(colors.textDim)(member.id);
  const prefix = `${id} `;
  const itemText = collapseWhitespace(member.itemText);
  const label = itemText.length > 0 ? itemText : SPAWNING_LABEL;
  const labelWidth = Math.max(1, width - visibleWidth(prefix));
  return prefix + truncateWithColor(label, labelWidth, colors.textDim);
}

function truncateWithColor(text: string, width: number, color: string): string {
  const colorize = chalk.hex(color);
  return truncateToWidth(colorize(text), width, colorize('…'));
}

function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function latestNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = collapseWhitespace(lines[index] ?? '');
    if (line.length > 0) return line;
  }
  return '';
}

function parsePartialJsonString(
  text: string,
  startIndex: number,
): { value: string; closed: boolean; nextIndex: number } {
  let value = '';
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') return { value, closed: true, nextIndex: i };
    if (ch !== '\\') {
      value += ch;
      continue;
    }

    const escaped = text[i + 1];
    if (escaped === undefined) return { value, closed: false, nextIndex: i };
    switch (escaped) {
      case 'n':
        value += '\n';
        i += 1;
        break;
      case 't':
        value += '\t';
        i += 1;
        break;
      case 'r':
        value += '\r';
        i += 1;
        break;
      case 'b':
        value += '\b';
        i += 1;
        break;
      case 'f':
        value += '\f';
        i += 1;
        break;
      case '"':
      case '\\':
      case '/':
        value += escaped;
        i += 1;
        break;
      case 'u': {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length < 4) return { value, closed: false, nextIndex: i };
        const code = Number.parseInt(hex, 16);
        if (Number.isNaN(code)) return { value, closed: false, nextIndex: i };
        value += String.fromCodePoint(code);
        i += 5;
        break;
      }
      default:
        value += escaped;
        i += 1;
    }
  }
  return { value, closed: false, nextIndex: text.length };
}

function padAnsi(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return truncated + ' '.repeat(Math.max(0, width - visibleWidth(truncated)));
}

function spawningBrailleBar(
  width: number,
  frame: number,
  memberIndex: number,
  colors: ColorPalette,
): string {
  if (width <= 1) {
    return chalk.hex(colors.textMuted)(BRAILLE_SPAWNING_RIGHT);
  }
  let out = '';
  const maxPosition = width - 1;
  const period = maxPosition * 2;
  const phaseOffset = Math.floor(memberIndex / SPAWNING_PHASE_GROUP_SIZE);
  const position = (frame + phaseOffset) % period;
  const movingRight = position <= maxPosition;
  const cursorCell = movingRight ? position : period - position;
  const cursorChar = movingRight ? BRAILLE_SPAWNING_RIGHT : BRAILLE_SPAWNING_LEFT;
  for (let i = 0; i < width; i += 1) {
    out += chalk.hex(i === cursorCell ? colors.textMuted : colors.textDim)(
      i === cursorCell ? cursorChar : BRAILLE_EMPTY,
    );
  }
  return out;
}

function completedDisplayTicks(ticks: number, width: number, phaseElapsedMs: number): number {
  const fullBarTicks = width * BRAILLE_LEVELS.length;
  if (ticks >= fullBarTicks) return fullBarTicks;
  const fillProgress = Math.max(0, Math.min(1, phaseElapsedMs / COMPLETE_FILL_MS));
  return Math.min(fullBarTicks, Math.ceil(ticks + (fullBarTicks - ticks) * fillProgress));
}

function failedBrailleBar(
  ticks: number,
  width: number,
  phaseElapsedMs: number,
  colors: ColorPalette,
): string {
  const redCellCount = Math.ceil(
    completedDisplayTicks(ticks, width, phaseElapsedMs) / BRAILLE_LEVELS.length,
  );
  const placeholderColor = darkenRedHexColor(colors.error);
  return accumulatedBrailleBar(
    ticks,
    width,
    colors.error,
    colors,
    (cellIndex) => cellIndex < redCellCount ? placeholderColor : colors.textDim,
  );
}

function darkenRedHexColor(hex: string): string {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (match === null) return hex;
  const [, red = '00', green = '00', blue = '00'] = match;
  const darken = (channel: string, factor: number): string => {
    const value = Math.max(0, Math.min(255, Math.round(Number.parseInt(channel, 16) * factor)));
    return value.toString(16).padStart(2, '0');
  };
  return `#${darken(red, FAILED_PLACEHOLDER_RED_FACTOR)}${darken(
    green,
    FAILED_PLACEHOLDER_NON_RED_FACTOR,
  )}${darken(blue, FAILED_PLACEHOLDER_NON_RED_FACTOR)}`;
}

function accumulatedBrailleBar(
  ticks: number,
  width: number,
  filledColor: string,
  colors: ColorPalette,
  emptyColorForCell?: (cellIndex: number) => string,
): string {
  const dotsPerCell = BRAILLE_LEVELS.length;
  const cycleSize = width * dotsPerCell;
  const safeTicks = Math.max(0, ticks);
  const completedCycles = Math.floor(safeTicks / cycleSize);
  const cycleTicks = safeTicks % cycleSize;
  const activeCells = cycleTicks === 0 ? 0 : Math.ceil(cycleTicks / dotsPerCell);
  const separatorIndex = completedCycles > 0 && activeCells > 0 && activeCells < width
    ? activeCells
    : -1;

  let out = '';
  let pending = '';
  let pendingColor: string | undefined;
  const flush = (): void => {
    if (pending.length === 0 || pendingColor === undefined) return;
    out += chalk.hex(pendingColor)(pending);
    pending = '';
  };
  const append = (char: string, color: string): void => {
    if (pendingColor !== color) {
      flush();
      pendingColor = color;
    }
    pending += char;
  };

  for (let i = 0; i < width; i += 1) {
    if (i === separatorIndex) {
      append(BRAILLE_RIGHT_COLUMN_FULL, filledColor);
      continue;
    }

    const cellStart = i * dotsPerCell;
    const countThisCycle = Math.max(0, Math.min(dotsPerCell, cycleTicks - cellStart));
    const count = countThisCycle > 0 ? countThisCycle : completedCycles > 0 ? dotsPerCell : 0;
    append(
      count === 0 ? BRAILLE_EMPTY : BRAILLE_LEVELS[count - 1]!,
      count === 0 ? emptyColorForCell?.(i) ?? colors.textDim : filledColor,
    );
  }
  flush();
  return out;
}
