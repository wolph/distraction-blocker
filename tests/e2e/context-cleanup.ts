export interface ClosableContext {
  close(): Promise<void>;
}

export async function closeContextOnSetupFailure<T>(
  context: ClosableContext,
  setup: () => Promise<T>,
): Promise<T> {
  try {
    return await setup();
  } catch (setupError: unknown) {
    try {
      await context.close();
    } catch (closeError: unknown) {
      throw new AggregateError(
        [setupError, closeError],
        'extension setup and context cleanup failed',
        { cause: setupError },
      );
    }
    throw setupError;
  }
}
