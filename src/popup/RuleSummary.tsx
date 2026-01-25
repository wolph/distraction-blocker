import type { VNode } from 'preact';
import { ALL_CATEGORIES } from '../core/categories';
import { hostRuleCoversHost } from '../core/matcher';
import { HelpPopover } from '../shared/HelpPopover';
import type {
  CategoryId,
  CategoryList,
  Rule,
  SessionMode,
  SessionRuleSnapshot,
} from '../shared/types';

/**
 * The two fields this summary reads. Narrower than any caller's draft on purpose, so a
 * caller never has to fabricate a duration or a session type it does not have.
 */
export interface RuleSummaryDraft {
  mode: SessionMode;
  rules: SessionRuleSnapshot;
}

export interface RuleSummaryProps {
  draft: RuleSummaryDraft;
  categoriesEditable: boolean;
  onCategoryToggle: (id: CategoryId) => void;
  onOpenSettings: () => void;
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}

function RuleDetail({
  kind,
  pattern,
}: {
  kind: 'domain' | 'regular expression';
  pattern: string;
}): VNode {
  return (
    <HelpPopover
      label={`Show full ${kind}: ${pattern}`}
      triggerClassName="rule-detail"
      triggerContent={<span class="rule-value">{pattern}</span>}
    >
      <span class="rule-detail__full">{pattern}</span>
    </HelpPopover>
  );
}

function RuleValue({ rule }: { rule: Rule }): VNode {
  const kind: 'domain' | 'regular expression' =
    rule.kind === 'regex' ? 'regular expression' : 'domain';
  return (
    <li class="rule-item">
      <span class="rule-kind">{rule.kind === 'regex' ? 'Regular expression' : 'Domain'}</span>
      <RuleDetail kind={kind} pattern={rule.pattern} />
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

function customHostRuleOverridesException(host: string, rules: Rule[]): boolean {
  return rules.some((rule: Rule): boolean => hostRuleCoversHost(rule, host));
}

function BlockRules({ draft, categoriesEditable, onCategoryToggle }: RuleSummaryProps): VNode {
  const extraRules: Rule[] = [...draft.rules.permanentBlacklist, ...draft.rules.sessionBlacklist];
  const exclusionRows: Array<{ category: CategoryList; host: string }> = ALL_CATEGORIES.flatMap(
    (category: CategoryList): Array<{ category: CategoryList; host: string }> =>
      draft.rules.categories[category.id]
        ? (draft.rules.exclusions[category.id] ?? [])
            .filter((host: string): boolean => !customHostRuleOverridesException(host, extraRules))
            .map((host: string): { category: CategoryList; host: string } => ({ category, host }))
        : [],
  );

  return (
    <div class="rule-sections">
      <section class="rule-section" aria-labelledby="draft-categories-heading">
        <h3 id="draft-categories-heading">Blocked categories</h3>
        <div class="draft-categories">
          {ALL_CATEGORIES.map((category: CategoryList): VNode => {
            const enabled: boolean = draft.rules.categories[category.id];
            const exclusions: ReadonlySet<string> = new Set(
              (draft.rules.exclusions[category.id] ?? []).filter(
                (host: string): boolean => !customHostRuleOverridesException(host, extraRules),
              ),
            );
            const effectiveHosts: string[] = category.hosts.filter(
              (host: string): boolean => !exclusions.has(host),
            );
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
                    {effectiveHosts.length} {plural(effectiveHosts.length, 'site', 'sites')}
                  </span>
                </button>
                {enabled ? (
                  <ul class="rule-membership" aria-label={`${category.title} sites`}>
                    {effectiveHosts.map(
                      (host: string): VNode => (
                        <li key={host}>
                          <RuleDetail kind="domain" pattern={host} />
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
                  <RuleDetail kind="domain" pattern={host} />
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
        <div class="rule-summary__scope">
          <span>
            {props.draft.mode === 'whitelist'
              ? 'Allowed-site and rule changes here apply only to this session. Everything else is blocked.'
              : 'Category and rule changes here apply only to this session.'}
          </span>
          <button type="button" onClick={props.onOpenSettings}>
            Open Settings for permanent defaults
          </button>
        </div>
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
