// First-run setup: open the judge window once, on a fresh install, when no AI key is stored.
import { hasAnyKey, type Secrets } from '../shared/providers';

/** Only a real first install prompts: updates and dev reloads (reason "update") and browser restarts never do. */
export function shouldPromptForKey(reason: string | undefined, secrets: Secrets | undefined | null): boolean {
  return reason === 'install' && !hasAnyKey(secrets);
}
