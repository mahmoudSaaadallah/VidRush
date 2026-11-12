# VidRush project instructions

## Version every delivered update

- Increment `extension/manifest.json` version before delivering each installable change batch, including a follow-up update to an already tested pull request. Several logical commits in one undelivered batch can share one version.
- Keep `package.json`, the root `package-lock.json` version, and `package-lock.json`'s root package version identical to the extension version.
- Use numeric `major.minor.patch` versions compatible with Chrome: patch for fixes and small changes, minor for added features, major for incompatible releases. Do not reuse a delivered version for changed extension files.
- Display the installed version using `chrome.runtime.getManifest().version`; never duplicate a version literal in the popup.
- Run `npm run check` and the relevant existing checks. Pull request CI requires a version greater than the base branch version.

## Delivery preferences

- Work on a feature or fix branch. Split changes into multiple meaningful commits and open a pull request for the user to review.
- Do not push feature changes directly to `main`, approve the pull request, or merge it.
- Include these exact trailers in every commit:

  ```text
  Committed-By-Agent: codex
  Co-authored-by: codex <noreply@openai.com>
  Co-authored-by: Codex <codex@openai.com>
  ```

- Keep the README in clear, beginner-friendly English, including any update or activation steps users need.
- Preserve the manifest key and stable extension ID when changing versions.
