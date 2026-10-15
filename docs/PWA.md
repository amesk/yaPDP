# Progressive Web App (PWA)

yaPDP's web landing page can be installed as an app in browsers that support web-app installation. The manifest is served from the site root and uses relative URLs so it also works on GitHub Pages at `/yaPDP/`.

## Current scope

This first step provides install metadata: app name, standalone display mode, theme colors, start URL, and icons. It does **not** make the emulator or its guest disk/tape images available offline. An installable PWA and an offline-capable PWA are different milestones; offline caching needs a separate design and tests so cached application code cannot silently drift from the guest media or state-restoration logic.

The classic emulator page remains available at `pdp11.html`. The manifest is linked from the React landing page, which is the intended installation entry point.

## Verify locally

1. Build the site with `npm run site:build`.
2. Serve the assembled site with `npm run site:serve` (or use `npm run site:preview`).
3. Open the landing page over localhost and inspect the browser's Application/Manifest panel.
4. Confirm that the manifest loads, its icon URLs return images, and the start URL stays within the application scope.
5. On a supported browser, check that the browser offers its normal install action and that the installed app opens the landing page.

For the deployed site, repeat the checks at `https://amesk.github.io/yaPDP/`. Do not test by opening the HTML file directly: installation requires HTTPS or localhost.

## Next milestone: offline use

Before adding a service worker, define which resources belong in the initial application shell and which large guest images should be downloaded only on demand. Test first-load and update behavior, query-string state links, and IndexedDB persistence with the network disconnected. The app should not claim that a guest OS or shared state is available offline unless all required resources have actually been stored locally.
