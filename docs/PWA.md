# Progressive Web App (PWA)

Both the landing page and the classic `pdp11.html` emulator can be installed as apps in browsers that support web-app installation. They use separate manifests so each installed entry point opens the intended page. Manifest and icon URLs are relative and work on GitHub Pages at `/yaPDP/`.

## Current scope

This first step provides install metadata: app name, standalone display mode, theme colors, start URL, and icons. It does **not** make the emulator or its guest disk/tape images available offline. An installable PWA and an offline-capable PWA are different milestones; offline caching needs a separate design and tests so cached application code cannot silently drift from the guest media or state-restoration logic.

The landing page opens the museum's front door; the separate `pdp11.webmanifest` starts directly in the emulator. Both entries use the same project icon at `assets/pdp11-icon.svg`.

## Verify locally

1. Build the site with `npm run site:build`.
2. Serve the assembled site with `npm run site:serve` (or use `npm run site:preview`).
3. Open the landing page over localhost and inspect the browser's Application/Manifest panel.
4. Confirm that both `manifest.webmanifest` and `pdp11.webmanifest` load, the shared SVG icon URL returns an image, and each start URL opens the expected page within the application scope.
5. On a supported browser, test installation from both the landing page and `pdp11.html`; confirm each installed shortcut opens its own entry point.

For the deployed site, repeat the checks at `https://amesk.github.io/yaPDP/`. Do not test by opening the HTML file directly: installation requires HTTPS or localhost.

## Next milestone: offline use

Before adding a service worker, define which resources belong in the initial application shell and which large guest images should be downloaded only on demand. Test first-load and update behavior, query-string state links, and IndexedDB persistence with the network disconnected. The app should not claim that a guest OS or shared state is available offline unless all required resources have actually been stored locally.
