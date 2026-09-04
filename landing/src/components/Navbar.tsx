import { Github, Monitor, BookOpen, Download, Terminal, Sliders, HardDrive, Cpu, Home, Send } from 'lucide-react';

interface NavbarProps {
  lang: 'en' | 'ru';
  view: 'overview' | 'manual' | 'emulator';
  onSelectView: (view: 'overview' | 'manual' | 'emulator') => void;
  onToggleLang: () => void;
}

export function Navbar({
  lang,
  view,
  onSelectView,
  onToggleLang
}: NavbarProps) {
  return (
    <header className="sticky top-0 z-40 bg-[#1c1915]/95 backdrop-blur-md border-b border-[#3a3528] px-2.5 sm:px-4 py-2 w-full">
      <div className="w-full flex flex-col md:flex-row md:items-center md:justify-between gap-1.5 sm:gap-2">
        {/* Top row on mobile / Left group on desktop */}
        <div className="flex items-center justify-between md:justify-start gap-1.5 sm:gap-2 w-full md:w-auto shrink-0">
          {/* DEC Logo */}
          <button
            onClick={() => onSelectView('overview')}
            type="button"
            className="flex items-center bg-[#13110d] px-2 py-0.5 rounded border border-[#524939] shadow-inner hover:border-[#c8a860] transition-colors cursor-pointer shrink-0"
            title="yaPDP Home"
          >
            <span className="font-mono text-[11px] tracking-widest text-[#e8d080] font-bold">
              digital
            </span>
            <span className="mx-1 text-[#8a7650] text-[11px]">|</span>
            <span className="font-mono text-[11px] font-bold text-[#c8a860] uppercase">
              PDP-11/70
            </span>
          </button>

          {/* Desktop Primary View Switcher Tabs */}
          <div className="hidden md:inline-flex rounded p-0.5 bg-[#14120e] border border-[#3a3528] text-[11px] font-mono shrink-0">
            <button
              onClick={() => onSelectView('overview')}
              type="button"
              className={`px-2 py-0.5 rounded transition-all cursor-pointer whitespace-nowrap ${
                view === 'overview'
                  ? 'bg-[#3a3528] text-[#f0e6c8] font-bold shadow-xs'
                  : 'text-[#8a7650] hover:text-[#d4c4a0]'
              }`}
            >
              {lang === 'en' ? 'Overview' : 'Обзор'}
            </button>
            <button
              onClick={() => onSelectView('manual')}
              type="button"
              className={`px-2 py-0.5 rounded transition-all cursor-pointer flex items-center gap-1 whitespace-nowrap ${
                view === 'manual'
                  ? 'bg-[#c8a860] text-black font-bold shadow-xs'
                  : 'text-[#8a7650] hover:text-[#d4c4a0]'
              }`}
            >
              <BookOpen className="w-3 h-3 shrink-0" />
              <span>{lang === 'en' ? 'Manual' : 'Мануал'}</span>
            </button>
            <button
              onClick={() => onSelectView('emulator')}
              type="button"
              className={`px-2 py-0.5 rounded transition-all cursor-pointer flex items-center gap-1 whitespace-nowrap ${
                view === 'emulator'
                  ? 'bg-[#c8a860] text-black font-bold shadow-xs'
                  : 'text-[#8a7650] hover:text-[#d4c4a0]'
              }`}
            >
              <Terminal className="w-3 h-3 shrink-0" />
              <span>{lang === 'en' ? 'Emulator' : 'Эмулятор'}</span>
            </button>
          </div>

          {/* Mobile Right Quick Actions (Language & GitHub) */}
          <div className="flex md:hidden items-center gap-1 shrink-0">
            {/* Language Switcher */}
            <button
              onClick={onToggleLang}
              type="button"
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] rounded border border-[#524939] bg-[#221e18] hover:bg-[#2c271f] text-[#d4c4a0] hover:text-[#f0e6c8] transition-colors font-mono"
              title={lang === 'en' ? 'Переключить на русский язык' : 'Switch to English'}
            >
              <span className={lang === 'en' ? 'text-[#e8d080] font-bold' : 'opacity-60'}>EN</span>
              <span className="text-[#524939]">/</span>
              <span className={lang === 'ru' ? 'text-[#e8d080] font-bold' : 'opacity-60'}>RU</span>
            </button>

            {/* Telegram Link */}
            <a
              href="https://t.me/yaPDP_news_ru"
              target="_blank"
              rel="noopener noreferrer"
              className="p-1 text-[#c8b890] hover:text-[#24A1DE] transition-colors"
              title="Telegram Channel (RU)"
            >
              <Send className="w-3.5 h-3.5 -rotate-12" />
            </a>

            {/* GitHub Link */}
            <a
              href="https://github.com/amesk/yaPDP"
              target="_blank"
              rel="noopener noreferrer"
              className="p-1 text-[#c8b890] hover:text-[#f0e6c8] transition-colors"
              title="GitHub Repository"
            >
              <Github className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>

        {/* Mobile Row 2: Full-width segmented view switcher */}
        <div className="md:hidden grid grid-cols-3 rounded p-0.5 bg-[#14120e] border border-[#3a3528] text-[11px] font-mono w-full">
          <button
            onClick={() => onSelectView('overview')}
            type="button"
            className={`py-1 text-center rounded transition-all cursor-pointer whitespace-nowrap ${
              view === 'overview'
                ? 'bg-[#3a3528] text-[#f0e6c8] font-bold shadow-xs'
                : 'text-[#8a7650] hover:text-[#d4c4a0]'
            }`}
          >
            {lang === 'en' ? 'Overview' : 'Обзор'}
          </button>
          <button
            onClick={() => onSelectView('manual')}
            type="button"
            className={`py-1 text-center rounded transition-all cursor-pointer flex items-center justify-center gap-1 whitespace-nowrap ${
              view === 'manual'
                ? 'bg-[#c8a860] text-black font-bold shadow-xs'
                : 'text-[#8a7650] hover:text-[#d4c4a0]'
            }`}
          >
            <BookOpen className="w-3 h-3 shrink-0" />
            <span className="truncate">{lang === 'en' ? 'Manual' : 'Мануал'}</span>
          </button>
          <button
            onClick={() => onSelectView('emulator')}
            type="button"
            className={`py-1 text-center rounded transition-all cursor-pointer flex items-center justify-center gap-1 whitespace-nowrap ${
              view === 'emulator'
                ? 'bg-[#c8a860] text-black font-bold shadow-xs'
                : 'text-[#8a7650] hover:text-[#d4c4a0]'
            }`}
          >
            <Terminal className="w-3 h-3 shrink-0" />
            <span className="truncate">{lang === 'en' ? 'Emulator' : 'Эмулятор'}</span>
          </button>
        </div>

        {/* Center: Navigation shortcuts depending on active view (desktop only) */}
        <nav className="hidden lg:flex items-center gap-2 xl:gap-3 text-[11px] font-medium text-[#c8b890] shrink-0 whitespace-nowrap">
          {view === 'overview' ? (
            <>
              <a href="#screenshots" className="hover:text-[#f0e6c8] transition-colors py-0.5 whitespace-nowrap">
                {lang === 'en' ? 'Screenshots' : 'Скриншоты'}
              </a>
              <a href="#features" className="hover:text-[#f0e6c8] transition-colors py-0.5 whitespace-nowrap">
                {lang === 'en' ? 'Features' : 'Возможности'}
              </a>
              <a href="#story" className="hover:text-[#f0e6c8] transition-colors py-0.5 whitespace-nowrap">
                {lang === 'en' ? 'Story' : 'История'}
              </a>
              <a href="#quick-boot" className="hover:text-[#f0e6c8] transition-colors py-0.5 whitespace-nowrap">
                {lang === 'en' ? 'Quick Boot' : 'Запуск'}
              </a>
              <a href="#download" className="hover:text-[#f0e6c8] transition-colors py-0.5 whitespace-nowrap">
                {lang === 'en' ? 'Download' : 'Скачать'}
              </a>
            </>
          ) : view === 'manual' ? (
            <>
              <a href="#quick-start" className="hover:text-[#f0e6c8] transition-colors py-0.5 whitespace-nowrap">
                {lang === 'en' ? 'Quick Start' : 'Старт'}
              </a>
              <a href="#front-panel" className="hover:text-[#f0e6c8] transition-colors py-0.5 whitespace-nowrap">
                {lang === 'en' ? 'Panel' : 'Пульт'}
              </a>
              <a href="#console" className="hover:text-[#f0e6c8] transition-colors py-0.5 whitespace-nowrap">
                {lang === 'en' ? 'Console' : 'Консоль'}
              </a>
              <a href="#printer" className="hover:text-[#f0e6c8] transition-colors py-0.5 whitespace-nowrap">
                {lang === 'en' ? 'Printer' : 'Принтер'}
              </a>
              <a href="#storage" className="hover:text-[#f0e6c8] transition-colors py-0.5 whitespace-nowrap">
                {lang === 'en' ? 'Storage' : 'Диски'}
              </a>
              <a href="#config" className="hover:text-[#f0e6c8] transition-colors py-0.5 whitespace-nowrap">
                {lang === 'en' ? 'Config' : 'Настройки'}
              </a>
            </>
          ) : (
            // Emulator view: the machine fills the page; the window's own
            // control bar (Back / Manual / Open standalone / Reset) covers
            // navigation, so no duplicated centre shortcuts here.
            <></>
          )}
        </nav>

        {/* Desktop Right: Actions */}
        <div className="hidden md:flex items-center gap-1.5 shrink-0">
          {/* Language Switcher */}
          <button
            onClick={onToggleLang}
            type="button"
            className="flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] rounded border border-[#524939] bg-[#221e18] hover:bg-[#2c271f] text-[#d4c4a0] hover:text-[#f0e6c8] transition-colors font-mono"
            title={lang === 'en' ? 'Переключить на русский язык' : 'Switch to English'}
          >
            <span className={lang === 'en' ? 'text-[#e8d080] font-bold' : 'opacity-60'}>EN</span>
            <span className="text-[#524939]">/</span>
            <span className={lang === 'ru' ? 'text-[#e8d080] font-bold' : 'opacity-60'}>RU</span>
          </button>

          {/* Telegram Link */}
          <a
            href="https://t.me/yaPDP_news_ru"
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 text-[#c8b890] hover:text-[#24A1DE] transition-colors shrink-0"
            title="Telegram News Channel (RU)"
          >
            <Send className="w-3.5 h-3.5 -rotate-12" />
          </a>

          {/* GitHub Link */}
          <a
            href="https://github.com/amesk/yaPDP"
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 text-[#c8b890] hover:text-[#f0e6c8] transition-colors shrink-0"
            title="GitHub Repository"
          >
            <Github className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
    </header>
  );
}
