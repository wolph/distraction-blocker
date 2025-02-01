import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import { validateRule } from '../core/matcher';
import type { Rule, RuleKind } from '../shared/types';

export interface RulesEditorProps {
  title: string;
  rules: Rule[];
  onChange: (next: Rule[]) => void;
}

const KIND_LABELS: Record<RuleKind, string> = {
  host: 'domain',
  regex: 'regex',
};

function displayPattern(rule: Rule): string {
  return rule.kind === 'regex' ? `/${rule.pattern}/` : rule.pattern;
}

/** `/foo/` typed in the UI becomes the bare source `foo` in storage. */
function stripSlashes(raw: string): string {
  if (raw.length > 1 && raw.startsWith('/') && raw.endsWith('/')) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Table of rules plus an add row. Used twice: custom blacklist and
 * whitelist. Invalid input renders the validator's message inline and
 * never reaches onChange, so the worker only ever sees valid rules.
 */
export function RulesEditor(props: RulesEditorProps): VNode {
  const [kind, setKind]: [RuleKind, Dispatch<StateUpdater<RuleKind>>] = useState<RuleKind>('host');
  const [pattern, setPattern]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);

  const add: () => void = (): void => {
    const raw: string = pattern.trim();
    const source: string = kind === 'regex' ? stripSlashes(raw) : raw;
    const rule: Rule = { kind, pattern: source };
    const message: string | null = validateRule(rule);
    if (message !== null) {
      setError(message);
      return;
    }
    setError(null);
    setPattern('');
    props.onChange([...props.rules, rule]);
  };

  const remove: (index: number) => void = (index: number): void => {
    props.onChange(props.rules.filter((_: Rule, i: number): boolean => i !== index));
  };

  return (
    <div class="rules-editor">
      <h3>{props.title}</h3>
      {props.rules.length > 0 ? (
        <table class="rules">
          <tbody>
            {props.rules.map(
              (rule: Rule, index: number): VNode => (
                <tr key={`${rule.kind}:${rule.pattern}`}>
                  <td>
                    <span class="kind-badge">{KIND_LABELS[rule.kind]}</span>
                  </td>
                  <td class="mono">{displayPattern(rule)}</td>
                  <td>
                    <button
                      type="button"
                      class="ghost"
                      aria-label={`Remove ${displayPattern(rule)}`}
                      onClick={(): void => {
                        remove(index);
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      ) : (
        <p class="help">No rules yet.</p>
      )}
      <div class="add-row">
        <select
          aria-label="Rule kind"
          value={kind}
          onChange={(event: Event): void => {
            setKind((event.currentTarget as HTMLSelectElement).value as RuleKind);
          }}
        >
          <option value="host">domain or subdomain</option>
          <option value="regex">regex (full URL)</option>
        </select>
        <input
          type="text"
          aria-label="Pattern"
          placeholder={kind === 'host' ? 'facebook.com' : '/youtube\\.com\\/shorts/'}
          value={pattern}
          onInput={(event: Event): void => {
            setPattern((event.currentTarget as HTMLInputElement).value);
          }}
        />
        <button type="button" class="secondary" onClick={add}>
          Add rule
        </button>
      </div>
      {error !== null ? (
        <p class="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <p class="help">
        facebook.com covers that domain and every subdomain. news.ycombinator.com covers that
        subdomain and anything under it. /youtube\.com\/shorts/ matches the full URL as a regular
        expression.
      </p>
    </div>
  );
}
