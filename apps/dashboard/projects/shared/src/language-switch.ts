import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";
import type { Locale } from "./format.ts";

/**
 * Two flag buttons: United States for English, Argentina for Spanish. The flags are drawn as
 * SVG because many desktop systems have no flag emoji.
 */
@Component({
  selector: "app-language-switch",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="switch" role="group" aria-label="Language / Idioma">
      <button
        type="button"
        class="flag"
        lang="en"
        aria-label="English"
        title="English"
        [attr.aria-pressed]="value() === 'en'"
        (click)="choose('en')"
      >
        <svg viewBox="0 0 28 20" width="28" height="20" aria-hidden="true">
          <rect width="28" height="20" fill="#fff" />
          <g fill="#b22234">
            <rect y="0" width="28" height="1.54" />
            <rect y="3.08" width="28" height="1.54" />
            <rect y="6.15" width="28" height="1.54" />
            <rect y="9.23" width="28" height="1.54" />
            <rect y="12.31" width="28" height="1.54" />
            <rect y="15.38" width="28" height="1.54" />
            <rect y="18.46" width="28" height="1.54" />
          </g>
          <rect width="12" height="10.77" fill="#3c3b6e" />
        </svg>
      </button>
      <button
        type="button"
        class="flag"
        lang="es"
        aria-label="Español"
        title="Español"
        [attr.aria-pressed]="value() === 'es'"
        (click)="choose('es')"
      >
        <svg viewBox="0 0 28 20" width="28" height="20" aria-hidden="true">
          <rect width="28" height="20" fill="#74acdf" />
          <rect y="6.67" width="28" height="6.66" fill="#fff" />
          <circle cx="14" cy="10" r="1.9" fill="#f6b40e" />
        </svg>
      </button>
    </div>
  `,
  styles: `
    .switch { display: inline-flex; gap: 0.375rem; }
    .flag {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 0.25rem 0.375rem; min-height: 2.5rem; min-width: 2.75rem;
      border-radius: 0.625rem; border: 1px solid transparent; background: transparent;
      cursor: pointer; opacity: 0.5; transition: opacity 0.15s, background-color 0.15s;
    }
    .flag:hover { opacity: 0.85; }
    .flag svg { border-radius: 3px; box-shadow: 0 0 0 1px rgb(0 0 0 / 0.15); }
    .flag[aria-pressed="true"] {
      opacity: 1;
      background: color-mix(in srgb, currentColor 8%, transparent);
      border-color: color-mix(in srgb, currentColor 18%, transparent);
    }
    .flag:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
  `,
})
export class LanguageSwitch {
  readonly value = input.required<Locale>();
  readonly changed = output<Locale>();

  protected choose(locale: Locale): void {
    this.changed.emit(locale);
  }
}
