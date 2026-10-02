# Community and marketing rules

## Principle

Canvink marketing must be as inspectable as its code. The project earns trust by showing working software, naming limitations, and listening without pretending that attention equals product quality.

These rules apply to maintainers, contractors, volunteers, and software agents acting for the project.

## Truthful product claims

- Say `public alpha` for every current 0.x release.
- Separate `available now`, `experimental`, `planned`, and `researching`.
- Never claim OneNote parity.
- Never call a build signed, secure, private, encrypted, cross-platform, or production-ready without evidence for that exact claim.
- Say that desktop data uses local SQLite and browser-demo data uses IndexedDB.
- Say that self-hosting serves the static browser app and does not create server-side notebook storage, accounts, or sync.
- Describe offline reopening only as an application-shell cache after a successful first load, not as sync or guaranteed backup.
- State that the two stores do not sync.
- State that local data is not encrypted by Canvink in the current alpha.
- Keep the unsigned-build warning next to desktop downloads.
- Link to source, license, changelog, and known limitations.

Metrics, quotes, screenshots, and compatibility claims must be reproducible or clearly attributed.

## Reddit and other communities

Before posting:

1. Read the community's current rules.
2. Search for recent similar posts.
3. Choose communities where the project directly answers an existing need.
4. Use a plain title and disclose project affiliation.
5. Explain the alpha status and ask for specific feedback.
6. Avoid posting the same text across many communities.

Do not:

- Astroturf or impersonate an independent user
- Buy, coordinate, or manipulate votes
- Use fake testimonials, fake scarcity, or invented usage numbers
- Evade self-promotion rules
- Send unsolicited direct messages
- Argue with moderators about removal
- Hide material AI or automation involvement when disclosure is required or relevant

One useful, responsive post is better than a burst of duplicated promotion.

## Software-agent boundaries

A marketing agent may:

- Research relevant communities and their rules
- Draft posts, release notes, replies, and editorial calendars
- Track public questions and summarize themes
- Propose experiments using aggregate, privacy-preserving measures
- Prepare corrections when a claim becomes inaccurate

An agent operating an official account must identify its project affiliation. It must not fabricate personal experience or simulate community consensus. Maintainers remain accountable for its actions.

Automation must respect rate limits and community rules. A posting agent should stop after moderation feedback, a factual dispute it cannot resolve, or signs that replies are becoming repetitive or unwelcome.

## Replies and feedback

- Answer the question asked.
- Thank people without using praise as a substitute for substance.
- Reproduce bug reports with synthetic data.
- Link to an existing issue when useful, but do not force every conversation into GitHub.
- Admit uncertainty and verify before making compatibility or security claims.
- Do not ask users to share private notebooks.
- Never expose a reporter's identity or private correspondence.
- Record repeated product themes separately from raw personal details.

Harassment and abusive content are handled under the [Code of Conduct](../CODE_OF_CONDUCT.md).

## Release communication

Marketing starts only after the release artifacts and production landing page have been verified.

Every release post should contain:

- What changed
- Who the release is for
- One concrete workflow to try
- Known limitations
- Supported platforms actually tested
- Unsigned-build warning, when applicable
- Direct source and release links
- A specific feedback request

If an artifact is withdrawn or a data-risk bug is found, pause scheduled promotion and publish the correction through the same channels used for the original claim.

## Privacy-respecting measurement

Canvink does not add tracking to notebook content.

Prefer:

- Aggregate repository traffic
- Public release-download counts
- Voluntary issue and discussion feedback
- Platform-native aggregate post metrics
- Manual, short-lived campaign notes

Avoid:

- Tracking pixels
- Fingerprinting
- Uploading notebook content or filenames
- Hidden link decoration that follows individuals across sites
- Combining identities across communities
- Retaining raw personal data when an aggregate count answers the question

Any future analytics proposal requires a public privacy review, a clear purpose, data minimization, retention limits, and an opt-in or strong justification appropriate to the data.

## Editorial quality gate

Before publishing, check:

- Is every shipped-feature claim visible in the exact release?
- Are limitations close to the claim they qualify?
- Does every link work?
- Is the post useful without clicking?
- Is project affiliation clear?
- Is AI or automation disclosure adequate?
- Does the post comply with the target community's rules?
- Would a skeptical user consider the wording fair?

When the answer is uncertain, revise or delay the post.
