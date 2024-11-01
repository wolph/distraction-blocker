/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RulesEditor } from '../../../src/options/RulesEditor';
import type { Rule } from '../../../src/shared/types';

vi.mock('../../../src/core/matcher', () => ({
  // Mirrors the real validator's contract: null when valid, message when not.
  // The real implementation lands in plan 02, so tests run against this fake.
  validateRule: (rule: Rule): string | null => {
    if (rule.pattern.trim() === '') return 'pattern is empty';
    if (rule.kind === 'regex') {
      try {
        new RegExp(rule.pattern);
      } catch {
        return 'invalid regular expression';
      }
    }
    return null;
  },
}));

afterEach((): void => {
  cleanup();
});

describe('RulesEditor', () => {
  it('adds a valid host rule through onChange', (): void => {
    const onChange = vi.fn();
    const { getByLabelText, getByRole } = render(
      <RulesEditor title="Custom blacklist" rules={[]} onChange={onChange} />,
    );
    fireEvent.input(getByLabelText('Pattern'), { target: { value: 'nu.nl' } });
    fireEvent.click(getByRole('button', { name: 'Add rule' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([{ kind: 'host', pattern: 'nu.nl' }]);
  });

  it('shows the validation message inline for a bad regex and never calls onChange', (): void => {
    const onChange = vi.fn();
    const { getByLabelText, getByRole, getByText } = render(
      <RulesEditor title="Custom blacklist" rules={[]} onChange={onChange} />,
    );
    fireEvent.change(getByLabelText('Rule kind'), { target: { value: 'regex' } });
    fireEvent.input(getByLabelText('Pattern'), { target: { value: '(' } });
    fireEvent.click(getByRole('button', { name: 'Add rule' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(getByText('invalid regular expression')).toBeTruthy();
  });

  it('strips slash delimiters on input and stores the bare regex source', (): void => {
    const onChange = vi.fn();
    const { getByLabelText, getByRole } = render(
      <RulesEditor title="Custom blacklist" rules={[]} onChange={onChange} />,
    );
    fireEvent.change(getByLabelText('Rule kind'), { target: { value: 'regex' } });
    fireEvent.input(getByLabelText('Pattern'), {
      target: { value: '/youtube\\.com\\/shorts/' },
    });
    fireEvent.click(getByRole('button', { name: 'Add rule' }));
    expect(onChange).toHaveBeenCalledWith([{ kind: 'regex', pattern: 'youtube\\.com\\/shorts' }]);
  });

  it('displays regex rules slash-delimited and removes rules', (): void => {
    const rules: Rule[] = [
      { kind: 'host', pattern: 'facebook.com' },
      { kind: 'regex', pattern: 'youtube\\.com\\/shorts' },
    ];
    const onChange = vi.fn();
    const { getByText, getByRole } = render(
      <RulesEditor title="Custom blacklist" rules={rules} onChange={onChange} />,
    );
    expect(getByText('/youtube\\.com\\/shorts/')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Remove facebook.com' }));
    expect(onChange).toHaveBeenCalledWith([{ kind: 'regex', pattern: 'youtube\\.com\\/shorts' }]);
  });
});
