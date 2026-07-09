import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Comments explain the rules below and name the units they avoid, so they are stripped first. */
const css: string = readFileSync(resolve('src/popup/popup.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

function block(selector: string): string {
  const match: RegExpMatchArray | null = new RegExp(
    `(?:^|\\n)${selector.replace(/[.#]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(css);
  if (match?.[1] === undefined) throw new Error(`no ${selector} block in popup.css`);
  return match[1];
}

/**
 * Chrome measures the toolbar popup before its first layout. A maximum size in viewport units
 * reads that pre-layout viewport and clamps the popup, which the sizing e2e spec measures on the
 * real popup window. This pin keeps the rule readable without a browser.
 */
describe('popup.css sizing', (): void => {
  it('fixes the popup at 480 by 600 with no viewport-unit maximum', (): void => {
    const body: string = block('body');
    expect(body).toMatch(/width:\s*480px/);
    expect(body).toMatch(/max-inline-size:\s*100%/);
    expect(body).toMatch(/block-size:\s*600px/);
    expect(body).not.toMatch(/100vw|100vh/);

    // The block clamp stays in viewport units: it only bites in a short tab viewport, and the
    // body's fixed 600 px keeps the popup's intrinsic height independent of it.
    const app: string = block('.app');
    expect(app).toMatch(/max-inline-size:\s*100%/);
    expect(app).toMatch(/max-block-size:\s*100vh/);
    expect(app).not.toMatch(/100vw/);
  });

  it('lets the active view scroll inside the fixed popup height', (): void => {
    // The work tab picker and the return button push the spend and End controls past 600 px,
    // and the body clips its overflow, so the view itself has to be the scroll container.
    const view: string = block('.active-view');
    expect(view).toMatch(/overflow-y:\s*auto/);
    expect(view).toMatch(/min-block-size:\s*0/);
    expect(view).toMatch(/flex:\s*1 1 auto/);
  });
});
