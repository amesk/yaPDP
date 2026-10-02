export interface SlideItem {
  id: string;
  title: string;
  image: string;
  alt: string;
  caption: string;
  tag?: string;
  description?: string;
  // QuickBoot scenario key (see src/osboot.js) — the guest OS this tile boots
  // when the visitor presses Run. The key names a SCENARIO, not a disk: the
  // boot command, the typed steps and the whole machine profile (console,
  // printer, VT11) stay in OSBoot, so the landing never duplicates hardware
  // knowledge and cannot drift out of step with the wizard.
  bootKey?: string;
  // A saved machine state (see states/<name>.state.zst) — the guest ALREADY
  // RUNNING, ready to type at. This is the "Teleport!" tile: instead of
  // booting the OS and waiting, the state is fetched and applied, which for a
  // heavy guest is the difference between ~150 s and ~2 s. It names a file the
  // project hosts, never a scenario key: the two are different requests (see
  // docs/ROADMAP.md — a boot key is an identifier, a state URL is a pointer).
  stateUrl?: string;
  // What the state IS, so the tile does not lie: a screenshot of the middle of
  // a game and a state parked at a login prompt are different promises.
  stateReady?: string;
}

export interface FeatureItem {
  id: string;
  title: string;
  description: string;
}

export interface ResourceLinkItem {
  id: string;
  name: string;
  url: string;
  displayUrl?: string;
  notes?: string;
  // The language this entry belongs to. Absent means both locales see it; a
  // value keeps it in that locale only. Used for the Telegram channel, which
  // is Russian: an English reader was being offered a link they cannot use
  // and will not follow, while GitHub Discussions serves them instead.
  lang?: 'en' | 'ru';
  // A destination that differs by locale — the printed manual is the case: the
  // English page offers manual.pdf, the Russian one manual_ru.pdf. When these
  // are present the table picks the pair matching the reader, so the link under
  // "User Manual (PDF)" is always the file in the language of the page.
  nameRu?: string;
  urlEn?: string;
  urlRu?: string;
  displayUrlEn?: string;
  displayUrlRu?: string;
  notesRu?: string;
}

export interface DownloadVariantItem {
  id: string;
  variant: string;
  ships: string;
  notes: string;
}
