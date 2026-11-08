import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

export interface Bar {
  readonly label: string;
  readonly value: number;
}

const W = 720;
const H = 220;
const PAD = { top: 12, right: 8, bottom: 28, left: 48 };

/** A round upper bound for the axis, for example 183 becomes 200. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const unit = value / exp;
  const step = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return step * exp;
}

/** Vertical bars with a labelled value axis. Drawn as SVG; no chart library. */
@Component({
  selector: "app-bar-chart",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.viewBox]="'0 0 ' + width + ' ' + height" role="img" [attr.aria-label]="summary()">
      @for (tick of ticks(); track tick.y) {
        <line class="grid" [attr.x1]="left" [attr.x2]="width - right" [attr.y1]="tick.y" [attr.y2]="tick.y" />
        <text class="axis" [attr.x]="left - 6" [attr.y]="tick.y + 4" text-anchor="end">{{ tick.text }}</text>
      }
      @for (bar of shaped(); track bar.label) {
        <rect class="bar" [attr.x]="bar.x" [attr.y]="bar.y" [attr.width]="bar.w" [attr.height]="bar.h" rx="2">
          <title>{{ bar.label }}: {{ bar.valueText }}</title>
        </rect>
      }
      @for (mark of marks(); track mark.x) {
        <text class="axis" [attr.x]="mark.x" [attr.y]="height - 8" [attr.text-anchor]="mark.anchor">{{ mark.text }}</text>
      }
    </svg>
  `,
  styles: `
    :host { display: block; }
    svg { width: 100%; height: auto; display: block; }
    .grid { stroke: var(--grid); stroke-width: 1; }
    .axis { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .bar { fill: var(--accent); }
    .bar:hover { fill: var(--accent-strong); }
  `,
})
export class BarChart {
  readonly bars = input.required<readonly Bar[]>();
  /** Formats a value for the axis and the tooltips. */
  readonly format = input<(value: number) => string>((v) => String(v));
  readonly summary = input("");

  protected readonly width = W;
  protected readonly height = H;
  protected readonly left = PAD.left;
  protected readonly right = PAD.right;

  private readonly max = computed(() => niceMax(Math.max(0, ...this.bars().map((b) => b.value))));

  protected readonly ticks = computed(() => {
    const max = this.max();
    const inner = H - PAD.top - PAD.bottom;
    return [0, 0.5, 1].map((f) => ({
      y: PAD.top + inner * (1 - f),
      text: this.format()(max * f),
    }));
  });

  protected readonly shaped = computed(() => {
    const bars = this.bars();
    const max = this.max();
    const inner = H - PAD.top - PAD.bottom;
    const slot = (W - PAD.left - PAD.right) / Math.max(1, bars.length);
    const w = Math.max(2, slot * 0.7);
    return bars.map((b, i) => {
      const h = (b.value / max) * inner;
      return {
        label: b.label,
        valueText: this.format()(b.value),
        x: PAD.left + slot * i + (slot - w) / 2,
        y: PAD.top + inner - h,
        w,
        h,
      };
    });
  });

  /** First and last label, so the time span is readable without crowding the axis. */
  protected readonly marks = computed(() => {
    const bars = this.bars();
    const first = bars[0];
    const last = bars.at(-1);
    if (first === undefined || last === undefined) return [];
    const out = [{ x: PAD.left, text: first.label, anchor: "start" }];
    if (bars.length > 1) out.push({ x: W - PAD.right, text: last.label, anchor: "end" });
    return out;
  });
}
