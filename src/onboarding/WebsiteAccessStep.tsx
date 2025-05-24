import type { VNode } from 'preact';
import type { WebsiteAccessChoice } from '../shared/types';

export interface WebsiteAccessStepProps {
  choice: WebsiteAccessChoice;
  pending: boolean;
  error: string | null;
  onEnable: () => void | Promise<void>;
  onDefer: () => void | Promise<void>;
}

export function WebsiteAccessStep(props: WebsiteAccessStepProps): VNode {
  const denied: boolean = props.choice === 'denied';
  const registrationError: boolean = props.choice === 'registration-error';
  const retry: boolean = denied || registrationError;
  return (
    <section aria-labelledby="website-access-heading">
      <h1 id="website-access-heading" tabIndex={-1}>
        Enable website blocking
      </h1>
      <p>
        Focus Lock checks page addresses locally so it can match your selected categories and sites.
        It uses website access to show its blocking screen and restore affected pages when your
        session ends.
      </p>
      <p>
        Categories and custom domains can include any website. Chrome will therefore ask whether
        Focus Lock may read and change data on all websites. Focus Lock uses that access only while
        applying your blocking rules.
      </p>
      {denied ? <p role="status">Chrome did not grant website access. You can retry.</p> : null}
      {registrationError ? (
        <p role="status">
          Website access is granted, but Focus Lock could not enable blocking. Retry setup or reload
          the extension.
        </p>
      ) : null}
      {props.error !== null ? <p role="alert">{props.error}</p> : null}
      <div class="button-row">
        <button
          type="button"
          class="primary-button"
          disabled={props.pending}
          onClick={(): void => void props.onEnable()}
        >
          {retry ? 'Retry' : 'Enable website blocking'}
        </button>
        <button
          type="button"
          class="secondary-button"
          disabled={props.pending}
          onClick={(): void => void props.onDefer()}
        >
          Not now
        </button>
      </div>
    </section>
  );
}
