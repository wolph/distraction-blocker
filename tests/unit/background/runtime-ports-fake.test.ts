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
          url: TARGET_URL,
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
});
