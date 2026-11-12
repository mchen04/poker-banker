import { withShutdownDeadline } from '../scripts/owned-process';

export async function cleanupLeaves(...actions: (() => unknown | Promise<unknown>)[]): Promise<void> {
  const results = await Promise.allSettled(actions.map(action => withShutdownDeadline('Test resource cleanup', action)));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
  if (errors.length) throw new AggregateError(errors, 'Test cleanup failed');
}
