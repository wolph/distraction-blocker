import type { VNode } from 'preact';
import { ALL_CATEGORIES } from '../core/categories';
import type { CategoryId, CategoryList, Rule } from '../shared/types';
import type { SessionDraft } from './session-draft';

export interface RuleSummaryProps {
  draft: SessionDraft;
  categoriesEditable: boolean;
  onCategoryToggle: (id: CategoryId) => void;
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}

function RuleValue({ rule }: { rule: Rule }): VNode {
  return (
    <li class="rule-item">
      <span class="rule-kind">{rule.kind === 'regex' ? 'Regular expression' : 'Domain'}</span>
      <span class="rule-value" title={rule.pattern}>
        {rule.pattern}
      </span>
    </li>
  );
}

function scrollRuleList(event: KeyboardEvent): void {
  const region: HTMLElement = event.currentTarget as HTMLElement;
  let delta: number = 0;
  if (event.key === 'ArrowDown') delta = 40;
  else if (event.key === 'ArrowUp') delta = -40;
  else if (event.key === 'PageDown') delta = region.clientHeight;
  else if (event.key === 'PageUp') delta = -region.clientHeight;
  else return;
  event.preventDefault();
  region.scrollTop += delta;
}

function BlockRules({ draft, categoriesEditable, onCategoryToggle }: RuleSummaryProps): VNode {
  const extraRules: Rule[] = [...draft.rules.permanentBlacklist, ...draft.rules.sessionBlacklist];
  const exclusionRows: Array<{ category: CategoryList; host: string }> = ALL_CATEGORIES.flatMap(
    (category: CategoryList): Array<{ category: CategoryList; host: string }> =>
      (draft.rules.exclusions[category.id] ?? []).map(
        (host: string): { category: CategoryList; host: string } => ({ category, host }),
      ),
  );

  return (
    <div class="rule-sections">
      <section class="rule-section" aria-labelledby="draft-categories-heading">
        <h3 id="draft-categories-heading">Blocked categories</h3>
        <div class="draft-categories">
          {ALL_CATEGORIES.map((category: CategoryList): VNode => {
            const enabled: boolean = draft.rules.categories[category.id];
            return (
              <section class="draft-category" key={category.id}>
                <button
                  type="button"
                  class={enabled ? 'draft-category__toggle is-selected' : 'draft-category__toggle'}
                  aria-label={category.title}
                  aria-pressed={enabled}
                  disabled={!categoriesEditable}
                  onClick={(): void => onCategoryToggle(category.id)}
                >
                  <span>{category.title}</span>
                  <span class="draft-category__count" aria-hidden="true">
                    {category.hosts.length} {plural(category.hosts.length, 'site', 'sites')}
                  </span>
                </button>
                {enabled ? (
                  <ul class="rule-membership" aria-label={`${category.title} sites`}>
                    {category.hosts.map(
                      (host: string): VNode => (
                        <li key={host} class="rule-value" title={host} aria-label={host}>
                          {host}
                        </li>
                      ),
                    )}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>
      </section>

      {exclusionRows.length > 0 ? (
        <section class="rule-section" aria-labelledby="draft-exclusions-heading">
          <h3 id="draft-exclusions-heading">Allowed exceptions</h3>
          <ul class="rule-list">
            {exclusionRows.map(
              ({ category, host }: { category: CategoryList; host: string }): VNode => (
                <li class="rule-item" key={`${category.id}:${host}`}>
                  <span class="rule-kind">{category.title}</span>
                  <span class="rule-value" title={host}>
                    {host}
                  </span>
                </li>
              ),
            )}
          </ul>
        </section>
      ) : null}

      <section class="rule-section" aria-labelledby="draft-extra-blocked-heading">
        <h3 id="draft-extra-blocked-heading">Extra blocked rules</h3>
        {extraRules.length === 0 ? (
          <p class="rule-empty">No extra blocked rules.</p>
        ) : (
          <ul class="rule-list">
            {extraRules.map(
              (rule: Rule, index: number): VNode => (
                <RuleValue key={`${rule.kind}:${rule.pattern}:${index}`} rule={rule} />
              ),
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

function AllowRules({ draft }: Pick<RuleSummaryProps, 'draft'>): VNode {
  const allowedRules: Rule[] = [...draft.rules.permanentAllowlist, ...draft.rules.sessionAllowlist];
  return (
    <section class="rule-section" aria-labelledby="draft-allowed-heading">
      <h3 id="draft-allowed-heading">Allowed sites and rules</h3>
      {allowedRules.length === 0 ? (
        <p class="rule-empty">No sites are allowed yet.</p>
      ) : (
        <ul class="rule-list">
          {allowedRules.map(
            (rule: Rule, index: number): VNode => (
              <RuleValue key={`${rule.kind}:${rule.pattern}:${index}`} rule={rule} />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

export function RuleSummary(props: RuleSummaryProps): VNode {
  const enabledCount: number = ALL_CATEGORIES.filter(
    (category: CategoryList): boolean => props.draft.rules.categories[category.id],
  ).length;
  const extraBlockedCount: number =
    props.draft.rules.permanentBlacklist.length + props.draft.rules.sessionBlacklist.length;
  const allowedCount: number =
    props.draft.rules.permanentAllowlist.length + props.draft.rules.sessionAllowlist.length;

  return (
    <section class="rule-summary" aria-labelledby="rule-summary-heading">
      <div class="rule-summary__heading">
        <h2 id="rule-summary-heading">
          {props.draft.mode === 'blacklist' ? 'What will be blocked' : 'What will be allowed'}
        </h2>
        {props.draft.mode === 'blacklist' ? (
          <p>
            <span>
              {enabledCount} of {ALL_CATEGORIES.length} categories selected
            </span>
            <span>
              {extraBlockedCount} extra blocked {plural(extraBlockedCount, 'rule', 'rules')}
            </span>
          </p>
        ) : (
          <p>
            {allowedCount} allowed {plural(allowedCount, 'rule', 'rules')}
          </p>
        )}
      </div>
      <section
        class="rule-summary__scroll"
        aria-label="Session rule details"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll region must receive keyboard scroll commands.
        tabIndex={0}
        onKeyDown={scrollRuleList}
      >
        {props.draft.mode === 'blacklist' ? (
          <BlockRules {...props} />
        ) : (
          <AllowRules draft={props.draft} />
        )}
      </section>
    </section>
  );
}
