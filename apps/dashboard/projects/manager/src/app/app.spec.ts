import { TestBed } from "@angular/core/testing";
import { App } from "./app";

describe("App", () => {
  it("renders the title", async () => {
    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector("h1")?.textContent).toContain(
      "AgriFlow Manager",
    );
  });
});
