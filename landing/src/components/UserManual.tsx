import { useState, useMemo } from 'react';
import {
  Terminal,
  BookOpen,
  ArrowLeft,
  Copy,
  Check,
  Search,
  ChevronUp,
  Download,
  Info,
  Maximize2,
  HardDrive,
  Cpu,
  Settings,
  Sparkles,
  Volume2,
  Printer,
  Sliders,
  Monitor
} from 'lucide-react';
import {
  MANUAL_SECTIONS,
  GUEST_OS_TABLE,
  CONFIG_TABS_DATA,
  FLOATING_CONTROLS_DATA
} from '../data/manualData.ts';
import { Lightbox } from './Lightbox.tsx';
import { SlideItem } from '../types.ts';

// Names of the floating controls, taken from the manual data (generated from
// docs/manual(+ru)/controls.md). They are folded into the controls section's
// search terms, so a query like "screenshot", "zoom" or "magic wand" jumps to
// that section instead of filtering a table the user cannot reach — and the
// names can never drift from the manual.
const FLOATING_CONTROL_NAMES: string[] = FLOATING_CONTROLS_DATA.flatMap(
  (b) => [b.nameEn, b.nameRu]
);

// The sidebar pages and what each one shows. Kept as data because the list is
// read in two languages and every entry is also a jump target — a renamed page
// or a moved anchor is then edited in one place. `target` empty means the page
// has no chapter in this guide (Info), so the name is rendered as plain text.
const SIDEBAR_PAGES = [
  { target: 'front-panel', name: 'Panel', descEn: 'the front panel with switches and LEDs.', descRu: 'пультовая панель с тумблерами и светодиодами.' },
  { target: 'console', name: 'Console', descEn: 'the operator console: a Model 33 ASR teletype, or a DECscope VT52 / DEC VT100 when the console terminal is a video terminal.', descRu: 'консоль оператора: телетайп Model 33 ASR либо DECscope VT52 / DEC VT100, когда консольный терминал — видеотерминал.' },
  { target: 'user-terminals', name: 'TTY 1 / TTY 2', descEn: 'user video terminals (VT52 or VT100), shown only when configured.', descRu: 'пользовательские видеотерминалы (VT52 или VT100), показываются только если настроены.' },
  { target: 'printer', name: 'Printer', descEn: 'the LP11 line printer page, shown only when configured.', descRu: 'страница построчного принтера LP11, показывается только если настроен.' },
  { target: 'vt11', name: 'Display', descEn: 'the VT11 vector-graphics CRT page, shown only when configured.', descRu: 'страница векторного CRT VT11, показывается только если настроен.' },
  { target: 'storage', name: 'Storage', descEn: 'storage media in two tabs: Images (drop zone, mounted images) and Paper Tapes (reader, punch export).', descRu: 'носители в двух вкладках: Images (зона перетаскивания, смонтированные образы) и Paper Tapes (читатель, экспорт перфоратора).' },
  { target: 'config', name: 'Config', descEn: 'configure the emulated peripherals (persisted between sessions).', descRu: 'настройка эмулируемых периферийных устройств (сохраняется между сессиями).' },
  { target: '', name: 'Info', descEn: 'detailed instructions, OS reference and the About block (version, website, author and license; the version marker at the bottom of the sidebar opens this page).', descRu: 'подробные инструкции, справочник по ОС и блок About (версия, сайт, автор и лицензия; маркер версии внизу боковой панели открывает эту страницу).' },
];

// Keyboard shortcuts. Data, not prose: the table is two languages by five
// columns, and writing it inline produced nine pairs of ternaries.
const KEYBOARD_SHORTCUTS = [
  { keys: 'F11', whereEn: 'Any page', whereRu: 'Любая страница', whatEn: 'Toggle fullscreen mode (same as the Fullscreen button).', whatRu: 'Включить полноэкранный режим (как кнопка Fullscreen).' },
  { keys: 'Escape', whereEn: 'Any page', whereRu: 'Любая страница', whatEn: 'Exit fullscreen mode.', whatRu: 'Выйти из полноэкранного режима.' },
  { keys: 'Ctrl+0 (Cmd+0)', whereEn: 'Any page', whereRu: 'Любая страница', whatEn: 'Reset browser zoom to 100%.', whatRu: 'Сбросить масштаб браузера до 100%.' },
  { keys: 'Ctrl+Shift+S (Cmd+Shift+S)', whereEn: 'Any page', whereRu: 'Любая страница', whatEn: 'Take a screenshot of the active page (same as the Screenshot button).', whatRu: 'Сделать снимок экрана активной страницы (как кнопка Screenshot).' },
  { keys: 'Enter', whereEn: 'Console (teletype)', whereRu: 'Консоль (телетайп)', whatEn: 'Send a carriage return / line feed.', whatRu: 'Отправить возврат каретки / перевод строки.' },
  { keys: 'Backspace', whereEn: 'Console (teletype)', whereRu: 'Консоль (телетайп)', whatEn: 'Send a rubout (DEL) character.', whatRu: 'Отправить символ rubout (DEL).' },
  { keys: 'Ctrl+C', whereEn: 'Console / terminal', whereRu: 'Консоль / терминал', whatEn: 'Send the interrupt signal to the guest OS.', whatRu: 'Отправить сигнал прерывания гостевой ОС.' },
  { keys: 'Ctrl+Z', whereEn: 'Console / terminal', whereRu: 'Консоль / терминал', whatEn: 'Send the suspend signal to the guest OS.', whatRu: 'Отправить сигнал приостановки гостевой ОС.' },
  { keys: 'Page Up / Page Down', whereEn: 'Console / terminal', whereRu: 'Консоль / терминал', whatEn: 'Scroll the terminal output history.', whatRu: 'Прокрутить историю вывода терминала.' },
];

// The chapters this guide actually renders, in reading order. MANUAL_SECTIONS is
// generated from docs/manual/_meta.yml and lists all sixteen chapters — About and
// Glossary are among them but are not part of this guide (About is what the
// landing itself says about the project, the Glossary is a reference list the
// manual page owns). Offering a chapter that is not here produced a menu entry
// that scrolled nowhere, because scrollToSection() silently does nothing when the
// anchor is not in the page.
const GUIDE_CHAPTERS = [
  'quick-start',
  'front-panel',
  'console',
  'user-terminals',
  'printer',
  'vt11',
  'storage',
  'machine-state',
  'config',
  'guest-oses',
  'controls',
  'troubleshooting',
  'fidelity',
  'desktop',
];

// What the table of contents and the search offer: those chapters, in the
// manual's order. They are numbered 1..N from this list, not by the manual's own
// numbers — the manual counts sixteen chapters and puts About first, so its
// numbering never matched the §N labels of the sections below.
const GUIDE_SECTIONS = MANUAL_SECTIONS.filter(
  (sec) => GUIDE_CHAPTERS.indexOf(sec.id) !== -1
);

interface UserManualProps {
  lang: 'en' | 'ru';
  onBackToHome: () => void;
  onOpenEmulator: () => void;
}

