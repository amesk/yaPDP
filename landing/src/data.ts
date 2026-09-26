import { SlideItem, FeatureItem, ResourceLinkItem, DownloadVariantItem } from './types.ts';

export const GUEST_OS_SLIDES: SlideItem[] = [
  {
    id: 'unix_v5',
    title: 'Unix V5',
    caption: 'Unix V5',
    image: 'assets/images/os/unix_v5.png',
    alt: 'Unix V5 running on yaPDP',
    description: 'Ken Thompson and Dennis Ritchie\'s Research Unix V5 (1974) with early C compiler, sh, and roff.',
  },
  {
    id: 'bsd',
    title: '2.11 BSD',
    caption: '2.11 BSD',
    image: 'assets/images/os/bsd.png',
    alt: '2.11 BSD running on yaPDP',
    description: 'Berkeley Software Distribution 2.11 in full multiuser mode, featuring vi, cc, TCP/IP networking stack.',
  },
  {
    id: 'rt11',
    title: 'RT-11',
    caption: 'RT-11',
    image: 'assets/images/os/rt11.png',
    alt: 'RT-11 running on yaPDP',
    description: 'DEC Real-Time operating system widely deployed in laboratory instrumentation and Soviet clones.',
  },
  {
    id: 'rt11-vt52',
    title: 'RT-11 · VT52',
    caption: 'RT-11 · VT52',
    image: 'assets/images/os/rt11-vt52.png',
    alt: 'RT-11 on VT52 terminal',
    description: 'RT-11 interacting with the DECscope VT52 CRT terminal emulator running on canvas.',
  },
  {
    id: 'basic',
    title: 'DEC BASIC-11',
    caption: 'DEC BASIC-11',
    image: 'assets/images/os/basic.png',
    alt: 'DEC BASIC-11 running on yaPDP',
    description: 'Interactive BASIC-11 loaded into PDP-11 memory, executing numerical and string expressions.',
  },
  {
    id: 'lunar-lander',
    title: 'Lunar Lander',
    caption: 'Lunar Lander',
    image: 'assets/images/os/lunar-lander.png',
    alt: 'Lunar Lander running on yaPDP',
    description: 'Historical text-based simulation game loaded directly from simulated paper tape.',
  },
  {
    id: 'xxdp',
    title: 'XXDP+',
    caption: 'XXDP+',
    image: 'assets/images/os/xxdp.png',
    alt: 'XXDP+ diagnostics running on yaPDP',
    description: 'DEC field diagnostic operating system used to test CPU instructions, memory management, and peripherals.',
  },
];

export const FEATURES_EN: FeatureItem[] = [
  {
    id: 'front-panel',
    title: 'Authentic Front Panel',
    description: 'Every switch, LED, and rotary knob faithfully recreated. Toggle in a bootstrap loader the way DEC engineers did in the 1970s.',
  },
  {
    id: 'teletype',
    title: 'Model 33 ASR Teletype',
    description: 'A fully animated Google60-style teletype connected as the operator console — complete with paper printing, keypunch sounds, line-feed whirs and authentic nroff/man overstrike rendering.',
  },
  {
    id: 'vt52',
    title: 'VT52 / VT100 Terminals',
    description: 'Video terminals rendered on canvas, for guest OSes that prefer them: a DECscope VT52 or a DEC VT100 (ANSI), chosen per terminal — console TT0, TTY 1 and TTY 2 — each drawn in its own cabinet.',
  },
  {
    id: 'vt11',
    title: 'VT11 Display',
    description: 'An optional DEC VT11 vector-graphics display processor on its own green-phosphor CRT page, enabled from the CONFIG page.',
  },
  {
    id: 'bootable-media',
    title: 'Bootable Media',
    description: 'Fifteen bootable disk and tape images — Unix V5, BSD 2.9 & 2.11, Ultrix-11, RSX-11M (3.2 & 4.6), RSTS/E (4B-17 through 10.1), RT-11 and XXDP diagnostics — plus the paper-tape reader for the self-building bootstrap and for programs like BASIC-11 and Lunar Lander.',
  },
  {
    id: 'storage',
    title: 'Persistent Storage',
    description: 'All disk and tape images are preloaded. Changes to disk contents persist in browser storage across sessions.',
  },
  {
    id: 'paper-tape',
    title: 'Paper Tape Reader',
    description: 'Load BASIC‑11, ODT‑11, ED‑11, or Lunar Lander from simulated paper tape.',
  },
  {
    id: 'desktop-app',
    title: 'Desktop App',
    description: 'The same emulator is packaged as a native offline Tauri desktop application — see the README for the two installer variants.',
  },
];

