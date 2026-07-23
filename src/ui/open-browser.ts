// Tiny helper kept separate so server.ts stays portable/testable.
import { exec } from 'node:child_process';

/** Fire-and-forget a command (used to open the browser); errors are ignored. */
export function execTimeoutSafe(cmd: string): void {
  exec(cmd, { timeout: 5000 }, () => {
    /* best effort */
  });
}
