/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseSettingsSectionHash,
  SETTINGS_SECTIONS,
  SettingsNav,
} from '../../../src/shared/SettingsNav';

afterEach((): void => cleanup());

describe('settings navigation', (): void => {
  it('bounds and right-aligns theme errors inside the responsive navigation', (): void => {
    const css: string = readFileSync(resolve('src/shared/settings-nav.css'), 'utf8');
    expect(css).toMatch(/\.settings-nav \.theme-error\s*\{[^}]*right:\s*0/s);
    expect(css).toMatch(/\.settings-nav \.theme-error\s*\{[^}]*max-width:/s);
    expect(css).toMatch(/\.settings-nav \.theme-error\s*\{[^}]*white-space:\s*normal/s);
  });

  it('parses known hashes and falls back to Lists', (): void => {
    expect(parseSettingsSectionHash('#schedule')).toBe('schedule');
    expect(parseSettingsSectionHash('#categories')).toBe('lists');
    expect(parseSettingsSectionHash('#not-a-section')).toBe('lists');
    expect(parseSettingsSectionHash('')).toBe('lists');
  });

  it('renders Stats and all six Options links on Options', (): void => {
    const { getAllByRole, getByRole } = render(
      <SettingsNav page="options" section="lists" theme="auto" onThemeChange={async () => null} />,
    );
    expect(SETTINGS_SECTIONS).toHaveLength(6);
    expect(getAllByRole('link')).toHaveLength(7);
    expect(getByRole('link', { name: 'Stats' }).getAttribute('href')).toBe('../stats/stats.html');
    expect(getByRole('link', { name: 'Lists and categories' }).getAttribute('href')).toBe('#lists');
    expect(getByRole('link', { name: 'Lists and categories' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('renders exact Options hashes and marks Stats current on Stats', (): void => {
    const { getByRole } = render(
      <SettingsNav page="stats" theme="dark" onThemeChange={async () => null} />,
    );
    expect(getByRole('link', { name: 'Stats' }).getAttribute('aria-current')).toBe('page');
    for (const section of SETTINGS_SECTIONS) {
      expect(getByRole('link', { name: section.label }).getAttribute('href')).toBe(
        `../options/options.html#${section.id}`,
      );
    }
  });
});
