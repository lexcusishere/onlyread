// The sites the first-run demo offers (setup window, then the coach card on the site): verified sites, each with one
// harmless write to try and the request it sends, refused by tested rules (a site codec or labeled verdicts), so the
// demo works with no AI judge set up.
export interface DemoSite {
  /** A built-in site's id (sites.ts). */
  id: string;
  name: string;
  /** Where the demo opens it. */
  url: string;
  /** The write to try, short: on the setup tile and the coach card. */
  action: string;
  /** Where to find it on the page. */
  hint: string;
  /** The change in plain words, once refused: "Stopped: your like". */
  change: string;
  /** Whether a refused request is the one that change sends: only it ends the demo, not a write the page sends by
   *  itself as it loads (a read receipt, an unseen flag cleared). Built from the site's labeled test sessions
   *  (apps/<site>/labels.jsonl) and checked against every write they recorded. */
  catches: (req: DemoRequest) => boolean;
}

/** A refused request as the demo sees it: its address, its decoded shape, its body when it was read. */
export interface DemoRequest { url: string; shape: string; body?: string }

/** Matches the address and the decoded shape together. */
const on = (re: RegExp) => (r: DemoRequest) => re.test(`${r.url} ${r.shape}`);

export const DEMO_SITES: readonly DemoSite[] = [
  { id: 'x', name: 'X', url: 'https://x.com/home', action: 'Like any post', hint: 'Tap the heart under a post.', change: 'your like',
    catches: on(/\/i\/api\/graphql\/[^/]+\/FavoriteTweet\b/) },
  { id: 'linkedin', name: 'LinkedIn', url: 'https://www.linkedin.com/feed/', action: 'React to a post', hint: 'Click Like under a post in your feed.', change: 'your reaction',
    catches: on(/li:rsc:w\[reactions\.create\]|queryId=voyagerSocialDashReactions\./) },
  { id: 'facebook', name: 'Facebook', url: 'https://www.facebook.com/', action: 'Like any post', hint: 'Click Like under a post in your feed.', change: 'your like',
    catches: on(/fb:gql:w\[\w*Feedback\w*React\w*\]/) },
  { id: 'calendar', name: 'Calendar', url: 'https://calendar.google.com/calendar/r', action: 'Create an event', hint: 'Click a time slot, give it a title and Save.', change: 'your new event',
    catches: on(/gcal:sync:w\[[^\]]*\bevent\b/) },
  { id: 'linear', name: 'Linear', url: 'https://linear.app/', action: 'Set a priority', hint: 'Open any issue and pick another priority.', change: 'your priority change',
    catches: on(/gql:mutation:IssueUpdate\b/) },
];

export function demoSite(id: string | undefined): DemoSite | undefined {
  return DEMO_SITES.find((s) => s.id === id);
}
