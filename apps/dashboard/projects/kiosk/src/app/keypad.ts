import { ChangeDetectionStrategy, Component, input, model, output } from "@angular/core";

const ROWS: readonly (readonly string[])[] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
  ["K", "L", "M", "N", "O", "P", "Q", "R", "S", "T"],
  ["U", "V", "W", "X", "Y", "Z", "-"],
];

/** The longest equipment number the system accepts. */
const MAX_LENGTH = 16;

/** On-screen keys for the equipment number. Large targets so it works with work gloves. */
@Component({
  selector: "app-keypad",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="display" aria-live="polite" data-testid="equipment-display">
      @if (value() === "") {
        <span class="placeholder">{{ hint() }}</span>
      } @else {
        {{ value() }}
      }
    </div>
    <div class="keys" role="group" [attr.aria-label]="hint()">
      @for (row of rows; track $index) {
        <div class="row">
          @for (key of row; track key) {
            <button type="button" class="key" (click)="press(key)">{{ key }}</button>
          }
        </div>
      }
      <div class="row actions">
        <button type="button" class="key wide" [disabled]="value() === ''" (click)="erase()">
          {{ eraseLabel() }}
        </button>
        <button
          type="button"
          class="key wide confirm"
          [disabled]="value() === ''"
          (click)="submit.emit(value())"
        >
          {{ confirmLabel() }}
        </button>
      </div>
    </div>
  `,
  styles: `
    :host { display: block; }
    .display {
      min-height: 5.5rem; display: flex; align-items: center; justify-content: center;
      font-size: 3.5rem; font-weight: 700; letter-spacing: 0.08em;
      font-variant-numeric: tabular-nums; border: 3px solid var(--border);
      border-radius: 1rem; background: var(--surface); margin-bottom: 1rem;
    }
    .placeholder { font-size: 1.5rem; font-weight: 500; letter-spacing: 0; color: var(--muted); }
    .keys { display: grid; gap: 0.5rem; }
    .row { display: flex; gap: 0.5rem; justify-content: center; }
    .key {
      flex: 1 1 0; max-width: 6.5rem; min-height: 4.5rem; font: inherit; font-size: 1.75rem;
      font-weight: 600; border-radius: 0.75rem; border: 2px solid var(--border);
      background: var(--surface); color: var(--text); cursor: pointer;
    }
    .key:focus-visible { outline: 4px solid var(--text); outline-offset: 3px; }
    .key:active { background: var(--border); }
    .key:disabled { opacity: 0.4; cursor: default; }
    .key.wide { max-width: none; font-size: 1.5rem; }
    .key.confirm { background: var(--go); border-color: var(--go); color: var(--on-go); }
    .key.confirm:disabled { background: var(--surface); color: var(--text); border-color: var(--border); }
    .actions { margin-top: 0.5rem; }
  `,
})
export class Keypad {
  readonly value = model("");
  readonly hint = input("");
  readonly eraseLabel = input("Borrar");
  readonly confirmLabel = input("Aceptar");
  readonly submit = output<string>();
  protected readonly rows = ROWS;

  protected press(key: string): void {
    if (this.value().length < MAX_LENGTH) this.value.update((v) => v + key);
  }

  protected erase(): void {
    this.value.update((v) => v.slice(0, -1));
  }
}
