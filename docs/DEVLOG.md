# DevLog publishing workflow

The DevLog is part of the yaPDP website, but publishing an article should not
require publishing the current development version of the emulator. The Pages
workflow deploys the **whole site**: the landing page, emulator, media, machine
states, manual and DevLog. Publishing from an arbitrary `master` commit could
therefore expose emulator changes that have not passed the release process.

The workflow below keeps editorial work independent from emulator development
while retaining one canonical copy of every article in the yaPDP repository.

## Source of truth

Write posts as Markdown files in [`docs/devlog/`](devlog/). Each post uses the
front matter supported by [`tools/build-devlog.js`](../tools/build-devlog.js):

```yaml
---
title: "A descriptive title"
date: 2026-10-15
lang: en
summary: "One or two sentences used in the DevLog index and Atom feed."
# Optional: keep this source out of all generated/public DevLog outputs while drafting.
draft: true
---
```

Use a filename beginning with the publication date, followed by a short
lowercase slug, for example
`docs/devlog/2026-10-15-sharing-machine-states.md`. Keep images in
`assets/images/devlog/<same-slug>/` and link to them with repository-relative
paths, following the existing posts. The generator supports a deliberately
small Markdown subset; check its comments and existing posts before relying on
less common Markdown syntax.

The Markdown file is the source of truth. The generator creates the static
article pages, the newest-first index, the Atom feed and the landing-page data.
Do not hand-edit generated DevLog output.

### Draft articles

Use the optional `draft` front-matter field while an article is still being
written:

```yaml
draft: true
```

Only the literal string `true` marks a post as a draft. The generator still
loads and parses draft files, so their front matter and supported Markdown are
checked during development. It omits draft posts from generated article pages,
the DevLog index, the Atom feed and the landing-page data. Drafts can therefore
remain alongside publishable sources in `docs/devlog/` without appearing in
the generated DevLog.

When the article is ready, remove `draft: true` or change it to `draft: false`,
then run `npm run devlog:check` and preview the complete site before publishing.
An absent `draft` field, `false`, or any value other than the literal `true`
does **not** mark the post as a draft.

**This flag is not an access-control mechanism.** The Markdown source and its
assets remain visible to anyone who can access the GitHub repository, and
publishing a Support branch still deploys the entire site. Do not put secrets
in a draft or assume that `draft: true` prevents unrelated unreleased emulator
changes on the selected publishing branch from going live.

## After a release: create a Support branch

After releasing version `X.Y.Z`, create a publishing branch from that exact
release tag (or its commit), named `X.Y.Support`, for example `0.4.Support`.
This branch represents the emulator version currently published to visitors;
it is an editorial lane, not a second development branch.

Keep the Support branch close to the release:

- Start it from the released commit, not from the moving `master` branch.
- Add only DevLog articles and assets, plus small corrections needed to publish
  those articles.
- Do not merge ongoing emulator features or unrelated fixes from `master`.
- Keep the branch while it is the public publishing baseline or a useful
  rollback point. After the next release, create a new Support branch from the
  new release rather than rebasing the old one.

This makes the site build reproducible against the released emulator while
articles can be published whenever they are ready.

## Add and preview an article

1. Add the Markdown source and any images to the Support branch.
2. Run the DevLog consistency check:

   ```sh
   npm run devlog:check
   ```

3. Build and inspect the complete site before publishing:

   ```sh
   npm run docs
   npm run site:build
   npm run site:serve
   ```

   Open the local site and check the article page, DevLog index, links, images,
   Atom feed and landing-page listing. The exact build command may also be run
   as `npm run site:preview`, which builds and serves the site.

4. Commit the source article and its assets with an English commit message.
   Keep article commits focused so they can be cherry-picked independently.

## Publish the Support branch

The Pages workflow publishes automatically when a `releases/v*` tag is pushed.
For an editorial update, do **not** create a release tag.

Instead, open GitHub Actions → **pages** → **Run workflow**, select the
`X.Y.Support` branch in the workflow's `branch` input, and run it. The input
accepts a branch or commit SHA; selecting the Support branch publishes the
released emulator plus the DevLog sources present on that branch. Wait for the
workflow to finish, then inspect the live DevLog index and the published
article.

The deployment is still a full-site deployment, not an article-only upload.
Only publish from the Support branch after its site has been reviewed. The
workflow does not itself prove that the selected ref passed CI or that the
operator inspected the result.

## Bring articles back to master

The Support branch is a publishing lane, not a permanent fork of the project.
After an article has been published, bring its source commit back to `master`
with **cherry-pick**:

```sh
git switch master
git pull --ff-only
git cherry-pick <article-commit>
git push
```

Use the actual article commit SHA in place of the placeholder. Cherry-pick
article commits one at a time, preserving the separation between editorial
content and emulator changes. If a post depends on a feature that exists only
on `master`, it is not ready to be published from the Support branch: either
wait until the feature ships, or explicitly arrange a separate preview. Do not
copy the feature implementation into the Support branch just to make the post
build.

If an article commit includes changes to the generator, templates, landing-page
components or other publishing infrastructure, stop and review the dependency
before cherry-picking. Those changes may depend on code that is not in the
released baseline; they are not automatically safe editorial commits.

## When the next version is released

After releasing the next version:

1. Create the new Support branch from the new release tag.
2. Confirm the branch contains the already published DevLog articles.
3. Continue editorial work on the new branch and deploy it manually when ready.
4. Cherry-pick new, independent article commits to `master`.

Do not use a merge from Support into `master` as the routine synchronization
mechanism: the intended unit of transfer is each self-contained article commit.
If publishing infrastructure changes become frequent or tightly coupled to
development, revisit this rule rather than allowing the Support branch to drift.

## Quick checklist

- [ ] The Support branch starts at the intended release commit.
- [ ] The post has valid front matter, a date-prefixed filename and a summary.
- [ ] Images and links work in the local site preview.
- [ ] `npm run devlog:check` passes.
- [ ] The full site was reviewed before manual Pages deployment.
- [ ] The article commit contains only independent editorial content and assets.
- [ ] The published article commit was cherry-picked back to `master`.
