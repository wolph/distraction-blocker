export interface ClosableContext {
  close(): Promise<void>;
}

export async function closeContextOnSetupFailure<T>(
  context: ClosableContext,
  setup: () => Promise<T>,
): Promise<T> {
  try {
    return await setup();
  } catch (error: unknown) {
    await context.close();
    throw error;
  }
}
