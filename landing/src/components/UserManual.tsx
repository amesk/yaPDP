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
    'console': ['teletype', 'asr', 'keyboard', 'paper', 'vt52 console', 'type'],
    'user-terminals': ['tty', 'terminal', 'users'],
    'printer': ['lp11', 'print', 'paper feed'],
    'vt11': ['display', 'vector', 'graphics', 'lander', 'crv'],
    'storage': ['disk', 'tape', 'ptap', 'image', 'dsk', 'mount', 'reader', 'punch', 'drop'],
    'machine-state': ['save', 'load', 'snapshot', 'state', 'restore'],
    'config': ['settings', 'options', 'equipment', 'tabs', 'speed', 'sound'],
    'guest-oses': ['os', 'operating system', 'boot rk', 'boot rp', 'boot rl', 'unix', 'rt-11', 'rsx', 'rsts', 'bsd', 'xxdp', 'basic'],
    'controls': ['button', 'shortcut', 'indicator', 'reboot', 'mute', 'fullscreen', 'magic'],
    'troubleshooting': ['problem', 'fix', 'error', 'help'],
    'desktop': ['tauri', 'install', 'app', 'download'],
  };

  const sectionMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const out: { id: string; titleEn: string; titleRu: string }[] = [];
    for (const sec of MANUAL_SECTIONS) {
      const kw = (SECTION_KEYWORDS[sec.id] || []).join(' ').toLowerCase();
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
          <span className="text-[11px] text-[#8a7650] font-mono">{MANUAL_SECTIONS.length} SECTIONS</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
          {MANUAL_SECTIONS.map((sec) => (
            <button
              key={sec.id}
              onClick={() => scrollToSection(sec.id)}
              className="text-left px-3 py-2 rounded bg-[#1c1914] hover:bg-[#25211a] border border-[#3a3528]/80 hover:border-[#c8a860]/60 transition-all text-xs text-[#d4c4a0] hover:text-[#f0e6c8] flex items-center gap-2 cursor-pointer group"
            >
              <span className="font-mono text-[11px] text-[#c8a860] font-bold group-hover:text-[#e8d080]">
                {sec.number}.
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
                  ? 'A toast asks you not to touch the teletype/keyboard during autoload.'
                  : 'Уведомление во время автоматического ввода команд загрузки.'}
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
                    ? 'At the Boot> prompt, type the boot command and press ENTER:'
                    : 'В приглашении Boot> введите команду загрузки и нажмите ENTER:'}
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
              — the machine's primary typewriter interface. Depending on the CONFIG page, it is either a{' '}
              <strong className="text-[#f0e6c8]">Model 33 ASR teletype</strong> or a{' '}
              <strong className="text-[#f0e6c8]">DECscope VT52</strong>.
            </>
          ) : (
            <>
              Консоль оператора используется PDP-11 как устройство{' '}
              <code className="text-[#e8d080]">TT0:</code> — основная печатная машинка системы. В
              зависимости от настроек на странице CONFIG, консолью является либо{' '}
              <strong className="text-[#f0e6c8]">телетайп Model 33 ASR</strong>, либо{' '}
              <strong className="text-[#f0e6c8]">видеотерминал DECscope VT52</strong>.
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
                  'The Model 33 ASR operator console at the Boot> prompt'
                )
              }
            />
            <p className="mt-1.5 text-center text-xs text-[#8a7650] italic">
              {lang === 'en'
                ? 'The Model 33 ASR operator console at the Boot> prompt.'
                : 'Консоль оператора Model 33 ASR со строкой приглашения Boot>.'}
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
                  ? 'Beside the machine sits the 8-track paper tape reader/punch unit (tracks 1–7 = ASCII, track 8 = parity). Can be enabled via CONFIG.'
                  : 'Рядом с кареткой расположен блок 8-дорожечного перфоратора перфоленты (дорожки 1–7 = ASCII, 8 = четность). Включается на странице CONFIG.'}
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
            ? 'Up to two user VT52 terminals (configured on the CONFIG page) allow multiuser guest operating systems like 2.11 BSD, Ultrix and RSTS/E to run simultaneous interactive sessions side by side. Each is drawn as an authentic slanted DECscope monoblock cabinet with vent grille, recessed screen bezel, and physical keyboard input.'
            : 'До двух пользовательских терминалов VT52 (настраиваются на странице CONFIG) позволяют многопользовательским ОС (2.11 BSD, Ultrix, RSTS/E) запускать параллельные сеансы работы. Терминал отрисован в виде моноблочного корпуса DECscope со скошенной панелью, вентиляционной решеткой и углубленным экраном.'}
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
                ? 'Optionally render terminal as standard text input for fast Ctrl+C / Ctrl+V clipboard pasting.'
                : 'Возможность включения текстового режима для легкого копирования и вставки исходного кода (Ctrl+C / Ctrl+V).'}
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
            ? 'The LP11 is an animated line printer on wide 132-column fanfold green-bar paper (72/80/100/132 selectable). It only prints. Use Print to send jobs to your physical printer via system dialog, or Save .txt to export formatted output.'
            : 'LP11 — это анимированный построчный принтер на широкой 132-колоночной бумаге в зеленую полоску (выбор 72/80/100/132 колонок). Кнопка Print отправляет листинг на реальный принтер через системный диалог, а Save .txt сохраняет файл с метками перевода страницы.'}
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

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="rounded border border-[#3a3528] bg-[#13110d] p-3">
            <HardDrive className="w-4 h-4 text-[#c8a860] mb-1.5" />
            <strong className="text-[#f0e6c8] block mb-1">
              {lang === 'en' ? 'Paper Tape Reader' : 'Считыватель перфоленты'}
            </strong>
            <p className="text-[#c8b890]">
              {lang === 'en'
                ? 'File selector for the #ptr device. Boot with "boot pr" for BASIC-11 or Lunar Lander.'
                : 'Выбор файла для устройства #ptr. Загрузка через "boot pr" для BASIC-11 или Lunar Lander.'}
            </p>
          </div>

          <div className="rounded border border-[#3a3528] bg-[#13110d] p-3">
            <Download className="w-4 h-4 text-[#c8a860] mb-1.5" />
            <strong className="text-[#f0e6c8] block mb-1">
              {lang === 'en' ? 'Drag & Drop Zone' : 'Зона Drag & Drop'}
            </strong>
            <p className="text-[#c8b890]">
              {lang === 'en'
                ? 'Drop any .dsk, .tap, .ptap and .zst compressed disk images directly into the browser.'
                : 'Перетаскивайте образы .dsk, .tap, .ptap и сжатые .zst прямо в окно браузера.'}
            </p>
          </div>

          <div className="rounded border border-[#3a3528] bg-[#13110d] p-3">
            <Sliders className="w-4 h-4 text-[#c8a860] mb-1.5" />
            <strong className="text-[#f0e6c8] block mb-1">
              {lang === 'en' ? 'IndexedDB Persistence' : 'Постоянное сохранение'}
            </strong>
            <p className="text-[#c8b890]">
              {lang === 'en'
                ? 'Disk modifications persist in browser storage across sessions and reloads.'
                : 'Изменения на виртуальных дисках сохраняются в IndexedDB между перезагрузками.'}
            </p>
          </div>
        </div>
      </section>

      {/* SECTION 8: MACHINE STATE */}
      <section id="machine-state" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§8</span>
            {lang === 'en' ? 'Machine State (STATE button)' : 'Состояние машины (кнопка STATE)'}
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
        </ul>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'The STATE button mirrors REBOOT and is available on the Panel, Console (teletype or VT52) and TTY pages. States are stored in the browser IndexedDB and survive reloads and sessions.'
            : 'Кнопка STATE зеркалит REBOOT и доступна на страницах Panel, Console (телетайп или VT52) и TTY. Состояния хранятся в IndexedDB браузера и переживают перезагрузки и сеансы.'}
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
                className={`px-3 py-1.5 text-xs font-bold rounded transition-all cursor-pointer ${
                  activeConfigTab === tab.id
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
      </section>

      {/* SECTION 11: TROUBLESHOOTING */}
      <section id="troubleshooting" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§12</span>
            {lang === 'en' ? 'Troubleshooting' : 'Устранение неполадок'}
          </h2>
        </div>

        <div className="rounded-lg border border-[#4a453a] bg-[#14120e] p-4 space-y-4">
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
      </section>

      {/* SECTION 12: THE DESKTOP APP */}
      <section id="desktop" className="space-y-5 scroll-mt-20">
        <div className="flex items-center justify-between border-b border-[#3a3528] pb-2">
          <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] flex items-center gap-2">
            <span className="font-mono text-[#c8a860] text-lg">§13</span>
            {lang === 'en' ? 'The Desktop App' : 'Настольное приложение'}
          </h2>
        </div>

        <p className="text-sm leading-relaxed text-[#c8b890]">
          {lang === 'en'
            ? 'Prefer a native app? The same emulator is also packaged as an offline desktop application — for Windows (installer, MSI and portable) and Linux (deb, rpm and AppImage). Two variants are available:'
            : 'Предпочитаете нативное приложение? Тот же эмулятор выпускается и как автономная офлайн-программа — для Windows (установщик, MSI и портативная версия) и Linux (deb, rpm и AppImage). Доступно два варианта:'}
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
                <td className="py-2.5 px-3 text-[#f0e6c8]">rk0, rk1, bootcode</td>
                <td className="py-2.5 px-3 text-[#bfae90]">
                  {lang === 'en'
                    ? 'Small download. Boots Unix V5 and RT-11 out of the box; every other image is added by drag & drop at runtime.'
                    : 'Компактный установщик. Запускает Unix V5 и RT-11 из коробки; остальные образы добавляются перетаскиванием.'}
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
                    ? 'Every guest system in this manual boots completely offline — nothing to download, no setup.'
                    : 'Все гостевые системы из этого руководства запускаются в оффлайне — ничего не нужно скачивать или настраивать.'}
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
