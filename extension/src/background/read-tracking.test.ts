import { describe, expect, it } from 'vitest';
import { readTrackingRequest } from './read-tracking';

// The read-tracking requests a shape cannot name exactly (read-tracking.ts), in the forms the sites' test sessions
// recorded them (ids zeroed), and the writes beside them that must not pass.
const req = (url: string, body?: unknown) => {
  const u = new URL(url);
  return readTrackingRequest({ host: u.hostname, path: u.pathname, url, bodyPreview: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
};
/** A Gmail sync write of these operations, each a label change on one thread: [added, removed]. */
const gmail = (...changes: [unknown, unknown][]) => [null, [changes.map((c, i) => [i + 1, ['thread-f:0', [null, null, null, null, null, null, [c[0], c[1], ['msg-f:0'], null, null, null, null, null, [0, null, null, 4]]]]])], null];
const SYNC = 'https://mail.google.com/sync/u/0/i/s?c=5&hl=en';

describe('read-tracking requests recognised by address or body', () => {
  it('X: a new-user prompt dismissed, as X sends it; no other X operation under its name', () => {
    // As recorded (x-battery-1): the body's queryId is the address's.
    const Q = 'IjQ-egg0uPkY11NyPMfRMQ';
    const url = `https://x.com/i/api/graphql/${Q}/PutClientEducationFlag`;
    expect(req(url, { variables: { flag: 'NewUserPromptEducation' }, queryId: Q })).toBe('x:education-flag');
    expect(req('https://x.com/i/api/graphql/lI07N6Otwv1PhnEgXILM7A/FavoriteTweet', { variables: { flag: 'x' }, queryId: 'lI07N6Otwv1PhnEgXILM7A' })).toBeUndefined();
    expect(req(`https://api.x.com/i/api/graphql/${Q}/PutClientEducationFlag`, { variables: { flag: 'x' }, queryId: Q })).toBeUndefined();
    // Another operation's queryId under this name (X runs what the queryId names), in the body or the address.
    expect(req(url, { variables: { flag: 'NewUserPromptEducation' }, queryId: 'a1b2c3CreateTweetQueryId' })).toBeUndefined();
    expect(req('https://x.com/i/api/graphql/a1b2c3CreateTweetQueryId/PutClientEducationFlag', { variables: { flag: 'x' }, queryId: Q })).toBeUndefined();
    // Another operation's queryId in both, matching: X runs that operation (one with no required variables, such as
    // BookmarksAllDelete, takes {flag} and ignores it).
    expect(req('https://x.com/i/api/graphql/skiACZKC1GDYli-M8RzEPQ/PutClientEducationFlag', { variables: { flag: 'x' }, queryId: 'skiACZKC1GDYli-M8RzEPQ' })).toBeUndefined();
    // Anything more: other variables, other keys, a query string, no body.
    expect(req(url, { variables: { flag: 'x', tweet_text: 'hi' }, queryId: Q })).toBeUndefined();
    expect(req(url, { variables: {}, queryId: Q })).toBeUndefined();
    expect(req(url, { variables: { flag: 'x' }, queryId: Q, features: {} })).toBeUndefined();
    expect(req(`${url}?variables=%7B%7D`, { variables: { flag: 'x' }, queryId: Q })).toBeUndefined();
    expect(req(url)).toBeUndefined();
    // A queryId that is not plain, repeated in the body: percent-encoded, or with a ;suffix.
    for (const id of ['%35pUpCreateTweetId', `${Q};x`]) {
      expect(req(`https://x.com/i/api/graphql/${id}/PutClientEducationFlag`, { variables: { flag: 'x' }, queryId: id }), id).toBeUndefined();
    }
  });

  it('Linear: a notification marked read (readAt alone); not archived or snoozed', () => {
    // As Linear sends it (session linear-coverage-1, id zeroed).
    const RECORDED = 'mutation NotificationUpdate($notificationUpdateInput: NotificationUpdateInput!) { notificationUpdate(id: "00000000-0000-4000-8000-000000000000", input: $notificationUpdateInput) { lastSyncId } }';
    const update = (input: object) => ({ query: RECORDED, variables: { notificationUpdateInput: input }, operationName: 'NotificationUpdate' });
    expect(req('https://client-api.linear.app/graphql', update({ readAt: '2026-01-01T00:00:00.000Z' }))).toBe('linear:notification-read');
    // The id as a variable, and the arguments in the other order, are the same request.
    expect(req('https://client-api.linear.app/graphql', { operationName: 'NotificationUpdate', query: 'mutation NotificationUpdate($i: NotificationUpdateInput!, $id: String!) {\n  notificationUpdate(input: $i, id: $id) { success lastSyncId }\n}', variables: { i: { readAt: 'x' }, id: 'n1' } })).toBe('linear:notification-read');
    expect(req('https://client-api.linear.app/graphql', update({ readAt: '2026-01-01T00:00:00.000Z', archivedAt: '2026-01-01T00:00:00.000Z' }))).toBeUndefined();
    expect(req('https://client-api.linear.app/graphql', update({ snoozedUntilAt: '2026-01-02T00:00:00.000Z' }))).toBeUndefined();
    expect(req('https://client-api.linear.app/graphql', { ...update({ readAt: 'x' }), operationName: 'IssueUpdate' })).toBeUndefined();
    expect(req('https://client-api.linear.app/graphql', 'not json')).toBeUndefined();
    // Keys beyond the three Linear sends: a persisted query or a stored document the server may run instead.
    const read = update({ readAt: 'x' });
    expect(req('https://client-api.linear.app/graphql', { ...read, extensions: { persistedQuery: { version: 1, sha256Hash: 'ab' } } })).toBeUndefined();
    expect(req('https://client-api.linear.app/graphql', { ...read, documentId: 'IssueDelete' })).toBeUndefined();
    expect(req('https://client-api.linear.app/graphql', { query: RECORDED, variables: read.variables })).toBeUndefined();
    // A query string the server may read in place of the body.
    expect(req('https://client-api.linear.app/graphql?query=mutation%20%7BissueDelete(id%3A%221%22)%7Bsuccess%7D%7D', read)).toBeUndefined();
  });

  it('Linear: nothing rides along with a notification marked read', () => {
    const q = (query: string, variables: object = { i: { readAt: '2026-01-01' } }) => req('https://client-api.linear.app/graphql', { operationName: 'NotificationUpdate', query, variables });
    const head = 'mutation NotificationUpdate($i: NotificationUpdateInput!)';
    // The confirmed bypass: a second root field, its arguments inline.
    expect(q(`${head} { notificationUpdate(id: "n1", input: $i) { success } issueDelete(id: "ISSUE-1") { success } }`)).toBeUndefined();
    for (const query of [
      `${head} { notificationUpdate: issueDelete(id: "ISSUE-1") { success } }`,                          // an alias over another mutation
      `${head} { x: notificationUpdate(id: "n1", input: $i) { success } }`,                               // an alias at all
      `${head} { notificationUpdate(id: "n1", input: $i) { ...F } } fragment F on NotificationPayload { success }`,
      `${head} { notificationUpdate(id: "n1", input: $i) { success } } mutation B { issueDelete(id: "1") { success } }`,
      `${head} { notificationUpdate(id: "n1", input: $i) { success } } query Q { viewer { id } }`,
      `${head} { notificationUpdate(id: "n1", input: $i) @include(if: true) { success } }`,               // a directive
      `${head} { notificationUpdate(id: "n1", input: $i) { success } __typename }`,                        // __typename at root
      `${head} { notificationUpdate(id: "n1", input: $i) { __typename } }`,
      `${head} { notificationUpdate(id: "n1", input: $i) { notification { id } } }`,                      // a nested selection
      `${head} { notificationUpdate(id: "n1", input: $i) # comment\n { success } }`,                      // a comment
      `${head} { notificationUpdate(id: "n\\u0031", input: $i) { success } }`,                            // an escape
      `${head} { notificationUpdate(id: "n1", input: {readAt: "x", archivedAt: "y"}) { success } }`,      // input inline
      `${head} { notificationUpdate(id: "n1", input: $i, extra: "1") { success } }`,
      `${head} { notificationUpdate(id: "n1") { success } }`,                                             // no input
      `${head} { notificationUpdate(input: $i, input: $i) { success } }`,
      `${head} { notificationUpdate(id: "n1", input: $i) { success } }}`,
      `mutation NotificationUpdate($i: NotificationUpdateInput!, $j: IssueUpdateInput!) { notificationUpdate(id: "n1", input: $i) { success } }`,
      `mutation NotificationUpdate($i: [NotificationUpdateInput!]!) { notificationUpdate(id: "n1", input: $i) { success } }`,
      `mutation NotificationUpdate($i: IssueUpdateInput!) { notificationUpdate(id: "n1", input: $i) { success } }`,
      `subscription NotificationUpdate($i: NotificationUpdateInput!) { notificationUpdate(id: "n1", input: $i) { success } }`,
      `﻿${head} { notificationUpdate(id: "n1", input: $i) { success } }`,
      `${head} { notificationUpdate(id: "n1", input: $i) { } }`,
    ]) expect(q(query), query).toBeUndefined();
    // Variables beyond the declared ones, or an id that is not a string.
    expect(q(`${head} { notificationUpdate(id: "n1", input: $i) { success } }`, { i: { readAt: 'x' }, other: { title: 'y' } })).toBeUndefined();
    expect(q('mutation NotificationUpdate($i: NotificationUpdateInput!, $id: String!) { notificationUpdate(id: $id, input: $i) { success } }', { i: { readAt: 'x' }, id: { a: 1 } })).toBeUndefined();
  });

  it('Gmail: messages read or the inbox seen (^u/^us removed, reading signals added); nothing else, and no batch with anything else', () => {
    expect(req(SYNC, gmail([null, ['^us']]))).toBe('gmail:marked-read');
    expect(req(SYNC, gmail([['^o'], ['^u', '^us']], [['^io_lr'], null], [['^eclicks_msg'], null]))).toBe('gmail:marked-read');
    for (const op of [[['^t', '^ss_sy'], null], [null, ['^i']], [['^k'], ['^i']], [['^u'], null], [['Label_0'], null], [['^r'], null], [null, null]] as [unknown, unknown][]) {
      expect(req(SYNC, gmail(op)), JSON.stringify(op)).toBeUndefined();
      expect(req(SYNC, gmail([null, ['^us']], op)), `batched ${JSON.stringify(op)}`).toBeUndefined();
    }
    // A send ([[null,null,2], …]), a thread state that sets another field, a poll, a body that is not one.
    expect(req(SYNC, [[null, null, 2], gmail([null, ['^us']])[1], null])).toBeUndefined();
    expect(req(SYNC, [null, [[[1, ['thread-f:0', [null, 'x', null, null, null, null, [null, ['^us']]]]]]], null])).toBeUndefined();
    expect(req(SYNC, [null, null, [], [], 0])).toBeUndefined();
    expect(req(SYNC, 'not json')).toBeUndefined();
    expect(req('https://mail.google.com/mail/u/0/', gmail([null, ['^us']]))).toBeUndefined();
  });
});
