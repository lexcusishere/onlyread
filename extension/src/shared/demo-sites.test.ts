import { describe, expect, it } from 'vitest';
import { DEMO_SITES, demoSite } from './demo-sites';

// Each demo site's change, as its labeled test sessions recorded it, ends the demo; the writes those sessions show the
// page sending by itself (apps/<site>/labels.jsonl) do not. Thread and account ids zeroed.
const catches = (id: string, url: string, shape: string, body?: string) => demoSite(id)!.catches({ url, shape, body });

describe('the demo catches the change it asks for, and only that', () => {
  it('X: a like (FavoriteTweet), not an unlike or a dismissed prompt', () => {
    expect(catches('x', 'https://x.com/i/api/graphql/lI07N6Otwv1PhnEgXILM7A/FavoriteTweet', 'json:queryId,variables')).toBe(true);
    expect(catches('x', 'https://x.com/i/api/graphql/ZYKSe-w7KEslx3JhSIk5LA/UnfavoriteTweet', 'json:queryId,variables')).toBe(false);
    expect(catches('x', 'https://x.com/i/api/1.1/account/settings.json', 'form:dismiss')).toBe(false);
  });
  it('LinkedIn: a reaction, not marking notifications seen, search history or the messages badge', () => {
    const rsc = 'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request';
    expect(catches('linkedin', rsc, 'li:rsc:w[reactions.create]')).toBe(true);
    expect(catches('linkedin', 'https://www.linkedin.com/voyager/api/graphql?action=execute&queryId=voyagerSocialDashReactions.b73122', 'json:includeWebMetadata,queryId,variables')).toBe(true);
    for (const shape of ['li:rsc:w[reactions.delete]', 'li:rsc:w[notifications.markNotificationsSeen]', 'li:rsc:w[requests.updateSearchHistoryRequest]', 'li:rsc:w[cooloff.activity]']) expect(catches('linkedin', rsc, shape)).toBe(false);
    expect(catches('linkedin', 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessagingBadge?action=markAllMessagesAsSeen', 'li:msgbadge:w[seen]')).toBe(false);
  });
  it('Facebook: a reaction, not typing or screen-time logging', () => {
    const gql = 'https://www.facebook.com/api/graphql/';
    expect(catches('facebook', gql, 'fb:gql:w[CometUFIFeedbackReactMutation]')).toBe(true);
    for (const shape of ['fb:gql:w[CometUFILiveTypingBroadcastMutation_StartMutation]', 'fb:gql:w[FBScreenTimeLogger_syncMutation]', 'fb:gql:w[useCometUFICreateCommentMutation]']) expect(catches('facebook', gql, shape)).toBe(false);
  });
  it('Google Calendar: an event, not a settings change', () => {
    const sync = 'https://calendar.google.com/calendar/u/0/sync.sync';
    expect(catches('calendar', sync, 'gcal:sync:w[event]')).toBe(true);
    expect(catches('calendar', sync, 'gcal:sync:w[event,set:defaultCalMode]')).toBe(true);
    expect(catches('calendar', sync, 'gcal:sync:w[set:defaultCalMode]')).toBe(false);
    expect(catches('calendar', sync, 'gcal:sync:w[unparseable]')).toBe(false);
  });
  it('Linear: an issue updated, not a draft or a view preference', () => {
    const gql = 'https://client-api.linear.app/graphql';
    expect(catches('linear', gql, 'gql:mutation:IssueUpdate')).toBe(true);
    for (const shape of ['gql:mutation:DraftCreate', 'gql:mutation:ViewPreferencesCreate', 'gql:mutation:IssueUpdateX']) expect(catches('linear', gql, shape)).toBe(false);
  });
  it('offers these sites, in this order', () => {
    expect(DEMO_SITES.map((s) => s.id)).toEqual(['x', 'linkedin', 'facebook', 'calendar', 'linear']);
  });
});