export const FEATURES_RU: FeatureItem[] = [
  {
    id: 'front-panel',
    title: 'Аутентичная пультовая панель',
    description: 'Каждый тумблер, светодиод и поворотный переключатель воссозданы до мельчайших деталей. Загружайте начальный загрузчик тумблерами, как инженеры DEC в 1970-х.',
  },
  {
    id: 'teletype',
    title: 'Телетайп Model 33 ASR',
    description: 'Полностью анимированный телетайп в стиле Google60 в качестве консоли оператора — с печатью на рулонной бумаге, звуками клавиш и каретки, и честным оверстрайком.',
  },
  {
    id: 'vt52',
    title: 'Терминалы VT52 / VT100',
    description: 'Видеотерминалы на базе Canvas для операционных систем, предпочитающих терминалы: DECscope VT52 или DEC VT100 (ANSI) — выбираются отдельно для консоли TT0, TTY 1 и TTY 2, каждый в собственном корпусе.',
  },
  {
    id: 'vt11',
    title: 'Векторный дисплей VT11',
    description: 'Опциональный векторный графический процессор DEC VT11 с зеленым люминофором на отдельной странице, включаемый через CONFIG.',
  },
  {
    id: 'bootable-media',
    title: 'Загрузочные носители',
    description: 'Пятнадцать загрузочных образов на дисках и лентах — Unix V5, BSD 2.9 и 2.11, Ultrix-11, RSX-11M (3.2 и 4.6), RSTS/E (от 4B-17 до 10.1), RT-11 и диагностика XXDP, — а также считыватель перфоленты для самосборного загрузчика и для программ вроде BASIC-11 и Lunar Lander.',
  },
  {
    id: 'storage',
    title: 'Постоянное хранение',
    description: 'Все образы дисков и лент уже предзагружены. Изменения на виртуальных дисках сохраняются в локальном хранилище браузера между сессиями.',
  },
  {
    id: 'paper-tape',
    title: 'Считыватель перфоленты',
    description: 'Загружайте BASIC‑11, ODT‑11, ED‑11 или Lunar Lander напрямую с эмулированной перфоленты.',
  },
  {
    id: 'desktop-app',
    title: 'Настольное приложение',
    description: 'Эмулятор выпускается и как автономное офлайн-приложение для Windows и Linux — без браузера и без сети.',
  },
];

export const RESOURCE_LINKS: ResourceLinkItem[] = [
  {
    id: 'emulator',
    name: 'yaPDP emulator (online)',
    displayUrl: 'pdp11.html',
    url: 'pdp11.html',
    notes: 'Interactive in-browser PDP-11/70 emulator',
  },
  {
    // The manual as a printable document, in the language of the page that is
    // reading this table: an English reader gets manual.pdf, a Russian one
    // manual_ru.pdf. Both files sit next to manual.html at the site root, so
    // the link works from the landing page and from a downloaded copy alike.
    id: 'manual-pdf',
    name: 'User Manual (PDF)',
    nameRu: 'Руководство пользователя (PDF)',
    displayUrlEn: 'manual.pdf',
    displayUrlRu: 'manual_ru.pdf',
    urlEn: 'manual.pdf',
    urlRu: 'manual_ru.pdf',
    notes: 'Printable edition with a cover — same text as the manual, on paper',
    notesRu: 'Печатное издание с обложкой — тот же текст, что и в мануале, на бумаге',
  },
  {
    id: 'upstream',
    name: 'Hosted live demo (upstream)',
    displayUrl: 'https://paulnank.github.io/pdp11-js/pdp11.html',
    url: 'https://paulnank.github.io/pdp11-js/pdp11.html',
    notes: 'Upstream reference implementation by Paul Nankervis',
  },
  {
    id: 'github',
    name: 'Source code (GitHub)',
    displayUrl: 'https://github.com/amesk/yaPDP',
    url: 'https://github.com/amesk/yaPDP',
    notes: 'Main repository and documentation',
  },
  {
    id: 'telegram',
    name: 'Telegram Channel (RU)',
    displayUrl: 'https://t.me/yaPDP_news_ru',
    url: 'https://t.me/yaPDP_news_ru',
    notes: 'Official updates and news channel by Alexei Eskenazi',
    // The channel is Russian, so it is listed in the Russian locale only: an
    // English reader was being offered a link they would not follow, and the
    // header and footer point them at GitHub Discussions instead.
    lang: 'ru',
  },
  {
    id: 'readme',
    name: 'README',
    displayUrl: 'README.md',
    url: 'https://github.com/amesk/yaPDP#readme',
    notes: 'Build instructions, guest OS table, desktop app variants',
  },
  {
    id: 'pdp11js',
    name: 'Original pdp11-js',
    displayUrl: 'https://github.com/paulnank/pdp11-js/',
    url: 'https://github.com/paulnank/pdp11-js/',
    notes: 'Original JavaScript PDP-11 CPU emulator by Paul Nankervis',
  },
  {
    id: 'google60',
    name: 'Google60 (mass:werk)',
    displayUrl: 'https://www.masswerk.at/google60/',
    url: 'https://www.masswerk.at/google60/',
    notes: 'Teletype engine by Norbert Landsteiner',
  },
];

export const DOWNLOAD_VARIANTS: DownloadVariantItem[] = [
  {
    id: 'minimal',
    variant: 'Minimal',
    ships: 'rk0 (Unix V5), rk1 (RT-11), bootcode + the demo paper tapes (BASIC-11, ODT-11, ED-11, Lunar Lander)',
    notes: '≈19 MB on Windows. Boots Unix V5, RT-11 and the paper tapes out of the box; every other image is added by drag & drop at runtime.',
  },
  {
    id: 'full',
    variant: 'Full',
    ships: 'every image — RK/RL/RP/RA disks, TM tapes, all paper tapes',
    notes: '≈103 MB on Windows, but every guest system in this manual boots offline — nothing to download, no setup.',
  },
];
