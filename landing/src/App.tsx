import { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar.tsx';
import { Hero } from './components/Hero.tsx';
import { OSCarousel } from './components/OSCarousel.tsx';
import { FeaturesTable } from './components/FeaturesTable.tsx';
import { WhoIsThisFor } from './components/WhoIsThisFor.tsx';
import { PersonalNote } from './components/PersonalNote.tsx';
import { GetStarted } from './components/GetStarted.tsx';
import { DownloadSection } from './components/DownloadSection.tsx';
import { Acknowledgments } from './components/Acknowledgments.tsx';
import { LiveEmulatorModal } from './components/LiveEmulatorModal.tsx';
import { UserManual } from './components/UserManual.tsx';
import { PDP11Emulator } from './components/PDP11Emulator.tsx';

export default function App() {
  const [lang, setLang] = useState<'en' | 'ru'>('en');
  const [view, setView] = useState<'overview' | 'manual' | 'emulator'>('overview');
  const [isEmulatorOpen, setIsEmulatorOpen] = useState<boolean>(false);

  const toggleLanguage = () => {
    setLang((prev) => (prev === 'en' ? 'ru' : 'en'));
  };

  const handleSelectView = (newView: 'overview' | 'manual' | 'emulator') => {
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
      if (hash.startsWith('#emulator') || hash.startsWith('#pdp11')) {
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
        className={`flex-1 w-full min-w-0 ${
          view === 'emulator' ? 'max-w-[1200px]' : 'max-w-[960px]'
        } mx-auto flex flex-col bg-[#1c1915]/85 border-x border-[#3a3528]/80 shadow-[0_0_60px_rgba(0,0,0,0.85)] transition-all`}
      >
        {/* Top sticky navigation bar inside the slab */}
        <Navbar
          lang={lang}
          view={view}
          onSelectView={handleSelectView}
          onToggleLang={toggleLanguage}
          onOpenEmulator={() => handleSelectView('emulator')}
        />

        {/* Main Content */}
        <main className="flex-1 w-full px-4 sm:px-6 md:px-8 py-5 sm:py-8">
          {view === 'manual' ? (
            <UserManual
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

              <OSCarousel lang={lang} />

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
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <span className="text-center sm:text-left">yaPDP © Alexei Eskenazi (amesk) · DEC PDP‑11/70 Simulator</span>
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
              <a
                href="https://t.me/yaPDP_news_ru"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[#24A1DE] transition-colors"
              >
                Telegram (RU)
              </a>
              <span>·</span>
              <a
                href="manual.html"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[#c8a860] transition-colors"
                title="Standalone manual.html"
              >
                manual.html
              </a>
              <span>·</span>
              <button
                onClick={() => setIsEmulatorOpen(true)}
                className="hover:text-[#c8a860] transition-colors cursor-pointer"
              >
                {lang === 'en' ? 'Online Emulator' : 'Эмулятор'}
              </button>
            </div>
          </div>
        </footer>
      </div>

      {/* Fullscreen Interactive Emulator Modal */}
      <LiveEmulatorModal
        isOpen={isEmulatorOpen}
        onClose={() => setIsEmulatorOpen(false)}
        lang={lang}
      />
    </div>
  );
}
