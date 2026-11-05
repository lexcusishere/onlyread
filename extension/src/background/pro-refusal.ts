// OnlyRead Pro's own words for its last refusal of the plan ("Your trial ended…"), kept apart from cloud-session.ts so
// the interception path can read them without loading the session. Set from the Pro judge's results, cleared by the
// next success.
let text: string | undefined;

export function setProRefusal(next: string | undefined): void {
  text = next;
}

/** The service's words for the last refusal, for the in-page notice; undefined when it gave none. */
export function proRefusalText(): string | undefined {
  return text;
}
