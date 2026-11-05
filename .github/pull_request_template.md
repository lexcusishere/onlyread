## What and why

<!-- One or two sentences: what this changes and the problem it solves. -->

## How it was checked

- [ ] `npm run check` passes (typecheck, lint, unit tests, fingerprint tests, build, scrub)
- [ ] `npm run e2e` passes, if the change touches interception, rules, decoders or a site profile
- [ ] For a new or changed site: the steps in [Adding a site](../CONTRIBUTING.md#adding-a-site), with writes verified against server truth

## Safety

- [ ] Nothing here can let a write through that was refused before (fail closed: anything unclassified is refused)
- [ ] No recordings, tokens or account identifiers are committed (`apps/*/sessions/` stays local)
