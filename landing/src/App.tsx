import { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar.tsx';
import { Hero } from './components/Hero.tsx';
import { OSCarousel } from './components/OSCarousel.tsx';
import { InstantRun } from './components/InstantRun.tsx';
import { GamesCarousel } from './components/GamesCarousel.tsx';
import { FeaturesTable } from './components/FeaturesTable.tsx';
import { WhoIsThisFor } from './components/WhoIsThisFor.tsx';
import { PersonalNote } from './components/PersonalNote.tsx';
import { GetStarted } from './components/GetStarted.tsx';
import { DownloadSection } from './components/DownloadSection.tsx';
import { Acknowledgments } from './components/Acknowledgments.tsx';
import { LiveEmulatorModal } from './components/LiveEmulatorModal.tsx';
import { UserManual } from './components/UserManual.tsx';
import { PDP11Emulator } from './components/PDP11Emulator.tsx';
import { Devlog } from './components/Devlog.tsx';

export default function App() {
  const [lang, setLang] = useState<'en' | 'ru'>('en');
  const [view, setView] = useState<'overview' | 'manual' | 'emulator' | 'devlog'>('overview');
  const [isEmulatorOpen, setIsEmulatorOpen] = useState<boolean>(false);
  // Guest OS the emulator modal must boot when it opens: a QuickBoot scenario
  // key (src/osboot.js). null = show the machine as it is, which is what every
  // plain "launch online" entry point expects.
  const [bootDevice, setBootDevice] = useState<string | null>(null);
  // Saved machine state the emulator modal must apply when it opens: a
  // state URL (states/<name>.state.zst). The mirror of bootDevice for the
  // teleport path — a state REPLACES a boot, so the two are never both set.
  const [stateUrl, setStateUrl] = useState<string | null>(null);

  // Run on a guest-OS tile: open the emulator and let it boot that OS.
  const handleRunOS = (device: string) => {
    setStateUrl(null);          // a boot and a state are alternatives
    setBootDevice(device);
    setIsEmulatorOpen(true);
  };

  // Teleport on an Instant-Run tile: open the emulator and let it apply the
  // saved state — the guest is already running, so nothing boots.
  const handleTeleport = (url: string) => {
    setBootDevice(null);
    setStateUrl(url);
    setIsEmulatorOpen(true);
  };

  const toggleLanguage = () => {
    setLang((prev) => (prev === 'en' ? 'ru' : 'en'));
  };

  const handleSelectView = (newView: 'overview' | 'manual' | 'emulator' | 'devlog') => {
    setView(newView);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Sync hash routing: if user visits #manual, #emulator, etc.
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.toLowerCase();
      const manualSections = [
        '#manual',
        '#quick-start',
        '#magic-wand',
        '#classic-way',
        '#front-panel',
        '#switch-sequences',
        '#console',
        '#teletype',
        '#vt52-console',
        '#vt100-console',
        '#user-terminals',
        '#printer',
        '#vt11',
        '#storage',
        '#config',
        '#guest-oses',
        '#controls',
        '#floating-controls',
        '#activity-lamps',
        '#troubleshooting',
        '#desktop'
      ];
      if (hash.startsWith('#devlog')) {
        setView('devlog');
      } else if (hash.startsWith('#emulator') || hash.startsWith('#pdp11')) {
        setView('emulator');
      } else if (manualSections.some((sec) => hash.startsWith(sec))) {
        setView('manual');
      } else if (
        hash.startsWith('#screenshots') ||
        hash.startsWith('#features') ||
        hash.startsWith('#story') ||
        hash.startsWith('#quick-boot') ||
        hash.startsWith('#download')
      ) {
        setView('overview');
      }
    };

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  return (
    <div className="min-h-screen w-full flex flex-col text-[#e0d8c8] selection:bg-[#c8a860] selection:text-black">
      {/* Centered Landing Page Slab - faithfully mirroring .landing-page from yaPDP over the machine-room photo backdrop */}
      <div
        className={`flex-1 w-full min-w-0 ${view === 'emulator' ? 'max-w-[1200px]' : 'max-w-[800px]'
          } mx-auto flex flex-col bg-[#1c1915]/85 border-x border-[#3a3528]/80 shadow-[0_0_60px_rgba(0,0,0,0.85)] transition-all`}
      >
        {/* Top sticky navigation bar inside the slab */}
        <Navbar
          lang={lang}
          view={view}
          onSelectView={handleSelectView}
          onToggleLang={toggleLanguage}
        />

        {/* Main Content */}
        <main className="flex-1 w-full px-4 sm:px-6 md:px-8 py-5 sm:py-8">
          {view === 'manual' ? (
            <UserManual
              lang={lang}
              onBackToHome={() => handleSelectView('overview')}
              onOpenEmulator={() => handleSelectView('emulator')}
            />
          ) : view === 'devlog' ? (
            <Devlog
              lang={lang}
              onBackToHome={() => handleSelectView('overview')}
              onOpenEmulator={() => handleSelectView('emulator')}
            />
          ) : view === 'emulator' ? (
            <PDP11Emulator
              lang={lang}
              onBackToHome={() => handleSelectView('overview')}
              onOpenManual={() => handleSelectView('manual')}
            />
          ) : (
            <>
              <Hero
                lang={lang}
                onLaunchOnline={() => handleSelectView('emulator')}
                onOpenManual={() => handleSelectView('manual')}
              />

              <InstantRun lang={lang} onTeleport={handleTeleport} />

              {/* Games sit beside the Instant-Run (Teleport) carousel: same
                  saved-state mechanism, a "Play!" button — the game is already
                  running, so there is nothing to boot. */}
              <GamesCarousel lang={lang} onPlay={handleTeleport} />

              <OSCarousel lang={lang} onRun={handleRunOS} />

              <FeaturesTable lang={lang} />

              <WhoIsThisFor lang={lang} />

              <PersonalNote lang={lang} />

              <GetStarted
                lang={lang}
                onLaunchOnline={() => handleSelectView('emulator')}
              />

              <DownloadSection lang={lang} />

              <Acknowledgments lang={lang} />
            </>
          )}
        </main>

        {/* Footer copyright inside the slab */}
        <footer className="w-full bg-[#12100d]/90 border-t border-[#3a3528] py-4 px-4 sm:px-6 text-center text-xs text-[#8a7650] font-mono">
          <div className="flex flex-col items-center gap-2">
            <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1.5">
              <button
                onClick={() => handleSelectView('overview')}
                className="hover:text-[#c8a860] transition-colors cursor-pointer"
              >
                {lang === 'en' ? 'Overview' : 'Обзор'}
              </button>
              <span>·</span>
              <button
                onClick={() => handleSelectView('manual')}
                className="hover:text-[#c8a860] transition-colors cursor-pointer"
              >
                {lang === 'en' ? 'User Manual' : 'Руководство'}
              </button>
              <span>·</span>
              <a
                href="https://github.com/amesk/yaPDP"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[#c8a860] transition-colors"
              >
                GitHub
              </a>
              <span>·</span>
              {/* The project's channel is Russian, the rest of the site is not:
                  it is shown where it is useful and omitted where it is a dead
                  end. An English reader gets a place to ask questions instead,
                  which the header links to as well. */}
              {lang === 'en' ? (
                <a
                  href="https://github.com/amesk/yaPDP/discussions"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-[#c8a860] transition-colors"
                >
                  Discussions
                </a>
              ) : (
                <a
                  href="https://t.me/yaPDP_news_ru"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-[#24A1DE] transition-colors"
                >
                  Telegram
                </a>
              )}
              <span>·</span>
              <a
                href="devlog/index.html"
                className="hover:text-[#c8a860] transition-colors"
              >
                {lang === 'en' ? 'Devlog' : 'Девлог'}
              </a>
              <span>·</span>
              <button
                onClick={() => setIsEmulatorOpen(true)}
                className="hover:text-[#c8a860] transition-colors cursor-pointer"
              >
                {lang === 'en' ? 'Online Emulator' : 'Эмулятор'}
              </button>
            </div>
            <span>yaPDP © Alexei Eskenazi (amesk) · DEC PDP‑11/70 Simulator</span>
          </div>
        </footer>
      </div>

      {/* Fullscreen Interactive Emulator Modal */}
      <LiveEmulatorModal
        isOpen={isEmulatorOpen}
        onClose={() => {
          setIsEmulatorOpen(false);
          // Drop the pending guest OS: reopening the emulator from the footer
          // must show the machine as it was left, not boot a stale OS again.
          setBootDevice(null);
        }}
        lang={lang}
        bootKey={bootDevice}
        stateUrl={stateUrl}
      />
    </div>
  );
}
