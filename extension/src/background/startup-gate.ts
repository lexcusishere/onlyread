// Nothing is handled before startup has read the stored policy: otherwise a setup message handled meanwhile would
// plan from the module defaults and write them, as an own write the change handler takes without its weakening
// check, over the stored sites and guard-everything. index.ts waits for the startup attempt before every
// message; after one that failed, only these reads go through, so the defaults are never written.

/** Messages answered after a startup that failed: the reads the pages show the problem through, and the content
 *  script's reports. Nothing that writes settings. */
const READS_WHEN_UNSTARTED = new Set(['status:get', 'sites:list', 'activity:get', 'audit:list', 'support:list', 'observations:list', 'cache:list', 'cloud:status', 'policy:get', 'guard:config', 'page:agent-setup-hello', 'ui:action', 'secret:typed', 'page:closing']);

/** Why a message may not be handled once the startup attempt is over; undefined when it may. */
export function unstartedRefusal(type: unknown, started: boolean, problem: string | undefined): string | undefined {
  if (started || READS_WHEN_UNSTARTED.has(String(type))) return undefined;
  return `OnlyRead did not finish starting (${problem ?? 'unknown problem'}); reload it.`;
}
