/**
 * The ports fake's own document model. Every runner suite reads its enforcement answers from here,
 * so the rule those answers follow is worth stating once, in one place, rather than being inferred
 * from whichever runner happens to exercise it.
 *
 * The rule is the one `src/content/enforcement-state.ts` implements: a document accepts an
 * enforcement command only for the epoch it currently holds, and it holds an epoch only after
 * answering that epoch's reset.
 */
import { describe, expect, it } from 'vitest';
import type {
  FrozenDocumentCommand,
  FrozenEpochResetCommand,
} from '../../../src/background/enforcement-persistence-v2';
import { buildFrozenEpochResetCommandV2 } from '../../../src/background/overlay-view-v2';
import type { RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import type { DocumentContentCommand } from '../../../src/shared/enforcement-v2';
import { createRuntimePortsFakeV2, type RuntimePortsFakeV2 } from './runtime-ports-fake';
import {
  activeCommand,
  documentKey,
  EPOCH_ID,
  emptyRuntimeV2,
  OTHER_EPOCH_ID,
  publishedFocusRuntime,
  REQUESTED_AT,
  STARTING_OPERATION_ID,
  TARGET_URL,
} from './runtime-v2-fixtures';

const TAB_ID: number = 11;
const DOCUMENT_ID: string = 'document-1';

/** The wire shape the transport sends, which is the frozen command without its owner's `tabId`. */
function wire(command: FrozenDocumentCommand | FrozenEpochResetCommand): DocumentContentCommand {
  const { tabId: _tabId, ...rest } = command;
  return rest as DocumentContentCommand;
}

function applyCommand(): DocumentContentCommand {
  return wire(activeCommand({ tabId: TAB_ID, documentId: DOCUMENT_ID }));
}

function resetCommand(epoch: string = EPOCH_ID): DocumentContentCommand {
  return wire(
    buildFrozenEpochResetCommandV2({
      tabId: TAB_ID,
      documentId: DOCUMENT_ID,
      expectedUrl: TARGET_URL,
      operationId: STARTING_OPERATION_ID,
      enforcementEpoch: epoch,
    }),
  );
}

function fakeFor(runtime: RuntimeStateV2 = emptyRuntimeV2({})): RuntimePortsFakeV2 {
  return createRuntimePortsFakeV2(runtime, { now: REQUESTED_AT });
}

async function send(
  fake: RuntimePortsFakeV2,
  command: DocumentContentCommand,
): Promise<Record<string, unknown>> {
  return (await fake.transport.sendToDocument(TAB_ID, DOCUMENT_ID, command)) as Record<
    string,
    unknown
  >;
}

describe('ports fake document model', (): void => {
  it('refuses an enforcement command for an epoch the document never accepted', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor();

    const answer: Record<string, unknown> = await send(fake, applyCommand());

    expect(answer.disposition).toBe('reset-required');
    expect(answer.currentEpoch).toBeNull();
    expect(answer.requestedEpoch).toBe(EPOCH_ID);
  });

  it('accepts an enforcement command once the document has answered that epoch reset', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor();

    const reset: Record<string, unknown> = await send(fake, resetCommand());
    const applied: Record<string, unknown> = await send(fake, applyCommand());

    expect(reset.disposition).toBe('epoch-reset');
    expect(applied.disposition).toBe('applied');
  });

  it('reports the epoch a document holds when it refuses a different one', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor();
    await send(fake, resetCommand(OTHER_EPOCH_ID));

    const answer: Record<string, unknown> = await send(fake, applyCommand());

    expect(answer.disposition).toBe('reset-required');
    expect(answer.currentEpoch).toBe(OTHER_EPOCH_ID);
  });

  it('starts a document in the epoch the seeded runtime records an acknowledgement for', async (): Promise<void> => {
    // The runtime's own ack record is its evidence that the handshake happened, so a scenario that
    // seeds one gets a document already in that epoch and needs no reset of its own.
    const acknowledged: RuntimeStateV2 = emptyRuntimeV2({
      epochResetAcks: {
        [documentKey(TAB_ID, DOCUMENT_ID)]: {
          version: 1,
          operationId: STARTING_OPERATION_ID,
          enforcementEpoch: EPOCH_ID,
          tabId: TAB_ID,
          documentId: DOCUMENT_ID,
          handledAt: REQUESTED_AT - 1_000,
        },
      },
    });
    const fake: RuntimePortsFakeV2 = fakeFor(acknowledged);

    const answer: Record<string, unknown> = await send(fake, applyCommand());

    expect(answer.disposition).toBe('applied');
  });

  it('lets a scenario put a document out of step with the record', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor();
    fake.setDocumentEpoch(TAB_ID, DOCUMENT_ID, OTHER_EPOCH_ID);

    const answer: Record<string, unknown> = await send(fake, applyCommand());

    expect(answer.disposition).toBe('reset-required');
    expect(answer.currentEpoch).toBe(OTHER_EPOCH_ID);
  });

  it('refuses a commit whose projection lowers a monotonic revision', async (): Promise<void> => {
    // The fake used to validate only the composed runtime, so a stale projection passed every
    // caller's tests and threw at the storage boundary in production. It now applies the same
    // three preconditions production does.
    const fake: RuntimePortsFakeV2 = fakeFor(emptyRuntimeV2({ runtimeRevision: 4 }));
    const projection: RuntimeStateV2 = emptyRuntimeV2({ runtimeRevision: 3 });

    await expect(
      fake.commit({
        checkpointId: `${EPOCH_ID}:live-3`,
        projection,
        bank: { balanceMs: 0 },
        events: [],
        syncBank: false,
        aggregateSets: {},
        aggregateRemoves: [],
      }),
    ).rejects.toThrow(/never lowers the monotonic runtime revision/);
    expect(fake.commits).toHaveLength(0);
    expect(fake.current().runtimeRevision).toBe(4);
  });

  it('keeps a scripted responder in charge of the document it answers for', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor();
    fake.respondForDocument(TAB_ID, DOCUMENT_ID, (): unknown => undefined);

    expect(await send(fake, applyCommand())).toBeUndefined();
  });

  // The three below are the same-epoch rules of `enforcement-state.ts`, which the fake used to skip:
  // it answered `applied` to every command at the epoch it held, so a command the real page refuses
  // passed every runner suite (docs/testing-rules.md, rule 3).
  it('refuses a command at the tuple it holds when the view differs', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor();
    await send(fake, resetCommand());
    const cleared: Record<string, unknown> = await send(fake, wire(clearAtActiveTuple()));

    const refused: unknown = await fake.transport.sendToDocument(
      TAB_ID,
      DOCUMENT_ID,
      applyCommand(),
    );

    expect(cleared.disposition).toBe('applied');
    expect(refused).toBeUndefined();
    expect(fake.rejectedAnswers(TAB_ID, DOCUMENT_ID)).toBe(1);
    expect(fake.documentState(TAB_ID, DOCUMENT_ID)?.presentation).toBe('clear');
  });

  it('accepts a command strictly above the tuple it holds', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor();
    await send(fake, resetCommand());
    await send(fake, wire(clearAtActiveTuple()));

    const applied: Record<string, unknown> = await send(
      fake,
      wire(activeCommand({ tabId: TAB_ID, documentId: DOCUMENT_ID, runtimeRevision: 2 })),
    );

    expect(applied.disposition).toBe('applied');
    expect(fake.documentState(TAB_ID, DOCUMENT_ID)?.presentation).toBe('active');
    expect(fake.documentState(TAB_ID, DOCUMENT_ID)?.tuple?.runtimeRevision).toBe(2);
    expect(fake.rejectedAnswers(TAB_ID, DOCUMENT_ID)).toBe(0);
  });

  it('starts a seeded document holding the view the runtime maps for it', async (): Promise<void> => {
    // A stored command with an acknowledgement is the runtime's evidence of what the page applied,
    // so the document starts on that view and refuses a different view at the same tuple, exactly
    // as the page it stands in for would.
    const fake: RuntimePortsFakeV2 = fakeFor(publishedFocusRuntime());
    const held: FrozenDocumentCommand | undefined =
      publishedFocusRuntime().documentCommands[documentKey(TAB_ID, DOCUMENT_ID)];
    if (held === undefined) throw new Error('the fixture maps no command for the document');

    expect(fake.documentState(TAB_ID, DOCUMENT_ID)?.presentation).toBe('active');
    expect(fake.documentState(TAB_ID, DOCUMENT_ID)?.tuple?.runtimeRevision).toBe(
      held.runtimeRevision,
    );
    expect((await send(fake, wire(held))).disposition).toBe('applied');
    // The canonical clear at the held tuple: a valid command the page refuses on its view alone.
    expect(
      await send(fake, wire({ ...clearAtActiveTuple(), runtimeRevision: held.runtimeRevision })),
    ).toBeUndefined();
  });

  it('applies a pulled array in order, the way the router hands it to the page', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor();

    fake.applyPulled(TAB_ID, DOCUMENT_ID, [resetCommand(), applyCommand()]);

    expect(fake.documentState(TAB_ID, DOCUMENT_ID)?.enforcementEpoch).toBe(EPOCH_ID);
    expect(fake.documentState(TAB_ID, DOCUMENT_ID)?.presentation).toBe('active');
    expect(fake.rejectedAnswers(TAB_ID, DOCUMENT_ID)).toBe(0);
  });
});

/** A clear at exactly the tuple `applyCommand` carries, so the two differ only in their view. */
function clearAtActiveTuple(): FrozenDocumentCommand {
  const active: FrozenDocumentCommand = activeCommand({ tabId: TAB_ID, documentId: DOCUMENT_ID });
  return {
    ...active,
    presentation: 'clear',
    verdict: { blocked: false, reason: 'no-session', categoryId: null, matchedPattern: null },
    overlay: null,
  };
}
