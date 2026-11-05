# Security policy

OnlyRead is a security control: a way to make an AI agent's browser session read-only. A bypass (a write
that reaches a guarded site while enforce mode is on) is a security vulnerability.

## Reporting

Please report privately through GitHub: **Security → Report a vulnerability** on
https://github.com/onlyreadai/onlyread. Do not open a public issue for a bypass.

Include the site, the action, how you observed that the write persisted (reload, another device, the
other party), the time of the attempt, and whether OnlyRead showed its notice ("OnlyRead kept <site>
read-only"). Redact personal data.

## Known limitations (not vulnerabilities)

Documented in the README under Limits and Roadmap: sites are guarded by host, not by account, Chrome's
debugger banner, connections a site opened before guarding started, and agents that drive the screen from
outside the browser, which are covered in Always mode only.
