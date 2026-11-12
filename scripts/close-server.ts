import { withShutdownDeadline } from './owned-process';

type OwnedServer = {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections?: () => void;
};

export async function closeOwnedServer(server: OwnedServer): Promise<void> {
  try {
    await withShutdownDeadline('Owned server close', () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }));
  } finally { server.closeAllConnections?.(); }
}