export function UserManual({ lang, onBackToHome, onOpenEmulator }: UserManualProps) {
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeConfigTab, setActiveConfigTab] = useState<string>('equipment');
  const [lightboxSlide, setLightboxSlide] = useState<SlideItem | null>(null);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSnippet(id);
    setTimeout(() => {
      setCopiedSnippet((prev) => (prev === id ? null : prev));
    }, 2000);
  };

  const openImage = (src: string, title: string, caption?: string) => {
    setLightboxSlide({
      id: src,
      title,
      caption: caption || title,
      image: src,
      alt: title,
      description: caption || '',
    });
  };

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Full-manual search: section titles (EN/RU), subsection titles and a
  // curated keyword list per section, so a query like "teletype", "lp11",
  // "boot rp1" or "save" jumps to the right place instead of silently
  // filtering a table the user cannot see.
  const SECTION_KEYWORDS: Record<string, string[]> = {
    'quick-start': ['boot', 'wizard', 'magic wand', 'root', 'login', 'get started', 'launch'],
    'front-panel': ['switches', 'toggle', 'power', 'lock', 'panel', 'lights', 'odt'],
    'console': ['teletype', 'asr', 'keyboard', 'paper', 'vt52 console', 'vt100 console', 'vt100', 'ansi', 'decscope', 'type'],
    'user-terminals': ['tty', 'terminal', 'terminals', 'users', 'vt100', 'ansi'],
    'printer': ['lp11', 'print', 'paper feed'],
    'vt11': ['display', 'vector', 'graphics', 'lander', 'crv'],
    'storage': ['disk', 'tape', 'ptap', 'image', 'dsk', 'mount', 'unmount', 'reader', 'punch', 'drop', 'zst', 'zstd', 'export', 'write-back', 'indexeddb', 'rk', 'rl', 'rp', 'ra', 'tm'],
    'machine-state': ['save', 'load', 'snapshot', 'state', 'restore', 'share', 'gist', 'github', 'pat', 'token', 'export', 'import', 'clipboard', 'envelope'],
    'config': ['settings', 'options', 'equipment', 'tabs', 'speed', 'sound'],
    'guest-oses': ['os', 'operating system', 'boot rk', 'boot rp', 'boot rl', 'unix', 'rt-11', 'rsx', 'rsts', 'bsd', 'xxdp', 'basic'],
    'controls': ['button', 'shortcut', 'indicator', 'reboot', 'mute', 'fullscreen', 'magic'],
    'troubleshooting': ['problem', 'fix', 'error', 'help', 'cors', 'blank screen', 'blank', 'keyboard', 'does not type', 'no sound', 'mute', 'performance', 'slow', 'snapshot refused', 'own copy', 'local disk', 'portable', 'will not boot', 'does not boot'],
    'desktop': ['tauri', 'install', 'app', 'download'],
  };

  const sectionMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const out: { id: string; titleEn: string; titleRu: string }[] = [];
    for (const sec of GUIDE_SECTIONS) {
      const names = sec.id === 'controls' ? FLOATING_CONTROL_NAMES : [];
      const kw = (SECTION_KEYWORDS[sec.id] || []).concat(names).join(' ').toLowerCase();
      const sub = (sec.subsections || []).map((x) => x.titleEn + ' ' + x.titleRu).join(' ').toLowerCase();
      const hay = (sec.titleEn + ' ' + sec.titleRu + ' ' + sub + ' ' + kw).toLowerCase();
      if (hay.includes(q)) {
        out.push({ id: sec.id, titleEn: sec.titleEn, titleRu: sec.titleRu });
      }
    }
    return out.slice(0, 8);
  }, [searchQuery]);

  const filteredOsList = useMemo(() => {
    if (!searchQuery.trim()) return GUEST_OS_TABLE;
    const q = searchQuery.toLowerCase();
    return GUEST_OS_TABLE.filter(
      (os) =>
        os.name.toLowerCase().includes(q) ||
        os.disk.toLowerCase().includes(q) ||
        os.bootCommand.toLowerCase().includes(q) ||
        os.instructionsEn.toLowerCase().includes(q) ||
        os.instructionsRu.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  return (
    <div className="space-y-10">
      {/* Lightbox when clicking images */}
      {lightboxSlide && (
        <Lightbox
          slide={lightboxSlide}
          currentIndex={0}
          totalSlides={1}
          onClose={() => setLightboxSlide(null)}
        />
      )}


      {/* Manual Hero Header */}
      <div className="text-center pt-2 pb-6 border-b border-[#3a3528]/80">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#524939] bg-[#14120e] text-xs text-[#c8a860] mb-3 font-mono">
          <BookOpen className="w-3.5 h-3.5 text-[#e8d080]" />
          <span>DEC PDP-11/70 SIMULATOR · USER GUIDE</span>
        </div>

        <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight text-[#f0e6c8] mb-3">
          {lang === 'en' ? 'yaPDP — User Manual' : 'yaPDP — Руководство пользователя'}
        </h1>

        <p className="text-[#c8b890] italic text-sm sm:text-base max-w-2xl mx-auto mb-2 leading-relaxed">
          {lang === 'en'
            ? 'Welcome to the machine. This guide walks you through every page of the emulator — from the very first boot to the deepest configuration options — so you can spend your time in the machine room, not in the documentation.'
            : 'Добро пожаловать в машинный зал. Это руководство подробно описывает каждую страницу эмулятора — от первого включения до тонких настроек оборудования — чтобы вы работали за пультом PDP-11, а не блуждали по документации.'}
        </p>

        <p className="text-xs sm:text-sm text-[#8a7650] font-mono mb-6">
          {lang === 'en'
            ? 'Everything below applies to both the in-browser emulator and the standalone desktop app.'
            : 'Всё описанное ниже в равной мере относится как к браузерной версии, так и к автономному десктопному приложению.'}
        </p>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <button
            onClick={onBackToHome}
            type="button"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold uppercase tracking-wider rounded border border-[#524939] bg-[#1e1a14] hover:bg-[#2a241b] text-[#d4c4a0] hover:text-[#f0e6c8] transition-all cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5 text-[#c8a860]" />
            <span>{lang === 'en' ? 'Back to Overview' : 'Назад к обзору'}</span>
          </button>

          <button
            onClick={onOpenEmulator}
            type="button"
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider rounded border border-[#c8a860] bg-gradient-to-b from-[#5a4a30] to-[#3a3528] hover:from-[#6a5838] hover:to-[#4a4030] text-[#f0e6c8] hover:text-[#fff6e0] shadow-sm transition-all cursor-pointer"
          >
            <Terminal className="w-3.5 h-3.5 text-[#e8d080]" />
            <span>{lang === 'en' ? 'Launch Emulator' : 'Запустить эмулятор'}</span>
          </button>

        </div>
      </div>

      {/* Search & Quick Filter Bar */}
      <div className="relative max-w-xl mx-auto">
        <div className="relative flex items-center">
          <Search className="absolute left-3.5 w-4 h-4 text-[#8a7650] pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={
              lang === 'en'
                ? 'Search manual (e.g. boot rp1, switches, LP11, teletype, root)...'
                : 'Поиск по руководству (например: boot rp1, тумблеры, LP11, телетайп)...'
            }
            className="w-full pl-10 pr-10 py-2 text-xs sm:text-sm bg-[#13110d] border border-[#4a453a] rounded-lg text-[#e0d8c8] placeholder-[#736348] focus:outline-none focus:border-[#c8a860] focus:ring-1 focus:ring-[#c8a860] transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 text-xs text-[#8a7650] hover:text-[#f0e6c8]"
            >
              ✕
            </button>
          )}
        </div>

        {sectionMatches.length > 0 && (
          <div className="relative max-w-xl mx-auto">
            <div className="absolute z-30 mt-1 w-full rounded-lg border border-[#4a453a] bg-[#16130e] shadow-xl overflow-hidden">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[#8a7650] font-mono border-b border-[#3a3528]">
                {lang === 'en' ? 'Manual sections' : 'Разделы руководства'}
              </div>
              {sectionMatches.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setSearchQuery('');
                    scrollToSection(m.id);
                  }}
                  className="w-full text-left px-3 py-2 text-xs text-[#d4c4a0] hover:bg-[#221d15] hover:text-[#f0e6c8] transition-colors cursor-pointer flex items-center gap-2"
                >
                  <BookOpen className="w-3 h-3 text-[#c8a860] shrink-0" />
                  {lang === 'en' ? m.titleEn : m.titleRu}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Table of Contents Grid */}
      <div className="rounded-lg border border-[#4a453a] bg-[#14120e]/90 p-4 sm:p-5 shadow-md">
        <div className="flex items-center justify-between pb-3 border-b border-[#3a3528] mb-4">
          <h2 className="text-base sm:text-lg font-bold text-[#f0e6c8] flex items-center gap-2">
            <Sliders className="w-4 h-4 text-[#c8a860]" />
            {lang === 'en' ? 'Table of Contents' : 'Оглавление руководства'}
          </h2>
          <span className="text-[11px] text-[#8a7650] font-mono">{GUIDE_SECTIONS.length} SECTIONS</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
          {GUIDE_SECTIONS.map((sec, idx) => (
            <button
              key={sec.id}
              onClick={() => scrollToSection(sec.id)}
              className="text-left px-3 py-2 rounded bg-[#1c1914] hover:bg-[#25211a] border border-[#3a3528]/80 hover:border-[#c8a860]/60 transition-all text-xs text-[#d4c4a0] hover:text-[#f0e6c8] flex items-center gap-2 cursor-pointer group"
            >
              <span className="font-mono text-[11px] text-[#c8a860] font-bold group-hover:text-[#e8d080]">
                {idx + 1}.
              </span>
              <span className="truncate">{lang === 'en' ? sec.titleEn : sec.titleRu}</span>
            </button>
          ))}
        </div>
      </div>

      {/* SECTION 1: QUICK START */}
      <section id="quick-start" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§1</span>
            {lang === 'en' ? 'Quick Start' : 'Быстрый старт'}
          </h2>
          <button
            onClick={() => scrollToSection('classic-way')}
            className="text-xs text-[#c8a860] hover:text-[#e8d080] font-mono"
          >
            {lang === 'en' ? 'Jump to Classic Way ↓' : 'Классический способ ↓'}
          </button>
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'On your very first launch the emulator greets you with a short onboarding hint that explains what to do right away — which page to open, the mounted guest OSes and their boot commands:'
            : 'При первом запуске эмулятор встречает вас вступительной подсказкой, объясняющей базовые действия — какую вкладку открыть, какие гостевые ОС подключены и как их запустить:'}
        </p>

        {/* Screenshot card: Onboarding */}
        <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2 sm:p-3 shadow-md">
          <div
            onClick={() =>
              openImage(
                'assets/images/manual/dialog-onboarding.png',
                lang === 'en' ? 'First-run onboarding hint' : 'Подсказка при первом запуске'
              )
            }
            className="cursor-pointer overflow-hidden rounded border border-[#2a251e] group relative"
          >
            <img
              src="assets/images/manual/dialog-onboarding.png"
              alt="First-run onboarding hint"
              className="w-full h-auto object-contain transition-transform group-hover:scale-[1.01]"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
              <span className="bg-[#12100d]/90 text-[#f0e6c8] text-xs px-3 py-1.5 rounded border border-[#c8a860] flex items-center gap-1.5 font-mono">
                <Maximize2 className="w-3.5 h-3.5 text-[#e8d080]" />
                {lang === 'en' ? 'Click to Enlarge' : 'Увеличить скриншот'}
              </span>
            </div>
          </div>
          <p className="mt-2 text-center text-xs text-[#8a7650] italic">
            {lang === 'en' ? 'The first-run onboarding hint.' : 'Окно быстрой подсказки при первом запуске.'}
          </p>
        </div>

        {/* Subsection: The magic wand */}
        <div id="magic-wand" className="pt-2 space-y-3">
          <h3 className="text-lg font-bold text-[#e8d080] flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#c8a860]" />
            {lang === 'en' ? 'The magic wand' : 'Волшебная палочка'}
          </h3>

          <p className="text-sm leading-relaxed text-[#c8b890]">
            {lang === 'en' ? (
              <>
                <strong className="text-[#f0e6c8]">In a hurry?</strong> Use the{' '}
                <strong className="text-[#c8a860]">magic wand</strong> button in the top-right corner of
                the window. It stays on every page except <strong className="text-[#f0e6c8]">Info</strong>.
                One click does everything:
              </>
            ) : (
              <>
                <strong className="text-[#f0e6c8]">Спешите?</strong> Используйте кнопку{' '}
                <strong className="text-[#c8a860]">«Волшебная палочка»</strong> в правом верхнем углу окна.
                Она доступна на любой вкладке, кроме <strong className="text-[#f0e6c8]">Info</strong>. Один
                клик делает всё необходимое:
              </>
            )}
          </p>

          <ol className="list-decimal list-inside space-y-2 text-sm text-[#d4c4a0] pl-2 font-sans">
            <li>
              {lang === 'en'
                ? 'Opens a picker listing every guest operating system (and simulated paper tapes).'
                : 'Открывает меню со всеми гостевыми операционными системами (и перфолентами).'}
            </li>
            <li>
              {lang === 'en'
                ? 'Chooses one, switches to the operator console, and reboots the machine.'
                : 'Выбирает систему, переключает на консоль оператора и перезагружает PDP-11.'}
            </li>
            <li>
              {lang === 'en' ? (
                <>
                  Types the <code className="text-[#e8d080]">boot &lt;device&gt;</code> command — and the
                  login credentials too (e.g. Unix V5:{' '}
                  <code className="text-[#e8d080]">boot rk0</code> → <code className="text-[#e8d080]">unix</code>{' '}
                  → login <code className="text-[#e8d080]">root</code>).
                </>
              ) : (
                <>
                  Автоматически набирает команду <code className="text-[#e8d080]">boot &lt;устройство&gt;</code>{' '}
                  и учетные данные входа (например, Unix V5:{' '}
                  <code className="text-[#e8d080]">boot rk0</code> → <code className="text-[#e8d080]">unix</code>{' '}
                  → логин <code className="text-[#e8d080]">root</code>).
                </>
              )}
            </li>
          </ol>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 my-3">
            <div className="rounded border border-[#4a453a] bg-[#12100d] p-2">
              <img
                src="assets/images/manual/dialog-quickboot.png"
                alt="Quick boot picker"
                className="w-full h-auto rounded cursor-pointer hover:opacity-95"
                onClick={() =>
                  openImage('assets/images/manual/dialog-quickboot.png', 'Quick boot picker')
                }
              />
              <p className="mt-1.5 text-center text-[11px] text-[#8a7650] italic">
                {lang === 'en'
                  ? 'The quick-boot picker lists every guest OS and paper tape.'
                  : 'Меню быстрого выбора гостевой ОС и перфолент.'}
              </p>
            </div>

            <div className="rounded border border-[#4a453a] bg-[#12100d] p-2">
              <img
                src="assets/images/manual/dialog-autoload.png"
                alt="Autoloading in progress toast"
                className="w-full h-auto rounded cursor-pointer hover:opacity-95"
                onClick={() =>
                  openImage('assets/images/manual/dialog-autoload.png', 'Autoloading in progress toast')
                }
              />
              <p className="mt-1.5 text-center text-[11px] text-[#8a7650] italic">
                {lang === 'en'
                  ? 'Autoload locks input; Take control! stops it and returns the machine.'
                  : 'Автозагрузка блокирует ввод; Take control! останавливает её и возвращает машину.'}
              </p>
            </div>
          </div>

          <div className="rounded border-l-4 border-[#c8a860] bg-[#13110d] p-3 text-xs text-[#d4c4a0] leading-relaxed">
            <span className="text-[#e8d080] font-bold">
              {lang === 'en' ? 'Prompt-aware wizard: ' : 'Умный мастер ввода: '}
            </span>
            {lang === 'en'
              ? 'The wizard watches console output and types the login only when the guest prints "login:", ensuring slow boots with heavy disk I/O (like 2.11 BSD) finish reliably. Guests also automatically configure required peripherals (e.g. LP11 line printer for RT-11/RSX, or teletype console for Unix V5).'
              : 'Мастер отслеживает вывод консоли и вводит логин только тогда, когда гостевая ОС напечатает "login:". Это гарантирует надежность при медленной загрузке BSD 2.11. Кроме того, мастер автоматически настраивает необходимое оборудование (например, принтер LP11 для RT-11/RSX или телетайп для Unix V5).'}
          </div>

          <div className="rounded border-l-4 border-[#c8a860] bg-[#13110d] p-3 text-xs text-[#d4c4a0] leading-relaxed">
            <span className="text-[#e8d080] font-bold">
              {lang === 'en' ? 'Take control: ' : 'Взять управление: '}
            </span>
            {lang === 'en'
              ? 'While the wizard types, the emulator ignores the keyboard and the mouse — console, terminals and front panel alike — so nothing you type can race its characters into the console. Until it finishes, the only way out is the toast\u2019s "Take control!" button, which stops the autoload and hands the machine back to you. Disk and tape images can take a while to download on a slow link: a thin "Loading N%" bar along the bottom of the window shows the progress.'
              : 'Пока мастер печатает, эмулятор игнорирует клавиатуру и мышь — консоль, терминалы и пульт, — так что ваши символы не вклинятся в его ввод. До окончания единственный выход — кнопка "Take control!" в уведомлении: она прерывает автозагрузку и возвращает машину вам. Образы дисков и лент на медленном канале загружаются не сразу: тонкая полоса "Loading N%" внизу окна показывает прогресс.'}
          </div>
        </div>

        {/* Subsection: The Scenario tab */}
        <div id="scenario-tab" className="pt-2 space-y-3">
          <h3 className="text-lg font-bold text-[#e8d080] flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-[#c8a860]" />
            {lang === 'en' ? 'The Scenario tab' : 'Вкладка Scenario'}
          </h3>

          <p className="text-sm leading-relaxed text-[#c8b890]">
            {lang === 'en' ? (
              <>
                The wizard has two tabs. <strong className="text-[#f0e6c8]">Boot</strong> is the list
                above: a boot command is typed into a fresh machine.{' '}
                <strong className="text-[#f0e6c8]">Scenario</strong> restores a machine state saved in
                this build — the guest is already running, so it opens in about a second instead of
                taking the full boot. Click a card to restore it, exactly like a{' '}
                <code className="text-[#e8d080]">?state=</code> link (see{' '}
                <button
                  type="button"
                  onClick={() => scrollToSection('machine-state')}
                  className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
                >
                  Machine State
                </button>
                ); a state that carries a screenshot shows a thumbnail, and clicking the thumbnail
                opens the full picture without leaving the page.
              </>
            ) : (
              <>
                В мастере две вкладки. <strong className="text-[#f0e6c8]">Boot</strong> — это список
                выше: команда загрузки вводится в свежую машину.{' '}
                <strong className="text-[#f0e6c8]">Scenario</strong> восстанавливает состояние машины,
                сохранённое в этой сборке, — гость уже работает, поэтому открывается примерно за
                секунду вместо полной загрузки. Нажмите карточку, чтобы восстановить состояние, точно
                так же, как ссылка <code className="text-[#e8d080]">?state=</code> (см.{' '}
                <button
                  type="button"
                  onClick={() => scrollToSection('machine-state')}
                  className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
                >
                  Состояние машины
                </button>
                ); у состояния со снимком экрана есть миниатюра, а щелчок по ней открывает снимок
                целиком, не покидая страницу.
              </>
            )}
          </p>

          <p className="text-sm leading-relaxed text-[#c8b890]">
            {lang === 'en'
              ? 'The list is generated from the actual state files of this build, so it always matches what ships. On a host without that list the tab simply has nothing to offer.'
              : 'Список генерируется по фактическим файлам состояний этой сборки, поэтому всегда совпадает с тем, что в ней поставляется. На хосте без такого списка вкладке просто нечего предложить.'}
          </p>
        </div>

        {/* Subsection: The classic way */}
        <div id="classic-way" className="pt-2 space-y-3">
          <h3 className="text-lg font-bold text-[#e8d080] flex items-center gap-2">
            <Terminal className="w-4 h-4 text-[#c8a860]" />
            {lang === 'en' ? 'The classic way' : 'Классический способ'}
          </h3>

          <div className="rounded-lg border border-[#4a453a] bg-[#13110d] p-4 space-y-3">
            <div className="flex items-start gap-3">
              <span className="font-mono text-xs font-bold text-[#c8a860] bg-[#221e17] px-2 py-0.5 rounded border border-[#524939]">
                STEP 1
              </span>
              <div className="flex-1">
                <p className="text-xs text-[#d4c4a0] mb-1">
                  {lang === 'en'
                    ? 'At the @ prompt, type the boot command and press ENTER:'
                    : 'В приглашении @ введите команду загрузки и нажмите ENTER:'}
                </p>
                <div className="flex items-center justify-between bg-black/60 rounded px-3 py-1.5 font-mono text-xs text-[#e8d080] border border-[#3a3528]">
                  <span>boot rp1</span>
                  <button
                    onClick={() => handleCopy('boot rp1', 'boot-rp1')}
                    className="text-[#8a7650] hover:text-[#f0e6c8] flex items-center gap-1 text-[11px]"
                  >
                    {copiedSnippet === 'boot-rp1' ? (
                      <Check className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    <span>{copiedSnippet === 'boot-rp1' ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <span className="font-mono text-xs font-bold text-[#c8a860] bg-[#221e17] px-2 py-0.5 rounded border border-[#524939]">
                STEP 2
              </span>
              <div className="flex-1">
                <p className="text-xs text-[#d4c4a0] mb-1">
                  {lang === 'en'
                    ? 'BSD 2.11 will autoboot into multiuser mode. Login as root (no password required):'
                    : 'BSD 2.11 загрузится в многопользовательский режим. Войдите под пользователем root:'}
                </p>
                <div className="flex items-center justify-between bg-black/60 rounded px-3 py-1.5 font-mono text-xs text-[#e8d080] border border-[#3a3528]">
                  <span>login: root</span>
                  <button
                    onClick={() => handleCopy('root', 'login-root')}
                    className="text-[#8a7650] hover:text-[#f0e6c8] flex items-center gap-1 text-[11px]"
                  >
                    {copiedSnippet === 'login-root' ? (
                      <Check className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    <span>{copiedSnippet === 'login-root' ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <span className="font-mono text-xs font-bold text-[#c8a860] bg-[#221e17] px-2 py-0.5 rounded border border-[#524939]">
                STEP 3
              </span>
              <div className="flex-1">
                <p className="text-xs text-[#d4c4a0]">
                  {lang === 'en' ? (
                    <>
                      Explore Unix commands: <code className="text-[#e8d080]">ls -la</code>,{' '}
                      <code className="text-[#e8d080]">ps -aux</code>, <code className="text-[#e8d080]">df</code>
                      , or compile vintage C programs using <code className="text-[#e8d080]">cc</code>.
                    </>
                  ) : (
                    <>
                      Исследуйте команды Unix: <code className="text-[#e8d080]">ls -la</code>,{' '}
                      <code className="text-[#e8d080]">ps -aux</code>, <code className="text-[#e8d080]">df</code>{' '}
                      или компилируйте программы на Си с помощью <code className="text-[#e8d080]">cc</code>.
                    </>
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 2: THE FRONT PANEL */}
      <section id="front-panel" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§2</span>
            {lang === 'en' ? 'The Front Panel (Panel page)' : 'Пультовая панель (страница Panel)'}
          </h2>
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'Every switch, LED, and rotary knob of a real PDP‑11/70 is faithfully recreated. The Panel page is where you toggle in a bootstrap loader the way DEC engineers did in the 1970s.'
            : 'Каждый тумблер, индикатор и поворотный переключатель реального PDP-11/70 воссоздан с абсолютной точностью. На странице Panel вы можете вводить начальный загрузчик переключением тумблеров, в точности как инженеры DEC в 1970-х годах.'}
        </p>

        <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2 shadow-md">
          <img
            src="assets/images/manual/panel.png"
            alt="The PDP-11/70 front panel"
            className="w-full h-auto rounded cursor-pointer"
            onClick={() =>
              openImage('assets/images/manual/panel.png', 'The PDP-11/70 front panel, powered on.')
            }
          />
          <p className="mt-1.5 text-center text-xs text-[#8a7650] italic">
            {lang === 'en' ? 'The PDP‑11/70 front panel, powered on.' : 'Пультовая панель PDP-11/70 во включенном состоянии.'}
          </p>
        </div>

        {/* Switch Sequences */}
        <div id="switch-sequences" className="pt-2 space-y-3">
          <h3 className="text-lg font-bold text-[#e8d080]">
            {lang === 'en' ? 'Front panel switch sequences' : 'Последовательности переключения тумблеров'}
          </h3>

          <div className="space-y-3">
            <div className="rounded border border-[#4a453a] bg-[#13110d] p-3.5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-[#f0e6c8]">
                  {lang === 'en' ? 'Light Chaser (Animated LED sequence):' : 'Бегущий огонь (анимация светодиодов):'}
                </span>
                <button
                  onClick={() =>
                    handleCopy(
                      'HALT, 001000, LOAD ADDRESS\n012700, DEPOSIT\n000001, DEPOSIT\n006100, DEPOSIT\n000005, DEPOSIT\n000775, DEPOSIT\n001000, LOAD ADDRESS, ENABLE, START',
                      'chaser'
                    )
                  }
                  className="text-xs text-[#c8a860] hover:text-[#e8d080] flex items-center gap-1 font-mono"
                >
                  {copiedSnippet === 'chaser' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  <span>{copiedSnippet === 'chaser' ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <pre className="text-xs font-mono text-[#e8d080] bg-black/60 p-2.5 rounded border border-[#3a3528] overflow-x-auto whitespace-pre">
                {`HALT, 001000, LOAD ADDRESS
012700, DEPOSIT
000001, DEPOSIT
006100, DEPOSIT
000005, DEPOSIT
000775, DEPOSIT
001000, LOAD ADDRESS, ENABLE, START`}
              </pre>
            </div>

            <div className="rounded border border-[#4a453a] bg-[#13110d] p-3.5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-[#f0e6c8]">
                  {lang === 'en' ? 'Restart the Bootloader:' : 'Перезапуск загрузчика:'}
                </span>
                <button
                  onClick={() =>
                    handleCopy('HALT, 120000, LOAD ADDRESS, ENABLE, START', 'bootloader')
                  }
                  className="text-xs text-[#c8a860] hover:text-[#e8d080] flex items-center gap-1 font-mono"
                >
                  {copiedSnippet === 'bootloader' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  <span>{copiedSnippet === 'bootloader' ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <pre className="text-xs font-mono text-[#e8d080] bg-black/60 p-2.5 rounded border border-[#3a3528] overflow-x-auto whitespace-pre">
                {`HALT, 120000, LOAD ADDRESS, ENABLE, START`}
              </pre>
            </div>
          </div>

          {/* Safety guard dialog */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center rounded border border-[#3a3528] bg-[#14120e] p-3">
            <div>
              <p className="text-xs text-[#c8b890] leading-relaxed">
                {lang === 'en' ? (
                  <>
                    The <strong className="text-[#f0e6c8]">Bootstrap now!</strong> button refuses to start
                    the machine while it is powered off, preventing accidental starts without power.
                  </>
                ) : (
                  <>
                    Кнопка <strong className="text-[#f0e6c8]">Bootstrap now!</strong> блокирует запуск машины,
                    если тумблер питания выключен, предотвращая случайный старт без питания.
                  </>
                )}
              </p>
            </div>
            <div>
              <img
                src="assets/images/manual/dialog-poweroff.png"
                alt="Bootstrap power-off guard"
                className="w-full h-auto rounded border border-[#4a453a] cursor-pointer"
                onClick={() =>
                  openImage('assets/images/manual/dialog-poweroff.png', 'Bootstrap now! requires power')
                }
              />
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 3: THE OPERATOR CONSOLE */}
      <section id="console" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§3</span>
            {lang === 'en' ? 'The Operator Console' : 'Консоль оператора'}
          </h2>
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en' ? (
            <>
              The operator console is what the PDP‑11 uses as its <code className="text-[#e8d080]">TT0:</code>{' '}
              — the machine's primary typewriter interface. Depending on the CONFIG page it is a{' '}
              <strong className="text-[#f0e6c8]">Model 33 ASR teletype</strong> or one of the two video
              terminals: a <strong className="text-[#f0e6c8]">DECscope VT52</strong> or a{' '}
              <strong className="text-[#f0e6c8]">DEC VT100</strong>.
            </>
          ) : (
            <>
              Консоль оператора используется PDP-11 как устройство{' '}
              <code className="text-[#e8d080]">TT0:</code> — основная печатная машинка системы. В
              зависимости от настроек на странице CONFIG, консолью является{' '}
              <strong className="text-[#f0e6c8]">телетайп Model 33 ASR</strong> либо один из двух
              видеотерминалов: <strong className="text-[#f0e6c8]">DECscope VT52</strong> или{' '}
              <strong className="text-[#f0e6c8]">DEC VT100</strong>.
            </>
          )}
        </p>

        {/* Model 33 ASR */}
        <div id="teletype" className="space-y-3">
          <h3 className="text-lg font-bold text-[#e8d080]">
            {lang === 'en' ? 'Model 33 ASR teletype' : 'Телетайп Model 33 ASR'}
          </h3>

          <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2">
            <img
              src="assets/images/manual/console-teletype.png"
              alt="Model 33 ASR teletype console"
              className="w-full h-auto rounded cursor-pointer"
              onClick={() =>
                openImage(
                  'assets/images/manual/console-teletype.png',
                  'The Model 33 ASR operator console at the @ prompt'
                )
              }
            />
            <p className="mt-1.5 text-center text-xs text-[#8a7650] italic">
              {lang === 'en'
                ? 'The Model 33 ASR operator console at the @ prompt.'
                : 'Консоль оператора Model 33 ASR со строкой приглашения @.'}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="rounded border border-[#3a3528] bg-[#13110d] p-3 space-y-1">
              <span className="font-bold text-[#f0e6c8] block mb-1">
                {lang === 'en' ? 'Authentic Keycaps & Keys' : 'Аутентичная клавиатура'}
              </span>
              <p className="text-[#c8b890] leading-relaxed">
                {lang === 'en'
                  ? 'Round dark keycaps with light two-line legends (base glyph + CTRL/shift code), plus ESC, LINE FEED, RETURN, DELETE, HERE IS, REPT and BREAK (DL11 break condition).'
                  : 'Круглые темные клавиши с двухстрочной гравировкой символов, плюс специальные клавиши ESC, LINE FEED, RETURN, DELETE, HERE IS (автоответчик), REPT и BREAK.'}
              </p>
            </div>

            <div className="rounded border border-[#3a3528] bg-[#13110d] p-3 space-y-1">
              <span className="font-bold text-[#f0e6c8] block mb-1">
                {lang === 'en' ? 'Hardcopy Overstrike (^H)' : 'Оверстрайк и печать на бумаге'}
              </span>
              <p className="text-[#c8b890] leading-relaxed">
                {lang === 'en'
                  ? 'Authentic nroff/man overstrike rendering: re-printing the same glyph gives bold, underscores give underline, and different glyphs leave real ink blots.'
                  : 'Честная симуляция оверстрайка: повторный удар литеры создает жирный шрифт, символ подчеркивания выделяет текст, а разные буквы образуют реальную кляксу типографской ленты.'}
              </p>
            </div>

            <div className="rounded border border-[#3a3528] bg-[#13110d] p-3 space-y-1">
              <span className="font-bold text-[#f0e6c8] block mb-1">
                {lang === 'en' ? 'Physical Margins (72/80 cols)' : 'Поля и каретка'}
              </span>
              <p className="text-[#c8b890] leading-relaxed">
                {lang === 'en'
                  ? 'Long lines faithfully jam the carriage at the right margin; characters overstrike the last column instead of modern wrapping. Paper rises out of the machine upward.'
                  : 'Длинные строки стопорят каретку у правого поля; символы впечатываются в последнюю колонку без автоматического переноса, а бумажный рулон растет вверх.'}
              </p>
            </div>

            <div className="rounded border border-[#3a3528] bg-[#13110d] p-3 space-y-1">
              <span className="font-bold text-[#f0e6c8] block mb-1">
                {lang === 'en' ? 'ASR-33 Reader / Punch' : 'Перфоратор и считыватель ASR'}
              </span>
              <p className="text-[#c8b890] leading-relaxed">
                {lang === 'en'
                  ? 'Beside the machine sits the 8-track paper tape reader/punch unit (tracks 1–7 = ASCII, track 8 = parity). Can be enabled via CONFIG. Both hanging tapes swing on every step of the mechanism, and a tape that reaches the bottom of the window is scrolled with the mouse wheel — neither tape draws a scrollbar.'
                  : 'Рядом с кареткой расположен блок 8-дорожечного перфоратора перфоленты (дорожки 1–7 = ASCII, 8 = четность). Включается на странице CONFIG. Обе висящие ленты покачиваются на каждом шаге механизма, а лента, дошедшая до низа окна, прокручивается колесиком мыши — полоса прокрутки не рисуется.'}
              </p>
            </div>
          </div>
        </div>

        {/* VT52 as console */}
        <div id="vt52-console" className="pt-3 space-y-3">
          <h3 className="text-lg font-bold text-[#e8d080]">
            {lang === 'en' ? 'VT52 as the console' : 'VT52 в качестве консоли'}
          </h3>

          <p className="text-sm text-[#c8b890]">
            {lang === 'en'
              ? 'When the console terminal is set to VT52, the operator console becomes a DECscope with authentic white/grey (P4) phosphor on a black tube.'
              : 'Когда консоль настроена на VT52, оператор получает видеотерминал DECscope с аутентичным белым/серым люминофором P4 на черном кинескопе.'}
          </p>

          <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2">
            <img
              src="assets/images/manual/console-vt52.png"
              alt="A DECscope VT52 as the operator console"
              className="w-full h-auto rounded cursor-pointer"
              onClick={() =>
                openImage('assets/images/manual/console-vt52.png', 'A DECscope VT52 as the operator console')
              }
            />
          </div>
        </div>

        {/* VT100 as console */}
        <div id="vt100-console" className="pt-3 space-y-3">
          <h3 className="text-lg font-bold text-[#e8d080]">
            {lang === 'en' ? 'VT100 as the console' : 'VT100 в качестве консоли'}
          </h3>

          <p className="text-sm text-[#c8b890]">
            {lang === 'en'
              ? 'Set the console terminal to VT100 and the operator console becomes a DEC VT100 — the ANSI terminal that succeeded the DECscope, drawn in its OWN cabinet. Everything that is not the tube itself is shared with the VT52: the page layout, the zoom button and double-click zoom, the STATE/REBOOT placement and the keyboard.'
              : 'Если выбрать VT100, консолью оператора становится DEC VT100 — ANSI-терминал, пришедший на смену DECscope, в собственном корпусе. Всё, кроме самого кинескопа, общее с VT52: раскладка страницы, кнопка масштаба и двойной щелчок, размещение STATE/REBOOT и клавиатура.'}
          </p>

          <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2">
            <img
              src="assets/images/manual/console-vt100.png"
              alt="A DEC VT100 as the operator console"
              className="w-full h-auto rounded cursor-pointer"
              onClick={() =>
                openImage('assets/images/manual/console-vt100.png', 'A DEC VT100 as the operator console')
              }
            />
            <p className="mt-1.5 text-center text-xs text-[#8a7650] italic">
              {lang === 'en'
                ? 'A DEC VT100 as the operator console, showing the @ prompt.'
                : 'Консоль оператора DEC VT100 со строкой приглашения @.'}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="rounded border border-[#3a3528] bg-[#13110d] p-3 space-y-1">
              <span className="font-bold text-[#f0e6c8] block mb-1">
                {lang === 'en' ? 'A superset of the VT52' : 'Надмножество VT52'}
              </span>
              <p className="text-[#c8b890] leading-relaxed">
                {lang === 'en'
                  ? 'Everything the DECscope understands still works, and the terminal adds the ANSI grammar (CSI sequences, DEC private modes, scrolling regions, G0/G1 character sets) from power-on: a VT100 is a CRT-only machine and has no hardcopy mode to enter first.'
                  : 'Всё, что понимал DECscope, продолжает работать, а сверху терминал говорит на ANSI (CSI-последовательности, DEC private modes, области прокрутки, наборы G0/G1) сразу после включения: VT100 работает только на экран и режима hardcopy у него нет.'}
              </p>
            </div>

            <div className="rounded border border-[#3a3528] bg-[#13110d] p-3 space-y-1">
              <span className="font-bold text-[#f0e6c8] block mb-1">
                {lang === 'en' ? 'Refused, not faked' : 'Отказ, а не подделка'}
              </span>
              <p className="text-[#c8b890] leading-relaxed">
                {lang === 'en'
                  ? 'Sequences the hardware never had are refused rather than simulated: ESC Y direct addressing, ESC F/G graphics on/off, the VT52 keypad modes and the VT52 identification reply. Asked who it is (CSI c), the VT100 answers "VT100 with AVO", and CSI ? 2 h (DECANM) drops it into VT52 compatibility mode.'
                  : 'Последовательности, которых у железа не было, отвергаются, а не имитируются: прямое позиционирование ESC Y, включение/выключение графики ESC F/G, режимы клавиатуры VT52 и ответ VT52 на идентификацию. На запрос CSI c терминал отвечает «VT100 with AVO», а CSI ? 2 h (DECANM) переводит его в режим совместимости с VT52.'}
              </p>
            </div>

            <div className="rounded border border-[#3a3528] bg-[#13110d] p-3 space-y-1">
              <span className="font-bold text-[#f0e6c8] block mb-1">
                {lang === 'en' ? 'Its own CONFIG options' : 'Свои опции в CONFIG'}
              </span>
              <p className="text-[#c8b890] leading-relaxed">
                {lang === 'en'
                  ? 'The tube phosphor (P4 white — the phosphor it was introduced on — or P1 green) and the key click belong to the VT100 alone: the DECscope is pinned to white and its keyboard was mechanical, with no click to make. The VT52 reverse-video switch never touches a VT100, where inverse text comes from the SGR 7 attribute instead.'
                  : 'Люминофор кинескопа (белый P4 — с ним терминал и выпускался — или зелёный P1) и щелчок клавиш принадлежат только VT100: у DECscope люминофор всегда белый, а клавиатура механическая и щёлкать ей нечем. Переключатель инверсного видео VT52 на VT100 не влияет — инверсию там даёт атрибут SGR 7.'}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 4: USER TERMINALS */}
      <section id="user-terminals" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§4</span>
            {lang === 'en' ? 'User Terminals (TTY 1 / TTY 2)' : 'Пользовательские терминалы (TTY 1 / TTY 2)'}
          </h2>
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'Up to two user video terminals (configured on the CONFIG page) allow multiuser guest operating systems like 2.11 BSD, Ultrix and RSTS/E to run simultaneous interactive sessions side by side. Each is a DECscope VT52 or a DEC VT100, chosen independently (None | VT52 | VT100), and each is drawn in the cabinet of the terminal you picked — the DECscope slanted monoblock with its vent grille and recessed bezel, or the VT100 enclosure. Input comes from the physical keyboard, as on the originals.'
            : 'До двух пользовательских видеотерминалов (настраиваются на странице CONFIG) позволяют многопользовательским ОС (2.11 BSD, Ultrix, RSTS/E) запускать параллельные сеансы работы. Каждый из них — DECscope VT52 или DEC VT100, выбирается независимо (None | VT52 | VT100) и рисуется в корпусе выбранного терминала: скошенный моноблок DECscope с вентиляционной решеткой и углубленным экраном либо собственный корпус VT100. Ввод идёт с физической клавиатуры, как на оригиналах.'}
        </p>

        <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2">
          <img
            src="assets/images/manual/terminal-vt52.png"
            alt="A user VT52 terminal"
            className="w-full h-auto rounded cursor-pointer"
            onClick={() =>
              openImage('assets/images/manual/terminal-vt52.png', 'A user VT52 terminal (TTY 1)')
            }
          />
        </div>

        <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2">
          <img
            src="assets/images/manual/terminal-vt100.png"
            alt="A user VT100 terminal"
            className="w-full h-auto rounded cursor-pointer"
            onClick={() =>
              openImage('assets/images/manual/terminal-vt100.png', 'A user VT100 terminal (TTY 2)')
            }
          />
          <p className="mt-1.5 text-center text-xs text-[#8a7650] italic">
            {lang === 'en'
              ? 'A user VT100 terminal (TTY 2) — same page, same behaviour, its own cabinet.'
              : 'Пользовательский терминал VT100 (TTY 2) — та же страница и то же поведение, но собственный корпус.'}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="rounded border border-[#3a3528] bg-[#13110d] p-3">
            <strong className="text-[#e8d080] block mb-1">
              {lang === 'en' ? 'Authentic VT52 Font' : 'Шрифт fritzm/vt52'}
            </strong>
            <p className="text-[#c8b890]">
              {lang === 'en'
                ? 'Rendered in authentic fritzm/vt52 bitmap display font (monospace fallback until loaded).'
                : 'Отображение символов точным растровым шрифтом fritzm/vt52.'}
            </p>
          </div>
          <div className="rounded border border-[#3a3528] bg-[#13110d] p-3">
            <strong className="text-[#e8d080] block mb-1">
              {lang === 'en' ? 'Text Mode & Clipboard' : 'Текстовый режим и буфер обмена'}
            </strong>
            <p className="text-[#c8b890]">
              {lang === 'en'
                ? 'Optionally render the terminal as standard text input for fast Ctrl+C / Ctrl+V clipboard pasting. It acts on the page, so a VT52 and a VT100 terminal are both rendered this way.'
                : 'Возможность включения текстового режима для легкого копирования и вставки исходного кода (Ctrl+C / Ctrl+V). Режим действует на страницу, поэтому так отображаются и терминалы VT52, и терминалы VT100.'}
            </p>
          </div>
        </div>
      </section>

      {/* SECTION 5: LP11 LINE PRINTER */}
      <section id="printer" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§5</span>
            {lang === 'en' ? 'The LP11 Line Printer (Printer page)' : 'Построчный принтер LP11 (страница Printer)'}
          </h2>
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'The LP11 is an animated line printer on wide 132-column fanfold green-bar paper (72/80/100/132 selectable). It only prints. Use Print to send jobs to your physical printer via system dialog, or Save .txt to export formatted output. Print paginates the job on form feeds and on the 66-line sheet, prints the sheet landscape at the machine\'s own 6 LPI / 10 pitch (a line-printer sheet is wider than it is tall) and fills the printable width with the selected column count — double-struck (nroff bold) text prints bold and underscored text underlined.'
            : 'LP11 — это анимированный построчный принтер на широкой 132-колоночной бумаге в зеленую полоску (выбор 72/80/100/132 колонок). Кнопка Print отправляет листинг на реальный принтер через системный диалог, а Save .txt сохраняет файл с метками перевода страницы. Print разбивает задание на листы по form feed и по 66 строкам, печатает лист альбомным с машинным шагом 6 LPI при 10 pitch (лист АЦПУ шире, чем выше) и заполняет ширину области печати выбранным числом колонок — символы, пробитые дважды (жирный в nroff), печатаются жирными, подчёркнутые — подчёркнутыми.'}
        </p>

        <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2">
          <img
            src="assets/images/manual/printer.png"
            alt="The LP11 line printer"
            className="w-full h-auto rounded cursor-pointer"
            onClick={() =>
              openImage('assets/images/manual/printer.png', 'The LP11 line printer printing a job listing')
            }
          />
        </div>

        <ul className="space-y-2 text-xs text-[#d4c4a0] list-disc list-inside">
          <li>
            <strong className="text-[#f0e6c8]">
              {lang === 'en' ? 'High Speed (~300 lines/min): ' : 'Высокая скорость (~300 строк/мин): '}
            </strong>
            {lang === 'en'
              ? 'Echoes characters far faster than the 110-baud teletype.'
              : 'Печатает в разы быстрее консольного телетайпа со 110 бод.'}
          </li>
          <li>
            <strong className="text-[#f0e6c8]">
              {lang === 'en' ? 'DONE & ERROR Handshake: ' : 'Аппаратный протокол DONE и ERROR: '}
            </strong>
            {lang === 'en'
              ? 'Writing LPDB clears DONE until consumed; OFF LINE latches sticky ERROR flag.'
              : 'Запись в регистр LPDB сбрасывает флаг DONE до завершения печати символа; в режиме OFF LINE выставляется флаг ERROR.'}
          </li>
          <li>
            <strong className="text-[#f0e6c8]">
              {lang === 'en' ? 'Form Feed Support: ' : 'Перевод страницы (Form Feed): '}
            </strong>
            {lang === 'en'
              ? 'Honours 0x0C (66 lines per sheet) with dashed perforation markers for spoolers (lpr/lpd).'
              : 'Обрабатывает символ 0x0C (66 строк на лист при 6 LPI) с пунктирной линией перфорации.'}
          </li>
        </ul>
      </section>

      {/* SECTION 6: VT11 VECTOR DISPLAY */}
      <section id="vt11" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§6</span>
            {lang === 'en' ? 'The VT11 Vector Display (Display page)' : 'Векторный дисплей VT11 (страница Display)'}
          </h2>
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'An optional DEC VT11 vector-graphics display processor on its own green-phosphor CRT page (1024×768 logical resolution, auto-scaled to fit the window). Lunar Lander uses it — the quick-boot wizard automatically activates this display and switches to the page.'
            : 'Опциональный векторный графический дисплей DEC VT11 с зеленым люминофором на странице Display (логическое разрешение 1024×768 с автоматическим масштабированием). Используется игрой Lunar Lander — мастер быстрого запуска сам включает дисплей и переходит на нужную страницу.'}
        </p>

        <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2">
          <img
            src="assets/images/manual/vt11.png"
            alt="Lunar Lander on the VT11 vector display"
            className="w-full h-auto rounded cursor-pointer"
            onClick={() =>
              openImage('assets/images/manual/vt11.png', 'Lunar Lander drawn on the VT11 vector CRT')
            }
          />
        </div>
      </section>

      {/* SECTION 7: STORAGE */}
      <section id="storage" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§7</span>
            {lang === 'en'
              ? 'Storage (paper tape, disk & tape images)'
              : 'Хранилище (перфолента, образы дисков и лент)'}
          </h2>
        </div>

        <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2">
          <img
            src="assets/images/manual/storage.png"
            alt="The Storage page"
            className="w-full h-auto rounded cursor-pointer"
            onClick={() =>
              openImage('assets/images/manual/storage.png', 'The Storage page: reader, drop zone and mounted images')
            }
          />
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'The page has two tabs — Images and Paper Tapes — because the two workflows are completely different. An image is a whole device mounted into the machine and remembered between sessions; a paper tape is a stream of bytes the reader walks through from the first frame to the end.'
            : 'Страница состоит из двух вкладок — «Образы» и «Перфоленты» — потому что это два совершенно разных сценария. Образ — это целое устройство, подключённое к машине и запоминаемое между сеансами; перфолента — поток байтов, который считыватель проходит от первого кадра до конца.'}
        </p>

        <div className="space-y-3 text-xs">
          <div className="rounded border border-[#3a3528] bg-[#13110d] p-3">
            <Download className="w-4 h-4 text-[#c8a860] mb-1.5" />
            <strong className="text-[#f0e6c8] block mb-1">
              {lang === 'en' ? 'Import image' : 'Импорт образа'}
            </strong>
            <p className="text-[#c8b890]">
              {lang === 'en'
                ? 'Drop a .dsk, .tap or .ptap image — plain or .zst-compressed — on the drop zone, or anywhere over the window while this page is open. A .zst file is a zstd frame and the browser unwraps it on the fly, so a downloaded image needs no unpacking first.'
                : 'Перетащите образ .dsk, .tap или .ptap — обычный или сжатый в .zst — на зону или в любое место окна, пока открыта эта страница. Файл .zst — это кадр zstd, браузер распаковывает его на лету, так что распаковывать образ заранее не нужно.'}
            </p>
          </div>

          <div className="rounded border border-[#3a3528] bg-[#13110d] p-3">
            <HardDrive className="w-4 h-4 text-[#c8a860] mb-1.5" />
            <strong className="text-[#f0e6c8] block mb-1">
              {lang === 'en' ? 'The file name is the device name' : 'Имя файла — это имя устройства'}
            </strong>
            <p className="text-[#c8b890]">
              {lang === 'en'
                ? 'An image is mounted under the device URL taken from the file itself: RP1.DSK.ZST becomes rp1.dsk, which is why the guest boots it with "boot rp1". Rename the file to the unit you want to use — the table below maps every device to its drive, controller and boot command.'
                : 'Образ подключается под именем устройства, взятым из самого файла: RP1.DSK.ZST становится rp1.dsk — именно поэтому гость загружает его командой «boot rp1». Назовите файл по нужному устройству; таблица ниже сопоставляет устройства, накопители, контроллеры и команды загрузки.'}
            </p>
          </div>

          <div className="rounded border border-[#3a3528] bg-[#13110d] p-3">
            <HardDrive className="w-4 h-4 text-[#c8a860] mb-1.5" />
            <strong className="text-[#f0e6c8] block mb-1">
              {lang === 'en' ? 'Mounted images / Unmount / Delete' : 'Подключённые образы / отключение / удаление'}
            </strong>
            <p className="text-[#c8b890]">
              {lang === 'en'
                ? 'Lists the images mounted in this browser. Unmount takes the selected one out of the machine — booting that drive then reports a missing image instead of loading some other file, a bundled image is streamed from the server again on the next boot, and an imported one keeps its stored copy and is back after a reload. Delete image erases an imported image from this browser after a confirmation, guest writes included, with an Export first shortcut; bundled media cannot be deleted because it lives on the server. The counter counts the images YOU mounted, not the ones the desktop build carries inside itself, and an image that Export disk cannot save is marked “· nothing to export” here.'
                : 'Список образов, подключённых в этом браузере. Unmount вынимает выбранный образ из машины: загрузка с этого привода сообщает об отсутствующем образе, а не подставляет другой файл; вшитый образ при следующей загрузке снова скачивается с сервера, а импортированный сохраняет копию и возвращается после перезагрузки. Delete image стирает импортированный образ из браузера после подтверждения — вместе с записями гостя и с кнопкой Export first, чтобы сначала сохранить копию; вшитые образы удалить нельзя, они лежат на сервере. Счётчик считает только ВАШИ образы, а не те, что вшиты в настольную сборку; образ, который «Выгрузка диска» сохранить не может, помечен здесь как «· nothing to export».'}
            </p>
          </div>

          <div className="rounded border border-[#3a3528] bg-[#13110d] p-3">
            <Sliders className="w-4 h-4 text-[#c8a860] mb-1.5" />
            <strong className="text-[#f0e6c8] block mb-1">
              {lang === 'en' ? 'Persistent disk changes' : 'Постоянные изменения диска'}
            </strong>
            <p className="text-[#c8b890]">
              {lang === 'en'
                ? 'Guest-OS writes are saved to browser storage and overlaid on the base image on the next launch, so files an operating system created are still there tomorrow. Only the blocks the guest actually wrote are kept — the base image is fetched again on every launch — and a saved block always wins over the pristine one. They are written out periodically and when you leave the page, and they belong to one image: Reset image discards them for the selected disk, Reset all for every disk, returning the media to its factory state.'
                : 'Записи гостевой ОС сохраняются в хранилище браузера и накладываются на базовый образ при следующем запуске, поэтому созданные файлы остаются на месте и завтра. Хранятся только реально записанные блоки — базовый образ каждый раз загружается заново — и сохранённый блок всегда важнее исходного. Изменения записываются периодически и при уходе со страницы, и принадлежат одному образу: «Reset image» стирает их для выбранного диска, «Reset all» — для всех, возвращая носители к заводскому состоянию.'}
            </p>
          </div>

          <div className="rounded border border-[#3a3528] bg-[#13110d] p-3">
            <Download className="w-4 h-4 text-[#c8a860] mb-1.5" />
            <strong className="text-[#f0e6c8] block mb-1">
              {lang === 'en' ? 'Export disk' : 'Выгрузка диска'}
            </strong>
            <p className="text-[#c8b890]">
              {lang === 'en'
                ? 'Downloads a stored disk image — guest-OS writes included — and states its condition: “no changes”, “N blocks changed” or “not mounted, N blocks changed”. Only an image with something of yours to save is listed: one the guest has written to, or one you mounted yourself. A pristine bundled image is not listed — the Mounted images list marks it “· nothing to export” instead.'
                : 'Скачивает сохранённый образ диска — вместе с записями гостевой ОС — и указывает его состояние: «no changes», «N blocks changed» или «not mounted, N blocks changed». В списке только образы, у которых есть что сохранить из вашего: тот, куда писала гостевая ОС, или тот, что вы смонтировали сами. Чистый вшитый образ в списке отсутствует — вместо этого список Mounted images помечает его «· nothing to export».'}
            </p>
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border border-[#4a453a] bg-[#12100d]">
          <table className="w-full text-left text-xs text-[#d4c4a0] border-collapse">
            <thead>
              <tr className="border-b border-[#3a3528] bg-[#1c1914] text-[#f0e6c8] font-mono">
                <th className="py-2 px-3">{lang === 'en' ? 'IMAGE' : 'ОБРАЗ'}</th>
                <th className="py-2 px-3">{lang === 'en' ? 'DRIVE' : 'НАКОПИТЕЛЬ'}</th>
                <th className="py-2 px-3">{lang === 'en' ? 'CONTROLLER' : 'КОНТРОЛЛЕР'}</th>
                <th className="py-2 px-3">{lang === 'en' ? 'BOOT IT WITH' : 'ЗАГРУЗКА'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2a261f]">
              {[
                { image: 'rk0 … rk5', driveEn: 'RK05 disk cartridge', driveRu: 'Картридж RK05', ctrl: 'RK11', boot: 'boot rkN' },
                { image: 'rl0 … rl3', driveEn: 'RL01 / RL02 cartridge', driveRu: 'Картридж RL01 / RL02', ctrl: 'RL11', boot: 'boot rlN' },
                { image: 'rp0 … rp4', driveEn: 'RP04 / RP06 disk pack', driveRu: 'Пакет дисков RP04 / RP06', ctrl: 'RP11', boot: 'boot rpN' },
                { image: 'ra0 … ra2', driveEn: 'RA80 / RA81 (MSCP)', driveRu: 'RA80 / RA81 (MSCP)', ctrl: 'UDA50', boot: 'boot raN' },
                { image: 'tm0 … tm2', driveEn: '9-track magnetic tape', driveRu: 'Магнитная лента 9 дорожек', ctrl: 'TM11', boot: 'boot tmN' },
                { image: '*.ptap', driveEn: 'Paper tape reader / punch', driveRu: 'Считыватель и перфоратор перфоленты', ctrl: 'PTR11', boot: 'boot pr' },
              ].map((row) => (
                <tr key={row.image} className="hover:bg-[#191611]">
                  <td className="py-2 px-3 font-mono text-[#e8d080]">{row.image}</td>
                  <td className="py-2 px-3 text-[#f0e6c8]">{lang === 'en' ? row.driveEn : row.driveRu}</td>
                  <td className="py-2 px-3 font-mono">{row.ctrl}</td>
                  <td className="py-2 px-3 font-mono text-[#c8b890]">{row.boot}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2">
          <img
            src="assets/images/manual/storage-tapes.png"
            alt="The Storage page — Paper Tapes tab"
            className="w-full h-auto rounded cursor-pointer"
            onClick={() =>
              openImage('assets/images/manual/storage-tapes.png', 'The Storage page, Paper Tapes tab')
            }
          />
          <p className="mt-1.5 text-center text-xs text-[#8a7650] italic">
            {lang === 'en'
              ? 'The Paper Tapes tab: the reader file selector, a .ptap drop zone and the punch-tape export.'
              : 'Вкладка «Перфоленты»: выбор файла для считывателя, зона для .ptap и выгрузка перфорированной ленты.'}
          </p>
        </div>

        <div className="space-y-3 text-xs">
          <div className="rounded border border-[#3a3528] bg-[#13110d] p-3">
            <strong className="text-[#f0e6c8] block mb-1">
              {lang === 'en' ? 'Paper tape reader file' : 'Файл для считывателя перфоленты'}
            </strong>
            <p className="text-[#c8b890]">
              {lang === 'en'
                ? 'A selector for the reader (#ptr) holding the tapes this build ships — BASIC-11 V007A, ODT-11X-V004A, ED-11-V004B, Lunar Lander and the bootstrap loader — plus any .ptap you dropped. Load one and boot it with "BOOT PR".'
                : 'Селектор считывателя (#ptr) со всеми лентами сборки — BASIC-11 V007A, ODT-11X-V004A, ED-11-V004B, Lunar Lander и загрузчик — плюс любые перетащенные .ptap. Выберите ленту и загружайте командой «BOOT PR».'}
            </p>
          </div>

          <div className="rounded border border-[#3a3528] bg-[#13110d] p-3">
            <strong className="text-[#f0e6c8] block mb-1">
              {lang === 'en' ? 'Rewind tape and the tape state' : 'Перемотка и состояние ленты'}
            </strong>
            <p className="text-[#c8b890]">
              {lang === 'en'
                ? 'The indicator beside the button says whether a tape is loaded and how far the reader has moved through it; Rewind tape puts it back to the first frame, which is what a guest does when it restarts a read. Dropped tapes are added to the selector.'
                : 'Индикатор рядом с кнопкой показывает, заряжена ли лента и как далеко продвинулся считыватель; «Rewind tape» возвращает её к первому кадру — так поступает и гость, перезапуская чтение. Перетащенные ленты добавляются в селектор.'}
            </p>
          </div>

          <div className="rounded border border-[#3a3528] bg-[#13110d] p-3">
            <strong className="text-[#f0e6c8] block mb-1">
              {lang === 'en' ? 'Export paper tape' : 'Выгрузка перфоленты'}
            </strong>
            <p className="text-[#c8b890]">
              {lang === 'en'
                ? 'The punch buffer is filled by the bytes the console echoes, and the counter shows how much is on the tape: Download saves it as a .ptap, Clear empties the buffer for the next tape. The reader and the punch are the console teletype\u2019s own devices, which is why the paper it prints and the tape it punches are two views of one stream.'
                : 'Буфер перфоратора наполняется байтами, которые эхо-печатает консоль, а счётчик показывает объём ленты: «Download» сохраняет её как .ptap, «Clear» очищает буфер под следующую ленту. Считыватель и перфоратор — устройства самой консоли, поэтому напечатанный текст и пробитая лента это два представления одного потока.'}
            </p>
          </div>
        </div>
      </section>

      {/* SECTION 8: MACHINE STATE */}
      <section id="machine-state" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§8</span>
            {lang === 'en' ? 'Machine State' : 'Управление состоянием машины'}
          </h2>
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'The round STATE button (top-left corner, right of REBOOT) opens the machine-state dialog — a full save/restore of the emulated PDP-11, not just the CPU: registers, memory, every I/O device (console, terminals, printer, disks, tape and the paper-tape reader/punch), the paper in the teletype and LP11, the VT52 screen contents and even the VT11 vector-display picture are all captured. Think of it as a save file of the whole machine.'
            : 'Круглая кнопка STATE (в верхнем левом углу, справа от REBOOT) открывает диалог состояния машины — полное сохранение/восстановление эмулируемого PDP-11, а не только процессора: регистры, память, все устройства ввода-вывода (консоль, терминалы, принтер, диски, лента, считыватель/перфоратор), бумага в телетайпе и LP11, содержимое экранов VT52 и даже картинка векторного дисплея VT11. По сути это файл сохранения всей машины.'}
        </p>

        <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2">
          <img
            src="assets/images/manual/dialog-state.png"
            alt="The machine-state dialog"
            className="w-full h-auto rounded cursor-pointer"
            onClick={() =>
              openImage('assets/images/manual/dialog-state.png', 'The machine-state dialog with one freshly saved state')
            }
          />
        </div>

        <ul className="list-disc pl-5 text-sm leading-relaxed text-[#c8b890] space-y-1.5">
          <li>
            <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Save state' : 'Сохранить состояние'}</strong>{' '}
            {lang === 'en'
              ? 'captures the machine exactly as it is right now under an auto-generated name (date and time). The hardware configuration is part of the state: restoring re-applies the console type, user terminals, printer and VT11 display, restarting the machine to match.'
              : 'фиксирует машину как есть под автоматически сгенерированным именем (дата и время). Конфигурация оборудования входит в состояние: при восстановлении повторно применяются тип консоли, терминалы, принтер и дисплей VT11, и машина перезапускается под них.'}
          </li>
          <li>
            <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Load' : 'Загрузить'}</strong>{' '}
            {lang === 'en'
              ? 'restores the selected state and restarts the machine; a confirmation asks first. States saved by older versions of the emulator keep working.'
              : 'восстанавливает выбранное состояние и перезапускает машину (с подтверждением). Состояния, сохранённые старыми версиями эмулятора, продолжают работать.'}
          </li>
          <li>
            <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Rename / Delete' : 'Переименовать / Удалить'}</strong>{' '}
            {lang === 'en'
              ? 'organise the list or remove states; the counter next to the list shows how many states you have.'
              : 'приводят список в порядок или удаляют состояния; счётчик рядом со списком показывает их количество.'}
          </li>
          <li>
            <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Export / Import' : 'Export / Import'}</strong>{' '}
            {lang === 'en'
              ? 'take a state out as a .state file, or bring one in from a file somebody sent you. An imported file joins the list like any other state.'
              : 'выгружают состояние в файл .state или принимают состояние из файла, который вам прислали. Импортированный файл встаёт в список как обычное состояние.'}
          </li>
          <li>
            <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Share' : 'Share'}</strong>{' '}
            {lang === 'en'
              ? 'turns a state into a file you can hand to somebody else — see Sharing a state below.'
              : 'превращает состояние в файл, который можно передать другому человеку — см. «Передача состояния» ниже.'}
          </li>
        </ul>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'The STATE button mirrors REBOOT and is available on the Panel, Console (teletype, VT52 or VT100) and TTY pages. States are stored in the browser IndexedDB and survive reloads and sessions.'
            : 'Кнопка STATE зеркалит REBOOT и доступна на страницах Panel, Console (телетайп, VT52 или VT100) и TTY. Состояния хранятся в IndexedDB браузера и переживают перезагрузки и сеансы.'}
        </p>

        <h3 id="sharing-a-state" className="text-lg font-semibold text-[#f0e6c8] pt-2">
          {lang === 'en' ? 'Sharing a state' : 'Передача состояния'}
        </h3>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'A state is a file of a whole machine, and a link can open it for somebody else. The link form is pdp11.html?state=<url>, where <url> is wherever the file lives: a path next to the emulator (states/lander.state.zst — this is how the Games tiles work) or a full http(s) URL on your own host.'
            : 'Состояние — это файл целой машины, и ссылка может открыть его для другого человека. Форма ссылки — pdp11.html?state=<url>, где <url> — место, где лежит файл: путь рядом с эмулятором (states/lander.state.zst — так работают плитки в разделе «Игры») или полный http(s)-адрес на вашем хостинге.'}
        </p>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'To share your own state: open the machine-state dialog, pick a state and press Share. The dialog asks for the words the receiver will see — a Title, a Description, a Button label (for the message they read before they get control), a Screenshot, and a Run after restore command that types itself into the guest once the machine is back (e.g. RUN SPCINV). Create Shareable State then saves a .state.zst file to your computer.'
            : 'Чтобы передать своё состояние: откройте диалог состояния машины, выберите состояние и нажмите Share. Диалог спросит слова, которые увидит получатель: Title (заголовок), Description (описание), Button label (подпись на кнопке в сообщении перед получением управления), Screenshot (снимок экрана) и Run after restore — команду, которая сама наберётся в госте после возврата машины (например, RUN SPCINV). Кнопка Create Shareable State сохраняет файл .state.zst на ваш компьютер.'}
        </p>

        <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2">
          <img
            src="assets/images/manual/dialog-share.png"
            alt="The Share dialog"
            className="w-full h-auto rounded cursor-pointer"
            onClick={() =>
              openImage('assets/images/manual/dialog-share.png', lang === 'en' ? 'The Share dialog: give the state a title, a description and the keys the receiver needs' : 'Диалог Share: задайте состоянию заголовок, описание и подсказку по клавишам')
            }
          />
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'The Create Shareable State button is a split-button with additional options: Copy text to clipboard, Save as text file, Share via platform, and Create GitHub Gist — which opens a dialog for creating a secret Gist on GitHub with the machine state. You need a GitHub Personal Access Token with the gist scope.'
            : 'Кнопка Create Shareable State — это сплит-кнопка с дополнительными опциями: Copy text to clipboard, Save as text file, Share via platform и Create GitHub Gist — открывает диалог создания секретного Gist на GitHub с состоянием машины. Потребуется GitHub Personal Access Token с областью gist.'}
        </p>

        <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2">
          <img
            src="assets/images/manual/dialog-gist.png"
            alt="The Gist dialog"
            className="w-full h-auto rounded cursor-pointer"
            onClick={() =>
              openImage('assets/images/manual/dialog-gist.png', lang === 'en' ? 'The Gist dialog: enter your GitHub token and generate a shareable link' : 'Диалог Gist: введите токен GitHub и создайте ссылку для публикации')
            }
          />
          <p className="mt-1.5 text-center text-xs text-[#8a7650] italic">
            {lang === 'en'
              ? 'The Gist dialog: enter your GitHub token and generate a shareable link.'
              : 'Диалог Gist: введите токен GitHub и создайте ссылку для публикации.'}
          </p>
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'The Gist dialog provides a PAT input field (masked by default), show/hide toggle, clear saved token button, and an info button (i) that opens the About GitHub Personal Access Token dialog — explaining the security model: the PAT is used only to create a Gist via the GitHub API, is never sent anywhere else, and is stored in encrypted form in localStorage. It also provides step-by-step instructions for creating a PAT with the gist scope.'
            : 'Диалог Gist предоставляет поле ввода PAT (скрыто по умолчанию), кнопку показать/скрыть, кнопку очистки сохранённого токена и кнопку info (i), которая открывает диалог About GitHub Personal Access Token — с объяснением модели безопасности: PAT используется только для создания Gist через GitHub API, никуда больше не отправляется и хранится в зашифрованном виде в localStorage. Диалог также содержит пошаговую инструкцию по созданию PAT с областью gist.'}
        </p>

        <div className="rounded-lg border border-[#4a453a] bg-[#12100d] p-2">
          <img
            src="assets/images/manual/dialog-gist-about-pat.png"
            alt="The About PAT dialog"
            className="w-full h-auto rounded cursor-pointer"
            onClick={() =>
              openImage('assets/images/manual/dialog-gist-about-pat.png', lang === 'en' ? 'The About PAT dialog: security policy and PAT creation instructions' : 'Диалог About PAT: политика безопасности и инструкция по созданию PAT')
            }
          />
          <p className="mt-1.5 text-center text-xs text-[#8a7650] italic">
            {lang === 'en'
              ? 'The About PAT dialog: security policy and PAT creation instructions.'
              : 'Диалог About PAT: политика безопасности и инструкция по созданию PAT.'}
          </p>
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'Host that file anywhere reachable by a URL, then send the link. Two things decide whether it works:'
            : 'Выложите этот файл туда, где он будет доступен по URL, и отправьте ссылку. На успех влияют две вещи:'}
        </p>

        <ul className="list-disc pl-5 text-sm leading-relaxed text-[#c8b890] space-y-1.5">
          <li>
            {lang === 'en'
              ? 'The host must allow the file to be read from another site (the Access-Control-Allow-Origin header). A browser refuses to let this page read a file on another host that does not say so, and the visitor then sees a “Shared state not restored” message naming the URL. Static hosts often do not send that header by default. The surest way to avoid the problem is to keep the file next to the emulator — on the same site — exactly as the states under states/ are served.'
              : 'Хостинг должен разрешать чтение файла с другого сайта (заголовок Access-Control-Allow-Origin). Браузер не позволит этой странице прочитать файл на чужом хосте, который такого разрешения не даёт, и посетитель увидит сообщение «Shared state not restored» с указанием URL. Статические хостинги часто не отдают этот заголовок по умолчанию. Надёжнее всего положить файл рядом с эмулятором — на том же сайте, — ровно как отдаются состояния в каталоге states/.'}
          </li>
          <li>
            {lang === 'en'
              ? 'The receiver needs the same disk images. A state does not carry its images, only a record of which ones it needs and their fingerprints. If the image differs from the one the state was taken on, the restore is refused rather than half-applied: a machine with new memory and an old disk is worse than no restore at all.'
              : 'Получателю нужны те же образы дисков. Состояние не несёт свои образы: только запись о том, какие образы ему нужны, и их отпечатки. Если образ отличается от того, на котором состояние снималось, восстановление отклоняется, а не применяется наполовину: машина с новой памятью и старым диском хуже, чем отсутствие восстановления.'}
          </li>
        </ul>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'When either condition fails the visitor is told in a dialog that names the URL, and the address bar keeps the ?state= parameter so what was asked for stays visible. If a link cannot work at all — the state lives somewhere that cannot be fetched — the file itself is still the fallback: Import takes any .state or .state.zst file from disk, with no server and no CORS involved.'
            : 'Если не выполнено любое из условий, посетителю показывается диалог с указанием URL, а в адресной строке остаётся параметр ?state=, чтобы было видно, что именно запрашивалось. Если ссылка не может работать вовсе — состояние лежит там, откуда его не получить, — остаётся сам файл: Import принимает любой файл .state или .state.zst с диска, без сервера и без CORS.'}
        </p>

        <h3 id="embedding-the-emulator" className="text-lg font-semibold text-[#f0e6c8] pt-2">
          {lang === 'en' ? 'Embedding the emulator' : 'Встраивание эмулятора'}
        </h3>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en' ? (
            <>
              The emulator can be embedded into any HTML page as an{' '}
              <code className="text-[#e8d080]">{'<iframe>'}</code>. This makes it suitable for museum
              exhibits, educational websites, and online articles — visitors interact with a live PDP-11
              without leaving your site.
            </>
          ) : (
            <>
              Эмулятор можно встроить в любую HTML-страницу через{' '}
              <code className="text-[#e8d080]">{'<iframe>'}</code>. Это делает его удобным для
              музейных экспонатов, образовательных сайтов и онлайн-статей — посетитель
              взаимодействует с живой PDP-11, не покидая ваш сайт.
            </>
          )}
        </p>

        <p className="text-sm leading-relaxed text-[#f0e6c8] font-bold">
          {lang === 'en' ? 'Basic OS boot' : 'Базовая загрузка ОС'}
        </p>

        <pre className="overflow-x-auto rounded-lg border border-[#4a453a] bg-black/60 p-3 font-mono text-[11px] leading-relaxed text-[#d4c4a0]">{`<iframe src="https://amesk.github.io/yaPDP/pdp11.html?boot=rk1"
        width="1024" height="768"
        allow="clipboard-read; clipboard-write"
        title="yaPDP PDP-11/70 Emulator">
</iframe>`}</pre>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en' ? (
            <>
              The <code className="text-[#e8d080]">?boot=</code> parameter starts the quick-boot wizard
              for the specified disk. The wizard types the boot command and, where credentials are
              known, the login — the visitor sees a running operating system immediately.
            </>
          ) : (
            <>
              Параметр <code className="text-[#e8d080]">?boot=</code> запускает мастер быстрой
              загрузки для указанного диска. Мастер набирает команду загрузки и, если учётные данные
              известны, логин — посетитель сразу видит работающую операционную систему.
            </>
          )}
        </p>

        <p className="text-sm leading-relaxed text-[#f0e6c8] font-bold">
          {lang === 'en' ? 'Loading a machine state' : 'Загрузка состояния машины'}
        </p>

        <pre className="overflow-x-auto rounded-lg border border-[#4a453a] bg-black/60 p-3 font-mono text-[11px] leading-relaxed text-[#d4c4a0]">{`<iframe src="https://amesk.github.io/yaPDP/pdp11.html?state=states/lunar-lander.state.zst"
        width="1024" height="768"
        allow="clipboard-read; clipboard-write"
        title="yaPDP PDP-11/70 Emulator">
</iframe>`}</pre>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en' ? (
            <>
              The <code className="text-[#e8d080]">?state=</code> parameter loads a saved machine
              state. The state file must be reachable from the browser — see the CORS discussion above.
            </>
          ) : (
            <>
              Параметр <code className="text-[#e8d080]">?state=</code> загружает сохранённое состояние
              машины. Файл состояния должен быть доступен браузеру — см. обсуждение CORS выше.
            </>
          )}
        </p>

        <p className="text-sm leading-relaxed text-[#f0e6c8] font-bold">
          {lang === 'en' ? 'Using a GitHub Gist to bypass CORS' : 'Использование GitHub Gist для обхода CORS'}
        </p>

        <pre className="overflow-x-auto rounded-lg border border-[#4a453a] bg-black/60 p-3 font-mono text-[11px] leading-relaxed text-[#d4c4a0]">{`<iframe src="https://amesk.github.io/yaPDP/pdp11.html?state=https://gist.githubusercontent.com/.../raw/.../demo.state.txt"
        width="1024" height="768"
        allow="clipboard-read; clipboard-write"
        title="yaPDP PDP-11/70 Emulator">
</iframe>`}</pre>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en' ? (
            <>
              If you cannot place the state file on the same host as the emulator, the GitHub Gist
              workflow (see{' '}
              <button
                type="button"
                onClick={() => scrollToSection('sharing-a-state')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                Sharing a state
              </button>
              ) solves the CORS problem: GitHub serves Gist raw files with the correct{' '}
              <code className="text-[#e8d080]">Access-Control-Allow-Origin</code> header. The link
              generated by the <strong className="text-[#f0e6c8]">Create GitHub Gist</strong> dialog
              works directly in an iframe.
            </>
          ) : (
            <>
              Если вы не можете разместить файл состояния на том же хосте, что и эмулятор, механизм
              GitHub Gist (см.{' '}
              <button
                type="button"
                onClick={() => scrollToSection('sharing-a-state')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                Передача состояния
              </button>
              ) решает проблему CORS: GitHub отдаёт «сырые» файлы Gist с правильным заголовком{' '}
              <code className="text-[#e8d080]">Access-Control-Allow-Origin</code>. Ссылка,
              сгенерированная диалогом <strong className="text-[#f0e6c8]">Create GitHub Gist</strong>,
              работает напрямую в iframe.
            </>
          )}
        </p>

        <p className="text-sm leading-relaxed text-[#f0e6c8] font-bold">
          {lang === 'en' ? 'Guided restore for museum exhibits' : 'Подготовленный экспонат для музея'}
        </p>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'When you create a shareable state, the Title, Description, Screenshot and Run after restore fields (see Sharing a state above) let you prepare a self-contained exhibit. The visitor sees a welcome message with your description and a screenshot before the machine starts; after they click the button, the emulator boots and types the post-restore command automatically. No server configuration, no disk hunting — the state carries everything except the disk images, which are bundled with the emulator.'
            : 'При создании публикуемого состояния поля Title, Description, Screenshot и Run after restore (см. «Передача состояния» выше) позволяют подготовить самодостаточный экспонат. Посетитель видит приветственное сообщение с вашим описанием и снимком экрана до запуска машины; после нажатия кнопки эмулятор загружается и автоматически набирает команду восстановления. Никакой настройки сервера, никакого поиска дисков — состояние несёт всё, кроме образов дисков, которые уже входят в комплект эмулятора.'}
        </p>

        <p className="text-sm leading-relaxed text-[#f0e6c8] font-bold">
          {lang === 'en' ? 'Recommendations for museums and educators' : 'Рекомендации для музеев и преподавателей'}
        </p>

        <ul className="list-disc pl-5 text-sm leading-relaxed text-[#c8b890] space-y-1.5">
          <li>
            {lang === 'en' ? (
              <>
                Use <code className="text-[#e8d080]">?boot=</code> for a quick OS demonstration — no
                state file needed.
              </>
            ) : (
              <>
                Используйте <code className="text-[#e8d080]">?boot=</code> для быстрой демонстрации
                ОС — файл состояния не нужен.
              </>
            )}
          </li>
          <li>
            {lang === 'en' ? (
              <>
                Use <code className="text-[#e8d080]">?state=</code> with a GitHub Gist for a curated
                exhibit that survives hosting changes.
              </>
            ) : (
              <>
                Используйте <code className="text-[#e8d080]">?state=</code> с GitHub Gist для
                подготовленного экспоната, который переживёт смену хостинга.
              </>
            )}
          </li>
          <li>
            {lang === 'en' ? (
              <>
                Set <code className="text-[#e8d080]">allow="clipboard-read; clipboard-write"</code> on
                the iframe so the emulator clipboard features (Import from clipboard, Copy text to
                clipboard) work inside the embedded page.
              </>
            ) : (
              <>
                Укажите <code className="text-[#e8d080]">allow="clipboard-read; clipboard-write"</code>{' '}
                в iframe, чтобы функции буфера обмена эмулятора (Import from clipboard, Copy text to
                clipboard) работали внутри встроенной страницы.
              </>
            )}
          </li>
          <li>
            {lang === 'en'
              ? 'The emulator is responsive: on narrow viewports it adapts to a mobile-friendly layout automatically.'
              : 'Эмулятор адаптивен: на узких экранах он автоматически переключается в мобильный макет.'}
          </li>
        </ul>

        <h3 id="configuration-and-the-state" className="text-lg font-semibold text-[#f0e6c8] pt-2">
          {lang === 'en' ? 'Configuration and the state' : 'Конфигурация и состояние'}
        </h3>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'A state carries its own hardware configuration, and restoring it applies that profile — console type, user terminals, LP11 printer, VT11 display, widths, teletype speed, zoom, glow, phosphor and backdrop. There is one exception: the two sound settings (Mute and the machine hum) are never touched, because they belong to the person at the keyboard, not to the guest. A page reload happens only when the device set differs; everything else applies live.'
            : 'Состояние несёт собственную аппаратную конфигурацию, и при восстановлении применяется её профиль — тип консоли, пользовательские терминалы, принтер LP11, дисплей VT11, ширины, скорость телетайпа, масштаб, свечение, люминофор и фон. Есть одно исключение: две звуковые настройки (Mute и гул машины) не трогаются никогда, потому что принадлежат человеку за клавиатурой, а не гостю. Перезагрузка страницы происходит только если отличается набор устройств; всё остальное применяется на лету.'}
        </p>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'A state opened from a ?state= link asks nothing — the state is the point of the link. Your own configuration is remembered before it is replaced, and after a reload (or in the Reboot / Bootstrap now! dialog) you are offered Return my configuration, which restores every field. Returning it reloads only when the device set differs, and a Reboot parked across that reload runs as soon as the page is back.'
            : 'Состояние, открытое по ссылке ?state=, ничего не спрашивает — состояние и есть смысл ссылки. Ваша собственная конфигурация запоминается до того, как её заменят, и после перезагрузки (или в диалоге Reboot / Bootstrap now!) вам предлагают Return my configuration, что восстанавливает все поля. Возврат вызывает перезагрузку только при другом наборе устройств, а отложенный Reboot выполняется, как только страница вернётся.'}
        </p>
      </section>

      {/* SECTION 8: CONFIGURATION */}
      <section id="config" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§9</span>
            {lang === 'en' ? 'Configuration (Config page)' : 'Конфигурация (страница Config)'}
          </h2>
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'The Config page controls emulated peripherals and machine parameters, persisted between sessions. The settings are divided into four tabs:'
            : 'Страница Config управляет периферийными устройствами и параметрами машины, сохраняя их между сеансами. Настройки разделены на 4 вкладки:'}
        </p>

        {/* Interactive Config Tabs */}
        <div className="rounded-lg border border-[#4a453a] bg-[#14120e] p-4">
          <div className="flex flex-wrap gap-2 border-b border-[#3a3528] pb-3 mb-4">
            {CONFIG_TABS_DATA.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveConfigTab(tab.id)}
                className={`px-3 py-1.5 text-xs font-bold rounded transition-all cursor-pointer ${activeConfigTab === tab.id
                  ? 'bg-[#c8a860] text-black shadow-sm'
                  : 'bg-[#1e1a14] text-[#d4c4a0] hover:text-[#f0e6c8] border border-[#3a3528]'
                  }`}
              >
                {lang === 'en' ? tab.titleEn : tab.titleRu}
              </button>
            ))}
          </div>

          {CONFIG_TABS_DATA.filter((t) => t.id === activeConfigTab).map((tab) => (
            <div key={tab.id} className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
              <div>
                <img
                  src={tab.image}
                  alt={tab.titleEn}
                  className="w-full h-auto rounded border border-[#4a453a] cursor-pointer"
                  onClick={() => openImage(tab.image, `CONFIG - ${tab.titleEn}`)}
                />
                <p className="mt-1 text-center text-[11px] text-[#8a7650] italic">
                  {lang === 'en' ? `CONFIG — ${tab.titleEn} tab` : `CONFIG — вкладка «${tab.titleRu}»`}
                </p>
              </div>

              <div className="space-y-2 text-xs">
                {(lang === 'en' ? tab.itemsEn : tab.itemsRu).map((item, idx) => (
                  <div
                    key={idx}
                    className="p-2 rounded bg-[#181510] border border-[#2e2920] flex flex-col gap-0.5"
                  >
                    <span className="font-bold text-[#e8d080]">{item.label}</span>
                    <span className="text-[#bfae90] leading-relaxed">{item.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Warning card for uncommitted changes */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center rounded border border-[#3a3528] bg-[#13110d] p-3">
          <p className="text-xs text-[#c8b890] leading-relaxed">
            {lang === 'en' ? (
              <>
                Leaving the Config page with uncommitted changes triggers a confirmation modal to avoid losing
                settings. Click <strong className="text-[#f0e6c8]">Apply</strong> to reboot with new hardware or{' '}
                <strong className="text-[#f0e6c8]">Restore defaults</strong> to reset factory defaults.
              </>
            ) : (
              <>
                Попытка покинуть страницу настроек с несохраненными изменениями вызывает предупреждающий диалог.
                Нажмите <strong className="text-[#f0e6c8]">Apply</strong> для применения и перезагрузки или{' '}
                <strong className="text-[#f0e6c8]">Restore defaults</strong> для сброса к заводским установкам.
              </>
            )}
          </p>
          <img
            src="assets/images/manual/dialog-config-leave.png"
            alt="Unapplied configuration warning"
            className="w-full h-auto rounded border border-[#4a453a] cursor-pointer"
            onClick={() =>
              openImage('assets/images/manual/dialog-config-leave.png', 'Unapplied configuration warning')
            }
          />
        </div>
      </section>

      {/* SECTION 9: GUEST OPERATING SYSTEMS */}
      <section id="guest-oses" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§10</span>
            {lang === 'en' ? 'Guest Operating Systems' : 'Гостевые операционные системы'}
          </h2>
          <span className="text-xs font-mono text-[#c8a860]">16 GUEST SYSTEMS</span>
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en' ? (
            <>
              The emulator ships with ready-to-boot disk and tape images. Just type{' '}
              <code className="text-[#e8d080]">boot &lt;device&gt;</code> at the{' '}
              <code className="text-[#e8d080]">Boot&gt;</code> prompt — or pick one directly with the magic
              wand.
            </>
          ) : (
            <>
              Эмулятор поставляется с готовыми образами дисков и лент. Просто введите команду{' '}
              <code className="text-[#e8d080]">boot &lt;устройство&gt;</code> в строке{' '}
              <code className="text-[#e8d080]">Boot&gt;</code> — или выберите систему через волшебную
              палочку.
            </>
          )}
        </p>

        {/* Filtered Table of 16 Operating Systems */}
        <div className="overflow-x-auto rounded-lg border border-[#4a453a] bg-[#12100d]">
          <table className="w-full text-left text-xs text-[#d4c4a0] border-collapse">
            <thead>
              <tr className="border-b border-[#3a3528] bg-[#1c1914] text-[#f0e6c8] font-mono">
                <th className="py-2.5 px-3">DISK</th>
                <th className="py-2.5 px-3">OPERATING SYSTEM</th>
                <th className="py-2.5 px-3">BOOT COMMAND &amp; INSTRUCTIONS</th>
                <th className="py-2.5 px-3 text-right">ACTION</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2a261f]">
              {filteredOsList.map((os) => (
                <tr key={os.disk} className="hover:bg-[#191611] transition-colors">
                  <td className="py-2.5 px-3 font-mono font-bold text-[#e8d080]">{os.disk}</td>
                  <td className="py-2.5 px-3 font-semibold text-[#f0e6c8]">{os.name}</td>
                  <td className="py-2.5 px-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="bg-black/50 text-[#c8a860] px-1.5 py-0.5 rounded border border-[#3a3528] font-mono">
                        {os.bootCommand}
                      </code>
                      <span className="text-[#a09278]">
                        → {lang === 'en' ? os.instructionsEn : os.instructionsRu}
                      </span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    <button
                      onClick={() => handleCopy(os.bootCommand, os.disk)}
                      className="px-2 py-1 text-[11px] font-mono rounded border border-[#3a3528] hover:border-[#c8a860] bg-[#1c1914] hover:bg-[#252119] text-[#c8a860] inline-flex items-center gap-1 transition-all"
                    >
                      {copiedSnippet === os.disk ? (
                        <Check className="w-3 h-3 text-emerald-400" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                      <span>{copiedSnippet === os.disk ? 'Copied' : 'Copy'}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* SECTION 10: BUTTONS, SHORTCUTS & INDICATORS */}
      <section id="controls" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§11</span>
            {lang === 'en'
              ? 'Buttons, Shortcuts & Indicators'
              : 'Кнопки, горячие клавиши и индикаторы'}
          </h2>
        </div>

        {/* Switching pages */}
        <div id="switching-pages" className="space-y-3">
          <h3 className="text-lg font-bold text-[#e8d080]">
            {lang === 'en' ? 'Switching pages' : 'Переключение страниц'}
          </h3>

          <p className="text-sm leading-relaxed text-[#c8b890]">
            {lang === 'en'
              ? 'Use the sidebar to switch between:'
              : 'Боковая панель переключает между страницами:'}
          </p>

          <ul className="list-disc pl-5 text-sm leading-relaxed text-[#c8b890] space-y-1.5">
            {SIDEBAR_PAGES.map((page) => (
              <li key={page.name}>
                {page.target ? (
                  <>
                    <button
                      type="button"
                      onClick={() => scrollToSection(page.target)}
                      className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2 font-bold"
                    >
                      {page.name}
                    </button>
                    {' — '}
                  </>
                ) : (
                  <strong className="text-[#f0e6c8]">{page.name}</strong>
                )}
                {lang === 'en' ? page.descEn : page.descRu}
              </li>
            ))}
          </ul>
        </div>

        {/* Floating controls table */}
        <div id="floating-controls" className="space-y-3">
          <h3 className="text-lg font-bold text-[#e8d080]">
            {lang === 'en' ? 'Floating controls' : 'Плавающие элементы управления'}
          </h3>

          <div className="overflow-x-auto rounded-lg border border-[#4a453a] bg-[#12100d]">
            <table className="w-full text-left text-xs text-[#d4c4a0] border-collapse">
              <thead>
                <tr className="border-b border-[#3a3528] bg-[#1c1914] text-[#f0e6c8] font-mono">
                  <th className="py-2.5 px-3">CONTROL</th>
                  <th className="py-2.5 px-3">LOCATION</th>
                  <th className="py-2.5 px-3">FUNCTION</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2a261f]">
                {FLOATING_CONTROLS_DATA.map((btn, idx) => (
                  <tr key={idx} className="hover:bg-[#191611]">
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2">
                        <img
                          src={btn.image}
                          alt={btn.nameEn}
                          className="w-5 h-5 rounded object-contain bg-[#1c1914] p-0.5 border border-[#3a3528]"
                        />
                        <span className="font-bold text-[#f0e6c8]">
                          {lang === 'en' ? btn.nameEn : btn.nameRu}
                        </span>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-[#c8a860]">
                      {lang === 'en' ? btn.whereEn : btn.whereRu}
                    </td>
                    <td className="py-2.5 px-3 leading-relaxed text-[#bfae90]">
                      {lang === 'en' ? btn.descEn : btn.descRu}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Sidebar Activity Lamps */}
        <div id="activity-lamps" className="rounded-lg border border-[#3a3528] bg-[#13110d] p-4">
          <h3 className="text-base font-bold text-[#e8d080] mb-2 flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            {lang === 'en' ? 'Sidebar Activity Lamps' : 'Светодиодные индикаторы активности'}
          </h3>
          <p className="text-xs text-[#c8b890] leading-relaxed">
            {lang === 'en'
              ? 'Each output button on the sidebar has a small blinking green LED in its top-right corner: it pulses while the PDP‑11 writes output to that console/terminal (and blinks continuously during active print jobs on the Printer button), switching off half a second after transmission completes.'
              : 'Каждая кнопка вывода в боковой панели оснащена маленьким мигающим зеленым светодиодом: он пульсирует, пока процессор PDP-11 передает данные на этот терминал (и непрерывно мигает во время печати документа на вкладке Printer), выключаясь через полсекунды после завершения.'}
          </p>
        </div>

        {/* Keyboard shortcuts */}
        <div id="keyboard-shortcuts" className="space-y-3">
          <h3 className="text-lg font-bold text-[#e8d080]">
            {lang === 'en' ? 'Keyboard shortcuts' : 'Сочетания клавиш'}
          </h3>

          <div className="overflow-x-auto rounded-lg border border-[#4a453a] bg-[#12100d]">
            <table className="w-full text-left text-xs text-[#d4c4a0] border-collapse">
              <thead>
                <tr className="border-b border-[#3a3528] bg-[#1c1914] text-[#f0e6c8] font-mono">
                  <th className="py-2.5 px-3">SHORTCUT</th>
                  <th className="py-2.5 px-3">WHERE</th>
                  <th className="py-2.5 px-3">WHAT IT DOES</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2a261f]">
                {KEYBOARD_SHORTCUTS.map((sc) => (
                  <tr key={sc.keys} className="hover:bg-[#191611]">
                    <td className="py-2.5 px-3">
                      <code className="font-mono font-bold text-[#e8d080]">{sc.keys}</code>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-[#c8a860]">
                      {lang === 'en' ? sc.whereEn : sc.whereRu}
                    </td>
                    <td className="py-2.5 px-3 leading-relaxed text-[#bfae90]">
                      {lang === 'en' ? sc.whatEn : sc.whatRu}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* SECTION 12: TROUBLESHOOTING */}
      <section id="troubleshooting" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§12</span>
            {lang === 'en' ? 'Troubleshooting' : 'Устранение неполадок'}
          </h2>
        </div>

        <div
          id="an-image-cannot-be-loaded"
          className="rounded-lg border border-[#4a453a] bg-[#14120e] p-4 space-y-4 scroll-mt-20"
        >
          <h3 className="text-base font-bold text-[#e8d080]">
            {lang === 'en' ? 'An image cannot be loaded' : 'Ошибка загрузки образа диска'}
          </h3>

          <p className="text-xs sm:text-sm text-[#c8b890] leading-relaxed">
            {lang === 'en' ? (
              <>
                If a guest OS image cannot be fetched completely (e.g. a large BSD image dropped by network
                interruption or missing in the Minimal desktop build), a helpful modal dialog appears offering an{' '}
                <strong className="text-[#f0e6c8]">Open Storage</strong> button. This jumps straight to the
                drop zone for immediate manual drag-and-drop of the file.
              </>
            ) : (
              <>
                Если образ гостевой ОС не может быть полностью загружен (например, обрыв сети при скачивании
                тяжелого диска BSD или образ отсутствует в сборке Minimal), эмулятор открывает диалоговое
                окно с кнопкой <strong className="text-[#f0e6c8]">Open Storage</strong>, переводящей
                напрямую к зоне перетаскивания файла.
              </>
            )}
          </p>

          <p className="text-xs sm:text-sm text-[#c8b890] leading-relaxed">
            {lang === 'en'
              ? 'The wording adapts to the environment: a page opened as a local file:// explains that the browser blocks fetching the media directory (and suggests a local web server), while the Tauri Minimal build explains that the image is not shipped and points to the drop zone.'
              : 'Формулировка подстраивается под окружение: страница, открытая как локальный file://, объясняет, что браузер блокирует загрузку каталога с медиа (и предлагает локальный веб-сервер), а сборка Tauri Minimal объясняет, что образ не входит в поставку, и указывает на зону перетаскивания.'}
          </p>

          <div className="rounded border border-[#4a453a] bg-[#12100d] p-2 max-w-lg mx-auto">
            <img
              src="assets/images/manual/dialog-imgerror.png"
              alt="Image load failure dialog"
              className="w-full h-auto rounded cursor-pointer"
              onClick={() =>
                openImage('assets/images/manual/dialog-imgerror.png', 'Image load failure dialog')
              }
            />
            <p className="mt-1.5 text-center text-[11px] text-[#8a7650] italic">
              {lang === 'en'
                ? 'An incomplete image triggers this dialog with an Open Storage shortcut.'
                : 'Диалог при незавершенной загрузке с кнопкой быстрого перехода в Storage.'}
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-[#4a453a] bg-[#14120e] p-4 space-y-4">
          <h3 className="text-base font-bold text-[#e8d080]">
            {lang === 'en' ? 'The machine stops by itself' : 'Машина останавливается сама'}
          </h3>

          <p className="text-xs sm:text-sm text-[#c8b890] leading-relaxed">
            {lang === 'en'
              ? 'When the guest executes a HALT instruction, or the emulator cuts off a runaway trap, the machine really stops: the output goes silent and the RUN light goes out. The emulator says so instead of leaving you in front of a frozen screen — a toast names the address (octal, the way DEC wrote addresses) and what to do: CONT continues from where it stopped, RESET or a reboot starts over.'
              : 'Когда гость выполняет инструкцию HALT или эмулятор обрывает ушедшую в рекурсию ловушку, машина действительно встаёт: вывод замолкает, лампа RUN гаснет. Эмулятор сообщает об этом, а не оставляет вас перед застывшим экраном: в уведомлении видны адрес (в восьмеричной системе, как писали адреса в DEC) и что делать — CONT продолжит с места остановки, RESET или перезагрузка начнут заново.'}
          </p>

          <ul className="text-xs sm:text-sm text-[#c8b890] leading-relaxed list-disc pl-5 space-y-1.5">
            <li>
              {lang === 'en'
                ? 'A stop at 000002 or 000004 means the CPU trapped into an empty vector — what a failed boot or a broken bootstrap leaves behind: reboot or boot again. With Boot device set to None there is no bootstrap at all, so a powered-on machine just rests halted and says so as a note rather than an error.'
                : 'Остановка на адресе 000002 или 000004 означает, что процессор ушёл в пустой вектор — так выглядит неудачная загрузка или испорченный бутстрап: перезагрузите машину или загрузитесь снова. Когда в качестве загрузочного устройства выбрано None, бутстрапа нет вовсе: включённая машина просто стоит на останове, и сообщение об этом — пояснение, а не ошибка.'}
            </li>
            <li>
              {lang === 'en'
                ? 'The pause icon on the PANEL button keeps the last stop as a tooltip, so the reason is still readable after the toast is gone; clicking the button shows the notice again.'
                : 'Значок паузы на кнопке PANEL хранит причину последней остановки в подсказке, поэтому её можно прочитать и после исчезновения уведомления; клик по кнопке показывает сообщение снова.'}
            </li>
            <li>
              {lang === 'en'
                ? 'A stop you caused yourself — the HALT switch on the panel, or one STEP pass — is not announced at all: nothing unexpected happened.'
                : 'Остановка, которую вызвали вы сами, — тумблер HALT на панели или один проход в режиме STEP — не объявляется: ничего неожиданного не случилось.'}
            </li>
          </ul>

          <div className="rounded border border-[#4a453a] bg-[#12100d] p-2 max-w-lg mx-auto">
            <img
              src="assets/images/manual/dialog-halt-toast.png"
              alt="The halt notice"
              className="w-full h-auto rounded cursor-pointer"
              onClick={() =>
                openImage(
                  'assets/images/manual/dialog-halt-toast.png',
                  lang === 'en' ? 'The halt notice names the address and the way out' : 'Уведомление об остановке: адрес и что делать'
                )
              }
            />
            <p className="mt-1.5 text-center text-[11px] text-[#8a7650] italic">
              {lang === 'en'
                ? 'A halted machine explains itself: the address in octal and the way out.'
                : 'Остановившаяся машина объясняет себя: адрес в восьмеричной системе и что делать.'}
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-[#4a453a] bg-[#14120e] p-4 space-y-4">
          <h3 className="text-base font-bold text-[#e8d080]">
            {lang === 'en' ? 'A snapshot is refused after an image update' : 'Снапшот отклонён после обновления образа'}
          </h3>

          <p className="text-xs sm:text-sm text-[#c8b890] leading-relaxed">
            {lang === 'en' ? (
              <>
                A snapshot stores the machine’s memory and registers, not the disk image itself: on restore it is
                layered back onto the disk the emulator currently ships — or onto the exact image the snapshot pinned
                by SHA-256, fetched from the media registry. A <strong className="text-[#f0e6c8]">self-contained</strong>{' '}
                state carries its images inside the file, so an image update does not affect it at all. If the disk has
                been <strong className="text-[#f0e6c8]">updated</strong> since the snapshot was taken, the two no longer
                match — the guest’s file system in memory would not describe the disk underneath it, which shows up as a
                corrupted file system rather than as anything obvious.
              </>
            ) : (
              <>
                Снапшот хранит память и регистры машины, а не сам образ диска: при восстановлении он накладывается на
                тот диск, который эмулятор поставляет сейчас, — или на точный образ, закреплённый в снапшоте по
                SHA-256 и скачанный из реестра образов.{' '}
                <strong className="text-[#f0e6c8]">Самодостаточное</strong> состояние несёт образы внутри файла,
                поэтому обновление образа его вообще не затрагивает. Если образ с тех пор{' '}
                <strong className="text-[#f0e6c8]">обновили</strong>, они перестают совпадать — файловая система гостя
                в памяти перестаёт описывать лежащий под ней диск, и это проявляется как повреждённая файловая
                система, а не как что-то очевидное.
              </>
            )}
          </p>

          <p className="text-xs sm:text-sm text-[#c8b890] leading-relaxed">
            {lang === 'en'
              ? 'The emulator detects this and refuses the restore instead of corrupting the disk. It names the image and both builds, and offers to delete the snapshot:'
              : 'Эмулятор это обнаруживает и отказывается восстанавливать снапшот вместо того, чтобы испортить диск. Он называет образ и обе сборки и предлагает удалить снапшот:'}
          </p>

          <div className="rounded border border-[#4a453a] bg-[#12100d] p-2 max-w-lg mx-auto">
            <img
              src="assets/images/manual/dialog-snapshot-incompatible.png"
              alt="Snapshot taken on a different build"
              className="w-full h-auto rounded cursor-pointer"
              onClick={() =>
                openImage(
                  'assets/images/manual/dialog-snapshot-incompatible.png',
                  lang === 'en' ? 'Snapshot taken on a different build' : 'Снапшот снят на другой сборке'
                )
              }
            />
            <p className="mt-1.5 text-center text-[11px] text-[#8a7650] italic">
              {lang === 'en'
                ? 'The snapshot was taken on a different build of the disk: it is not restored, and can be deleted from here.'
                : 'Снапшот снят на другой сборке диска: он не восстанавливается, и его можно удалить прямо отсюда.'}
            </p>
          </div>

          <p className="text-xs sm:text-sm text-[#c8b890] leading-relaxed">
            {lang === 'en'
              ? 'Take a fresh snapshot on the current build, or delete the stale one — a snapshot cannot be migrated onto a disk it was not taken from.'
              : 'Сделайте новый снапшот на текущей сборке или удалите устаревший — перенести снапшот на диск, с которого он не снимался, нельзя.'}
          </p>
        </div>

        <div className="rounded-lg border border-[#4a453a] bg-[#14120e] p-4 space-y-4">
          <h3 className="text-base font-bold text-[#e8d080]">
            {lang === 'en'
              ? 'A state needs a disk that only this browser has'
              : 'Состоянию нужен диск, который есть только в этом браузере'}
          </h3>

          <p className="text-xs sm:text-sm text-[#c8b890] leading-relaxed">
            {lang === 'en' ? (
              <>
                A disk you dropped in or imported yourself has no published version, so a state taken on it
                restores in this browser only — saving such a state says so in a toast. Bytes already loaded here
                are found even under another file name, because the{' '}
                <strong className="text-[#f0e6c8]">digest</strong> decides, not the name.
              </>
            ) : (
              <>
                У диска, который вы перетащили или импортировали сами, нет опубликованной версии, поэтому
                состояние, снятое на нём, восстанавливается только в этом браузере — при сохранении такого
                состояния появляется предупреждение. Уже загруженные здесь байты находятся даже под другим именем
                файла: решает <strong className="text-[#f0e6c8]">дайджест</strong>, а не имя.
              </>
            )}
          </p>

          <p className="text-xs sm:text-sm text-[#c8b890] leading-relaxed">
            {lang === 'en'
              ? 'If the restore is refused because of such a disk, the dialog offers Use my own copy of this disk… Pick the file: the digest the state was saved with decides, so a copy with the right contents is accepted under any name, a wrong file changes nothing, and the restore then runs again by itself. To make such a state portable from the start, export it with Make state self-contained.'
              : 'Если восстановление отклонено из-за такого диска, в диалоге есть кнопка «Use my own copy of this disk…». Выберите файл: решает дайджест, с которым состояние было сохранено, поэтому копия с правильным содержимым принимается под любым именем, чужой файл ничего не меняет, а восстановление затем запускается само. Чтобы состояние сразу было переносимым, экспортируйте его с включённым «Make state self-contained».'}
          </p>
        </div>

        <div className="rounded-lg border border-[#4a453a] bg-[#14120e] p-4 space-y-4">
          <h3 className="text-base font-bold text-[#e8d080]">
            {lang === 'en' ? 'The guest OS does not boot' : 'Гостевая ОС не загружается'}
          </h3>

          <p className="text-xs sm:text-sm text-[#c8b890] leading-relaxed">
            {lang === 'en'
              ? 'If the machine halts at the @ prompt or shows an error instead of booting:'
              : 'Если машина останавливается на приглашении @ или показывает ошибку вместо загрузки:'}
          </p>

          <ul className="list-disc pl-5 text-xs sm:text-sm leading-relaxed text-[#c8b890] space-y-1.5">
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Wrong boot command.' : 'Неверная команда загрузки.'}</strong>{' '}
              {lang === 'en' ? 'Each guest OS has its own boot command — see the ' : 'У каждой гостевой ОС своя команда — сверьтесь с '}
              <button
                type="button"
                onClick={() => scrollToSection('guest-oses')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'guest OS table' : 'таблицей гостевых ОС'}
              </button>
              {lang === 'en' ? '. Typing ' : '. Команда '}
              <code className="font-mono text-[#e8d080]">boot rk0</code>
              {lang === 'en' ? ' on a system that expects ' : ' на системе, ожидающей '}
              <code className="font-mono text-[#e8d080]">boot rp1</code>
              {lang === 'en' ? ' will not start it.' : ', не запустит её.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Wrong machine profile.' : 'Неверный профиль машины.'}</strong>{' '}
              {lang === 'en' ? 'Some guests need the ' : 'Некоторым гостям требуется '}
              <button
                type="button"
                onClick={() => scrollToSection('printer')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'LP11 line printer' : 'построчный принтер LP11'}
              </button>
              {lang === 'en' ? ' or a teletype console. The ' : ' или консоль-телетайп. '}
              <button
                type="button"
                onClick={() => scrollToSection('quick-start')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'quick-boot wizard' : 'Мастер быстрого запуска'}
              </button>
              {lang === 'en' ? ' sets these automatically; when booting manually, check the ' : ' выставляет их автоматически; при ручной загрузке проверьте '}
              <button
                type="button"
                onClick={() => scrollToSection('config')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'Config page' : 'страницу Config'}
              </button>
              {lang === 'en' ? ' for the required peripherals.' : '.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Corrupted or missing image.' : 'Повреждённый или отсутствующий образ.'}</strong>{' '}
              {lang === 'en' ? 'If the image did not download fully, the emulator shows an ' : 'Если образ загрузился не полностью, эмулятор покажет диалог '}
              <button
                type="button"
                onClick={() => scrollToSection('an-image-cannot-be-loaded')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'image load failure' : 'ошибки загрузки образа'}
              </button>
              {lang === 'en' ? ' dialog. Re-download or drag & drop the image file onto the ' : '. Скачайте образ заново или перетащите файл на страницу '}
              <button
                type="button"
                onClick={() => scrollToSection('storage')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'Storage' : 'Storage'}
              </button>
              {lang === 'en' ? ' page.' : '.'}
            </li>
          </ul>
        </div>

        <div className="rounded-lg border border-[#4a453a] bg-[#14120e] p-4 space-y-4">
          <h3 className="text-base font-bold text-[#e8d080]">
            {lang === 'en' ? 'The keyboard does not type' : 'Клавиатура не вводит'}
          </h3>

          <p className="text-xs sm:text-sm text-[#c8b890] leading-relaxed">
            {lang === 'en'
              ? 'If keystrokes produce no visible output on the console or terminal:'
              : 'Если нажатия клавиш не дают видимого вывода на консоли или терминале:'}
          </p>

          <ul className="list-disc pl-5 text-xs sm:text-sm leading-relaxed text-[#c8b890] space-y-1.5">
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Wrong keyboard layout.' : 'Не та раскладка.'}</strong>{' '}
              {lang === 'en' ? 'The most obvious reason — just switch to English.' : 'Самая очевидная причина — просто переключите раскладку на английскую.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Input is locked.' : 'Ввод заблокирован.'}</strong>{' '}
              {lang === 'en' ? 'During an ' : 'Во время '}
              <button
                type="button"
                onClick={() => scrollToSection('quick-start')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'autoload' : 'автозагрузки'}
              </button>
              {lang === 'en' ? ' the emulator locks all input. Click ' : ' эмулятор блокирует весь ввод. Нажмите '}
              <strong className="text-[#f0e6c8]">Take control!</strong>
              {lang === 'en' ? ' in the toast to unlock.' : ' в уведомлении, чтобы разблокировать.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Wrong terminal selected.' : 'Не тот терминал.'}</strong>{' '}
              {lang === 'en'
                ? 'Click the console or terminal page in the sidebar — the active page has a highlighted border. Only the active page receives keyboard input.'
                : 'Нажмите на страницу консоли или терминала на боковой панели — активная страница выделена рамкой. Только активная страница получает ввод с клавиатуры.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Teletype upper-case only.' : 'Телетайп только заглавные.'}</strong>{' '}
              {lang === 'en' ? 'When the ' : 'Когда опция '}
              <strong className="text-[#f0e6c8]">Upper Case Only</strong>
              {lang === 'en' ? ' option on the ' : ' на '}
              <button
                type="button"
                onClick={() => scrollToSection('config')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'Config page' : 'странице CONFIG'}
              </button>
              {lang === 'en'
                ? ' is on, the teletype folds lower-case letters to upper-case. This is normal for guests that expect upper-case input.'
                : ' включена, телетайп преобразует строчные буквы в заглавные. Это нормально для гостей, ожидающих ввод заглавными.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Browser focus.' : 'Фокус браузера.'}</strong>{' '}
              {lang === 'en'
                ? 'Click inside the terminal area to ensure the page has focus. Some browsers require an explicit click before they forward keystrokes.'
                : 'Щёлкните внутри области терминала, чтобы страница получила фокус. Некоторые браузеры требуют явного клика перед передачей нажатий клавиш.'}
            </li>
          </ul>
        </div>

        <div className="rounded-lg border border-[#4a453a] bg-[#14120e] p-4 space-y-4">
          <h3 className="text-base font-bold text-[#e8d080]">
            {lang === 'en' ? 'No sound' : 'Нет звука'}
          </h3>

          <p className="text-xs sm:text-sm text-[#c8b890] leading-relaxed">
            {lang === 'en' ? 'If the emulator is silent:' : 'Если эмулятор беззвучен:'}
          </p>

          <ul className="list-disc pl-5 text-xs sm:text-sm leading-relaxed text-[#c8b890] space-y-1.5">
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Mute is on.' : 'Mute включён.'}</strong>{' '}
              {lang === 'en' ? 'Click the ' : 'Нажмите кнопку '}
              <strong className="text-[#f0e6c8]">Mute</strong>
              {lang === 'en'
                ? ' button (bottom-left corner, just right of the sidebar) to toggle sound back on. The mute state is persisted across sessions.'
                : ' (левый нижний угол, справа от боковой панели), чтобы включить звук. Состояние сохраняется между сессиями.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Browser sound.' : 'Звук браузера.'}</strong>{' '}
              {lang === 'en'
                ? 'Check that your browser’s sound is not muted for the page or tab.'
                : 'Проверьте, что звук в браузере не отключён для этой страницы или вкладки.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Desktop build.' : 'Настольное приложение.'}</strong>{' '}
              {lang === 'en'
                ? 'The Tauri desktop app uses the same sound settings as the browser version. Check the system volume mixer for the application.'
                : 'Настольное приложение Tauri использует те же настройки звука, что и браузерная версия. Проверьте системный микшер громкости.'}
            </li>
          </ul>
        </div>

        <div className="rounded-lg border border-[#4a453a] bg-[#14120e] p-4 space-y-4">
          <h3 className="text-base font-bold text-[#e8d080]">
            {lang === 'en' ? 'Poor performance' : 'Низкая производительность'}
          </h3>

          <p className="text-xs sm:text-sm text-[#c8b890] leading-relaxed">
            {lang === 'en' ? 'If the emulator feels sluggish:' : 'Если эмулятор работает медленно:'}
          </p>

          <ul className="list-disc pl-5 text-xs sm:text-sm leading-relaxed text-[#c8b890] space-y-1.5">
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Browser vs desktop.' : 'Браузер против настольного приложения.'}</strong>{' '}
              {lang === 'en' ? 'The browser version shares resources with other tabs. Close unused tabs or switch to the ' : 'Браузерная версия делит ресурсы с другими вкладками. Закройте неиспользуемые вкладки или переключитесь на '}
              <button
                type="button"
                onClick={() => scrollToSection('desktop')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'Tauri desktop app' : 'настольное приложение Tauri'}
              </button>
              {lang === 'en' ? ' for dedicated performance.' : '.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Video terminals.' : 'Видеотерминалы.'}</strong>{' '}
              {lang === 'en' ? 'A VT100 or VT52 terminal with scanline effects uses more CPU than the teletype. Switch to the teletype console in ' : 'VT100 или VT52 с эффектами развёртки потребляют больше ресурсов ЦП, чем телетайп. Переключитесь на консоль-телетайп в '}
              <button
                type="button"
                onClick={() => scrollToSection('config')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'Config' : 'Config'}
              </button>
              {lang === 'en' ? ' if performance is critical.' : ', если производительность критична.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Animation.' : 'Анимация.'}</strong>{' '}
              {lang === 'en' ? 'The LP11 line printer and paper-tape machines animate during operation. Disable them in ' : 'Построчный принтер LP11 и перфоленты анимированы при работе. Отключите их в '}
              <button
                type="button"
                onClick={() => scrollToSection('config')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'Config' : 'Config'}
              </button>
              {lang === 'en' ? ' if they are not needed.' : ', если они не нужны.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Network.' : 'Сеть.'}</strong>{' '}
              {lang === 'en'
                ? 'Large disk images load over the network on first access. The Loading N% bar shows progress; once cached, subsequent boots are faster.'
                : 'Большие образы дисков при первом доступе загружаются по сети. Полоса Loading N% показывает прогресс; после кеширования последующие загрузки быстрее.'}
            </li>
          </ul>
        </div>

        <div className="rounded-lg border border-[#4a453a] bg-[#14120e] p-4 space-y-4">
          <h3 className="text-base font-bold text-[#e8d080]">
            {lang === 'en' ? 'The screen is blank' : 'Экран пуст'}
          </h3>

          <p className="text-xs sm:text-sm text-[#c8b890] leading-relaxed">
            {lang === 'en' ? 'If a terminal page shows nothing:' : 'Если страница терминала ничего не показывает:'}
          </p>

          <ul className="list-disc pl-5 text-xs sm:text-sm leading-relaxed text-[#c8b890] space-y-1.5">
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Machine is off.' : 'Машина выключена.'}</strong>{' '}
              {lang === 'en'
                ? 'Check the front-panel POWER LOCK switch. The machine must be powered on to produce output.'
                : 'Проверьте переключатель POWER LOCK на пультовой панели. Машина должна быть включена, чтобы выдавать вывод.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Wrong page.' : 'Не та страница.'}</strong>{' '}
              {lang === 'en' ? 'The console and terminals show output only when the guest OS writes to them. Switch to the ' : 'Консоль и терминалы показывают вывод только когда гостевая ОС в них пишет. Переключитесь на страницу '}
              <button
                type="button"
                onClick={() => scrollToSection('console')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'Console' : 'Console'}
              </button>
              {lang === 'en' ? ' page to see the boot sequence.' : ', чтобы увидеть последовательность загрузки.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Display page not configured.' : 'Страница Display не настроена.'}</strong>{' '}
              {lang === 'en' ? 'The ' : ''}
              <button
                type="button"
                onClick={() => scrollToSection('vt11')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'VT11 vector display' : 'Векторный дисплей VT11'}
              </button>
              {lang === 'en' ? ' is optional and must be enabled in ' : ' опционален и должен быть включён в '}
              <button
                type="button"
                onClick={() => scrollToSection('config')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'Config' : 'Config'}
              </button>
              {lang === 'en' ? '. Without it, the Display page stays blank.' : '. Без него страница Display остаётся пустой.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Browser zoom.' : 'Масштаб браузера.'}</strong>{' '}
              {lang === 'en'
                ? 'Accidental browser zoom can push the terminal content off-screen. Reset zoom with Ctrl+0 (Cmd+0 on macOS).'
                : 'Случайное изменение масштаба браузера может сдвинуть содержимое терминала за пределы экрана. Сбросьте масштаб комбинацией Ctrl+0 (Cmd+0 на macOS).'}
            </li>
          </ul>
        </div>

        <div className="rounded-lg border border-[#4a453a] bg-[#14120e] p-4 space-y-4">
          <h3 className="text-base font-bold text-[#e8d080]">
            {lang === 'en' ? 'CORS errors in the browser version' : 'Ошибки CORS в браузерной версии'}
          </h3>

          <p className="text-xs sm:text-sm text-[#c8b890] leading-relaxed">
            {lang === 'en'
              ? 'If the emulator page shows a CORS error when loading images or media:'
              : 'Если страница эмулятора показывает ошибку CORS при загрузке изображений или медиа:'}
          </p>

          <ul className="list-disc pl-5 text-xs sm:text-sm leading-relaxed text-[#c8b890] space-y-1.5">
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'file:// protocol.' : 'Протокол file://.'}</strong>{' '}
              {lang === 'en' ? 'Opening ' : 'Открытие '}
              <code className="font-mono text-[#e8d080]">pdp11.html</code>
              {lang === 'en' ? ' as a local file (' : ' как локального файла ('}
              <code className="font-mono text-[#e8d080]">file://</code>
              {lang === 'en'
                ? ') triggers browser CORS policies. Use a local web server instead — or open the page through the Launch Online! link on the landing page.'
                : ') вызывает политики CORS браузера. Используйте локальный веб-сервер — или откройте страницу через ссылку Launch Online! на главной странице.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'The built-in server.' : 'Встроенный сервер.'}</strong>{' '}
              {lang === 'en' ? 'Run ' : 'Запустите '}
              <code className="font-mono text-[#e8d080]">npm run serve</code>
              {lang === 'en'
                ? ' from the repository root to start a local HTTP server on port 1187, then open http://127.0.0.1:1187/pdp11.html.'
                : ' из корня репозитория, чтобы запустить локальный HTTP-сервер на порту 1187, затем откройте http://127.0.0.1:1187/pdp11.html.'}
            </li>
            <li>
              <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Tauri desktop.' : 'Настольное приложение Tauri.'}</strong>{' '}
              {lang === 'en' ? 'The ' : ''}
              <button
                type="button"
                onClick={() => scrollToSection('desktop')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                {lang === 'en' ? 'desktop app' : 'настольное приложение'}
              </button>
              {lang === 'en' ? ' has no CORS restrictions — it bundles its own server.' : ' не имеет ограничений CORS — оно использует собственный сервер.'}
            </li>
          </ul>
        </div>
      </section>

      {/* SECTION 13: HISTORICAL FIDELITY AND LIMITATIONS */}
      <section id="fidelity" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§13</span>
            {lang === 'en' ? 'Historical Fidelity and Limitations' : 'Историческая достоверность и ограничения'}
          </h2>
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'yaPDP is an interactive environment for exploring the PDP-11/70 and the software ecosystem built around it. Its goal is to make historical computing tangible: start a machine, inspect its front panel, boot an operating system, run a program, and explore how people interacted with computers of this era.'
            : 'yaPDP — интерактивная среда для знакомства с PDP-11/70 и программной экосистемой, которая вокруг неё сформировалась. Цель проекта — сделать историю вычислительной техники осязаемой: запустить машину, изучить её переднюю панель, загрузить операционную систему, выполнить программу и посмотреть, как люди взаимодействовали с компьютерами той эпохи.'}
        </p>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'Historical fidelity is important to that experience, but it does not mean that every component is reproduced with identical depth. yaPDP combines emulation, practical approximations, and interface design intended to make the environment approachable in a modern browser.'
            : 'Историческая достоверность важна для такого опыта, но она не означает, что все компоненты воспроизводятся с одинаковой степенью подробности. yaPDP объединяет эмуляцию, практические упрощения и интерфейсные решения, призванные сделать историческую вычислительную среду доступной в современном браузере.'}
        </p>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'This chapter explains how to interpret the experience and where to be cautious.'
            : 'В этой главе объясняется, как воспринимать этот опыт и какие ограничения следует учитывать.'}
        </p>

        <h3 id="fidelity-what-is-preserved" className="text-lg font-semibold text-[#f0e6c8] pt-2">
          {lang === 'en' ? 'What yaPDP aims to preserve' : 'Что стремится сохранить yaPDP'}
        </h3>

        <h4 className="text-sm font-bold text-[#e8d080] pt-1">
          {lang === 'en' ? 'The computing environment' : 'Вычислительная среда целиком'}
        </h4>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'yaPDP is designed around the PDP-11/70 and the experience of using a period-style computer system, rather than presenting a processor as an isolated programming target. The front panel, operating-system startup, interactive programs, storage devices, and peripheral interfaces help establish that wider context.'
            : 'yaPDP построен вокруг PDP-11/70 и опыта работы с компьютерной системой соответствующей эпохи, а не только вокруг процессора как изолированного объекта программирования. Передняя панель, загрузка операционной системы, интерактивные программы, накопители и периферийные интерфейсы помогают увидеть более широкий контекст.'}
        </p>

        <h4 className="text-sm font-bold text-[#e8d080] pt-1">
          {lang === 'en' ? 'Real software and meaningful machine states' : 'Настоящее программное обеспечение и осмысленные состояния машины'}
        </h4>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'Where supported, yaPDP runs historical operating systems and programs in the emulated environment. Prepared machine states can place a visitor at a useful point in that experience: for example, ready to launch a program or already inside a demonstration.'
            : 'Там, где это поддерживается, yaPDP запускает исторические операционные системы и программы в эмулируемой среде. Подготовленные состояния машины позволяют сразу оказаться в интересной точке этого опыта: например, в готовности к запуску программы или уже внутри демонстрационного сценария.'}
        </p>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'A saved state is a practical entry point, not by itself proof that every detail of the surrounding hardware has been reproduced exactly. The software, machine configuration, required disk images, and state format all affect what can be restored and experienced.'
            : 'Сохранённое состояние — удобная отправная точка, но само по себе оно не доказывает, что всё окружающее оборудование воспроизведено с абсолютной точностью. На то, что удастся восстановить и исследовать, влияют программное обеспечение, конфигурация машины, необходимые дисковые образы и формат состояния.'}
        </p>

        <h4 className="text-sm font-bold text-[#e8d080] pt-1">
          {lang === 'en' ? 'Hardware-inspired interaction' : 'Взаимодействие, вдохновлённое реальным оборудованием'}
        </h4>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'The interface is intended to communicate the character of historical equipment. Controls and indicators are useful both for operating the emulated machine and for understanding the role of physical controls on systems such as the PDP-11/70.'
            : 'Интерфейс призван передать характер исторической аппаратуры. Органы управления и индикаторы нужны как для работы с эмулируемой машиной, так и для понимания назначения физических элементов таких систем, как PDP-11/70.'}
        </p>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'Visual similarity and functional fidelity are related, but distinct. A control may look like its historical counterpart without modelling every electrical or mechanical detail of the original device.'
            : 'Визуальное сходство и функциональная достоверность связаны, но не тождественны. Элемент интерфейса может выглядеть как исторический оригинал, не моделируя при этом все электрические или механические особенности реального устройства.'}
        </p>

        <h3 id="fidelity-keep-in-mind" className="text-lg font-semibold text-[#f0e6c8] pt-2">
          {lang === 'en' ? 'What to keep in mind' : 'Что следует учитывать'}
        </h3>

        <h4 className="text-sm font-bold text-[#e8d080] pt-1">
          {lang === 'en' ? 'Emulation is not the same as a complete physical replica' : 'Эмуляция — не то же самое, что полная физическая копия'}
        </h4>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'yaPDP is software running on a modern computer. Its timing, rendering, input handling, storage, and browser integration are necessarily mediated by the host environment. It should not be assumed to reproduce every timing-sensitive hardware effect, electrical characteristic, mechanical behaviour, or failure mode of the original equipment.'
            : 'yaPDP — программная система, работающая на современном компьютере. Её временные характеристики, отрисовка, обработка ввода, хранение данных и интеграция с браузером неизбежно зависят от среды исполнения. Не следует считать, что она воспроизводит все чувствительные к времени аппаратные эффекты, электрические характеристики, механическое поведение или режимы отказа оригинального оборудования.'}
        </p>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'The exact level of fidelity can differ between the CPU, memory, individual devices, and the user interface. Do not infer cycle-accurate or component-level accuracy unless it is explicitly documented for the relevant subsystem.'
            : 'Степень достоверности может различаться для процессора, памяти, отдельных устройств и пользовательского интерфейса. Не следует предполагать точность до такта или на уровне каждого компонента, если она прямо не заявлена в документации соответствующей подсистемы.'}
        </p>

        <h4 className="text-sm font-bold text-[#e8d080] pt-1">
          {lang === 'en' ? 'Peripheral devices may be modelled to different depths' : 'Периферийные устройства могут моделироваться с разной степенью подробности'}
        </h4>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'Historical computer systems depended on devices such as terminals, paper-tape equipment, disks, and printers. In an interactive emulator, these devices also have to work through modern input and display mechanisms.'
            : 'Исторические компьютерные системы зависели от таких устройств, как терминалы, оборудование для бумажной ленты, дисковые накопители и принтеры. В интерактивном эмуляторе эти устройства должны также работать через современные механизмы ввода и отображения.'}
        </p>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'Depending on the device and feature, yaPDP may prioritise the aspects that matter most to the user-visible workflow — for example, entering characters, displaying output, or exploring a prepared scenario — rather than modelling every physical detail of the original mechanism.'
            : 'В зависимости от устройства и функции yaPDP может уделять приоритетное внимание тем аспектам, которые важнее всего для пользовательского сценария: например, вводу символов, отображению вывода или исследованию подготовленной ситуации. При этом не обязательно моделируется каждая физическая особенность оригинального механизма.'}
        </p>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'Treat device-specific documentation as the source of truth for a particular peripheral. If a behaviour is not documented or tested, do not assume that it matches the original hardware in every respect.'
            : 'Для конкретной периферии следует обращаться к её собственной документации. Если какое-то поведение не описано и не проверено, не стоит считать, что оно во всех отношениях совпадает с работой исторического устройства.'}
        </p>

        <h4 className="text-sm font-bold text-[#e8d080] pt-1">
          {lang === 'en' ? 'Historical software has its own constraints' : 'Историческое программное обеспечение имеет собственные ограничения'}
        </h4>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'A program runs within the operating system, device configuration, and storage environment available to it. Some software may require a particular disk image, boot procedure, memory configuration, or peripheral. Other software may depend on conventions that are unfamiliar on modern systems.'
            : 'Программа работает в рамках доступных ей операционной системы, конфигурации устройств и среды хранения. Некоторому ПО могут требоваться определённый дисковый образ, процедура загрузки, конфигурация памяти или периферийное устройство. Другое ПО может опираться на соглашения, непривычные для современных систем.'}
        </p>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'A prepared state can simplify setup, but it does not remove every dependency. If a state refers to disk images or other resources that are not included in the state file, those resources must still be available to the receiving installation.'
            : 'Подготовленное состояние упрощает настройку, но не устраняет все зависимости. Если в состоянии есть ссылки на дисковые образы или другие ресурсы, которые не включены в сам файл состояния, эти ресурсы должны быть доступны и в системе получателя.'}
        </p>

        <h4 className="text-sm font-bold text-[#e8d080] pt-1">
          {lang === 'en' ? 'Browser and desktop environments can differ' : 'Браузерная и настольная среды могут различаться'}
        </h4>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'The browser and desktop versions may differ in how they package resources, store changes, access local files, or behave when offline. A feature that depends on downloading a resource or fetching a state from another site may also be affected by network access and browser security rules such as Cross-Origin Resource Sharing (CORS).'
            : 'Браузерная и настольная версии могут различаться способом поставки ресурсов, хранения изменений, доступа к локальным файлам и работой без подключения к сети. На функции, требующие загрузки ресурсов или получения состояния с другого сайта, также могут влиять доступность сети и правила безопасности браузера, например Cross-Origin Resource Sharing (CORS).'}
        </p>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en' ? (
            <>
              For shared states, the fact that a URL opens in a browser tab does not necessarily mean
              that yaPDP can fetch it from JavaScript. The hosting server must permit the relevant
              cross-origin request. See the{' '}
              <button
                type="button"
                onClick={() => scrollToSection('machine-state')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                Machine State
              </button>{' '}
              chapter for details.
            </>
          ) : (
            <>
              Для общих состояний важно помнить: если URL открывается в отдельной вкладке браузера,
              это ещё не означает, что yaPDP сможет загрузить его из JavaScript. Сервер, на котором
              размещён файл, должен разрешать соответствующий междоменный запрос. Подробности — в
              главе{' '}
              <button
                type="button"
                onClick={() => scrollToSection('machine-state')}
                className="text-[#c8a860] hover:text-[#e8d080] underline underline-offset-2"
              >
                «Управление состоянием машины»
              </button>
              .
            </>
          )}
        </p>

        <h4 className="text-sm font-bold text-[#e8d080] pt-1">
          {lang === 'en' ? 'A saved state is not a universal archival guarantee' : 'Сохранённое состояние не является универсальной гарантией архивной сохранности'}
        </h4>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'A machine state records a particular configuration and point in time according to the yaPDP state format. Restoring it successfully can depend on the yaPDP version, state schema, required resources, and compatibility handling.'
            : 'Состояние машины фиксирует определённую конфигурацию и момент времени в соответствии с форматом yaPDP. Успешное восстановление может зависеть от версии yaPDP, версии схемы состояния, наличия необходимых ресурсов и механизмов совместимости.'}
        </p>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'For long-term preservation, keep the state together with a description of its purpose, the yaPDP version used to create it, any required disk images, and instructions for reproducing the experience. Where possible, retain the original software and resource provenance as well.'
            : 'Для долговременного сохранения полезно хранить вместе с состоянием описание его назначения, версию yaPDP, в которой оно было создано, необходимые дисковые образы и инструкции по воспроизведению сценария. По возможности следует также сохранять сведения о происхождении исходного программного обеспечения и ресурсов.'}
        </p>

        <h3 id="fidelity-learning-tool" className="text-lg font-semibold text-[#f0e6c8] pt-2">
          {lang === 'en' ? 'How to use yaPDP as a historical learning tool' : 'Как использовать yaPDP для изучения истории'}
        </h3>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en' ? 'For the most useful experience:' : 'Чтобы получить наиболее полезный опыт:'}
        </p>

        <ol className="list-decimal list-inside space-y-2 text-sm leading-relaxed text-[#c8b890] pl-2">
          <li>
            <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Start with a prepared scenario.' : 'Начните с подготовленного сценария.'}</strong>{' '}
            {lang === 'en'
              ? 'It reduces setup work and lets you focus on the system or program being demonstrated.'
              : 'Это сокращает настройку и позволяет сосредоточиться на демонстрируемой системе или программе.'}
          </li>
          <li>
            <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Read the scenario notes.' : 'Прочитайте описание сценария.'}</strong>{' '}
            {lang === 'en'
              ? 'Check which operating system, disk images, peripherals, and controls it expects.'
              : 'Проверьте, какие операционная система, дисковые образы, периферия и органы управления ему необходимы.'}
          </li>
          <li>
            <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Explore the machine, not just the program.' : 'Исследуйте не только программу, но и машину.'}</strong>{' '}
            {lang === 'en'
              ? 'Notice the front panel, boot process, terminal interaction, and the role of storage and peripheral devices.'
              : 'Обратите внимание на переднюю панель, процесс загрузки, работу с терминалом, роль накопителей и периферийных устройств.'}
          </li>
          <li>
            <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Distinguish historical facts from emulator behaviour.' : 'Отличайте исторические факты от поведения эмулятора.'}</strong>{' '}
            {lang === 'en'
              ? 'Use primary documentation and subsystem notes when making claims about the original hardware.'
              : 'Если требуется сделать вывод об оригинальном оборудовании, обращайтесь к первичной документации и описаниям соответствующей подсистемы.'}
          </li>
          <li>
            <strong className="text-[#f0e6c8]">{lang === 'en' ? 'Record the conditions of an experiment.' : 'Фиксируйте условия эксперимента.'}</strong>{' '}
            {lang === 'en'
              ? 'If you share a state or document a result, include the relevant yaPDP version and any non-default resources or settings.'
              : 'При обмене состоянием или описании результата указывайте версию yaPDP, а также нестандартные ресурсы и настройки, если они использовались.'}
          </li>
        </ol>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'yaPDP can make historical systems easier to explore, but it is not a substitute for original manuals, hardware documentation, or scholarly sources when exact historical claims matter.'
            : 'yaPDP упрощает исследование исторических систем, но не заменяет оригинальные руководства, документацию на оборудование или научные источники, если важна точность исторических утверждений.'}
        </p>

        <h3 id="fidelity-reporting" className="text-lg font-semibold text-[#f0e6c8] pt-2">
          {lang === 'en' ? 'Reporting a fidelity issue' : 'Как сообщить о проблеме с исторической достоверностью'}
        </h3>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'If you find a behaviour that appears inconsistent with the historical machine or software, a useful report includes:'
            : 'Если поведение кажется несовместимым с исторической машиной или программой, полезное сообщение об ошибке должно содержать:'}
        </p>

        <ul className="list-disc pl-5 text-sm leading-relaxed text-[#c8b890] space-y-1.5">
          <li>{lang === 'en' ? 'the yaPDP version or commit;' : 'версию yaPDP или идентификатор коммита;'}</li>
          <li>{lang === 'en' ? 'the operating system, program, and machine state used;' : 'использованные операционную систему, программу и состояние машины;'}</li>
          <li>{lang === 'en' ? 'the device or behaviour in question;' : 'описание устройства или поведения, о котором идёт речь;'}</li>
          <li>{lang === 'en' ? 'the steps needed to reproduce the observation;' : 'последовательность действий, позволяющую воспроизвести наблюдение;'}</li>
          <li>
            {lang === 'en'
              ? 'what you expected to happen and the historical source supporting that expectation, if available.'
              : 'ожидаемое поведение и, если возможно, исторический источник, подтверждающий ожидание.'}
          </li>
        </ul>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'This helps distinguish an implementation defect from an intentional simplification, a software-specific limitation, or a difference caused by configuration.'
            : 'Такие сведения помогают отличить ошибку реализации от намеренного упрощения, ограничения конкретной программы или различия, вызванного конфигурацией.'}
        </p>

        <h3 id="fidelity-summary" className="text-lg font-semibold text-[#f0e6c8] pt-2">
          {lang === 'en' ? 'Summary' : 'Кратко'}
        </h3>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'yaPDP aims to offer an engaging, historically grounded way to experience the PDP-11/70 and its software environment. It combines working software with a visual and interactive model of a period computing system, while making practical trade-offs for use on modern computers.'
            : 'yaPDP стремится дать увлекательный и исторически обоснованный способ познакомиться с PDP-11/70 и её программной средой. Проект сочетает работающее программное обеспечение с визуальной и интерактивной моделью вычислительной системы той эпохи, сохраняя при этом практические компромиссы, необходимые для работы на современных компьютерах.'}
        </p>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'Use it to explore, experiment, and share reproducible moments from the machine\u2019s life. When exact hardware behaviour or historical interpretation matters, check the documentation for the specific subsystem and consult authoritative historical sources.'
            : 'Используйте yaPDP для исследования, экспериментов и обмена воспроизводимыми моментами из жизни машины. Если важны точное поведение аппаратуры или историческая интерпретация, сверяйтесь с документацией конкретной подсистемы и авторитетными историческими источниками.'}
        </p>
      </section>

      {/* SECTION 14: THE DESKTOP APP */}
      <section id="desktop" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§14</span>
            {lang === 'en' ? 'The Desktop App' : 'Настольное приложение'}
          </h2>
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'Prefer a native app? The same emulator is also packaged as an offline desktop application — for Windows (installer and MSI) and Linux (deb, rpm and AppImage). Two variants are available:'
            : 'Предпочитаете нативное приложение? Тот же эмулятор выпускается и как автономная офлайн-программа — для Windows (установщик и MSI) и Linux (deb, rpm и AppImage). Доступно два варианта:'}
        </p>

        <div className="overflow-x-auto rounded-lg border border-[#4a453a] bg-[#12100d]">
          <table className="w-full text-left text-xs text-[#d4c4a0] border-collapse">
            <thead>
              <tr className="border-b border-[#3a3528] bg-[#1c1914] text-[#f0e6c8] font-mono">
                <th className="py-2.5 px-3">VARIANT</th>
                <th className="py-2.5 px-3">SHIPS WITH</th>
                <th className="py-2.5 px-3">NOTES</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2a261f]">
              <tr className="hover:bg-[#191611]">
                <td className="py-2.5 px-3 font-mono font-bold text-[#e8d080]">Minimal</td>
                <td className="py-2.5 px-3 text-[#f0e6c8]">
                  {lang === 'en'
                    ? 'rk0 (Unix V5), rk1 (RT-11), bootcode + the demo paper tapes (BASIC-11, ODT-11, ED-11, Lunar Lander)'
                    : 'rk0 (Unix V5), rk1 (RT-11), bootcode + демонстрационные перфоленты (BASIC-11, ODT-11, ED-11, Lunar Lander)'}
                </td>
                <td className="py-2.5 px-3 text-[#bfae90]">
                  {lang === 'en'
                    ? '≈34 MB on Windows. Boots Unix V5, RT-11 and the paper tapes out of the box; every other image is added by drag & drop at runtime.'
                    : '≈34 МБ в Windows. Из коробки запускаются Unix V5, RT-11 и перфоленты; остальные образы добавляются перетаскиванием.'}
                </td>
              </tr>
              <tr className="hover:bg-[#191611]">
                <td className="py-2.5 px-3 font-mono font-bold text-[#e8d080]">Full</td>
                <td className="py-2.5 px-3 text-[#f0e6c8]">
                  {lang === 'en'
                    ? 'Every image — RK/RL/RP/RA disks, TM tapes, paper tapes'
                    : 'Все образы — диски RK/RL/RP/RA, ленты TM, перфоленты'}
                </td>
                <td className="py-2.5 px-3 text-[#bfae90]">
                  {lang === 'en'
                    ? '≈120 MB on Windows, but every guest system in this manual boots completely offline — nothing to download, no setup.'
                    : '≈120 МБ в Windows, но все гостевые системы из этого руководства запускаются в оффлайне — ничего не нужно скачивать или настраивать.'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Floating Back to Top Button */}
      <div className="pt-6 flex items-center justify-between border-t border-[#3a3528]">
        <button
          onClick={onBackToHome}
          className="inline-flex items-center gap-1.5 text-xs text-[#c8a860] hover:text-[#e8d080] font-mono"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>{lang === 'en' ? 'Back to yaPDP Overview' : 'Вернуться к обзору yaPDP'}</span>
        </button>

        <button
          onClick={scrollToTop}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#524939] bg-[#1a1713] hover:bg-[#252119] text-[#e0d8c8] hover:text-[#fff6e0] text-xs font-mono transition-all"
        >
          <ChevronUp className="w-3.5 h-3.5 text-[#c8a860]" />
          <span>{lang === 'en' ? 'Top of Page' : 'Наверх'}</span>
        </button>
      </div>
    </div>
  );
}
