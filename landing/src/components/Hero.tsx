import { Terminal, BookOpen, Download, Play } from 'lucide-react';

interface HeroProps {
  lang: 'en' | 'ru';
  onLaunchOnline: () => void;
  onOpenManual?: () => void;
}

export function Hero({ lang, onLaunchOnline, onOpenManual }: HeroProps) {
  return (
    <section className="text-center pt-2 pb-6 w-full max-w-full overflow-hidden">
      <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight text-[#f0e6c8] mb-3 break-words">
        yaPDP — Yet Another PDP‑11/70 Emulator
      </h1>

      <p className="text-[#c8b890] italic text-sm sm:text-base max-w-2xl mx-auto mb-2 leading-relaxed px-1">
        {lang === 'en'
          ? 'Step into the machine room of 1970s computing — a fully immersive DEC experience, with zero installation and zero configuration.'
          : 'Окунитесь в машинный зал вычислительной техники 1970-х — подлинный опыт работы с машиной DEC, без установки и настройки.'}
      </p>

      <p className="text-[#c8a860] font-bold text-xs sm:text-sm tracking-wide mb-6 px-1">
        {lang === 'en'
          ? 'No plugins. No downloads. No setup. Just open the page and you\'re standing in front of a PDP‑11.'
          : 'Никаких плагинов. Без скачивания и сложной настройки. Просто откройте страницу — и вы стоите перед пультом PDP‑11.'}
      </p>

      {/* Front Panel Image - authentic presentation matching original yaPDP */}
      <div className="my-5">
        <div
          onClick={onLaunchOnline}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onLaunchOnline();
            }
          }}
          className="group relative inline-block max-w-full cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#c8a860] rounded"
          title={lang === 'en' ? 'Click to launch the emulator' : 'Нажмите для запуска эмулятора'}
        >
          <img
            src="assets/pdp11-animated-panel.gif"
            alt="PDP‑11/70 Front Panel"
            className="w-full max-w-[800px] h-auto rounded border border-[#4a453a] group-hover:border-[#c8a860] transition-colors shadow-lg block mx-auto"
          />
        </div>
      </div>

      {/* Primary Action Row - focused 3-button DEC console layout */}
      <div className="flex flex-wrap items-center justify-center gap-2.5 sm:gap-3 mt-5 mb-2 w-full max-w-full">
        {/* Primary CTA: Launch Emulator Online */}
        <button
          onClick={onLaunchOnline}
          type="button"
          className="inline-flex items-center justify-center gap-2 px-5 sm:px-6 py-2.5 sm:py-3 text-xs sm:text-sm font-bold uppercase tracking-wider rounded border-2 border-[#ffd27f] bg-gradient-to-b from-[#6e5832] via-[#4f4124] to-[#342b18] hover:from-[#856b3e] hover:to-[#433720] text-[#fff6e0] shadow-[0_0_18px_rgba(200,168,96,0.4),inset_0_1px_0_rgba(255,230,140,0.3)] hover:shadow-[0_0_24px_rgba(200,168,96,0.6)] transition-all duration-200 cursor-pointer text-center active:scale-98"
        >
          <Terminal className="w-4 h-4 text-[#ffd27f] shrink-0 animate-pulse" />
          <span>{lang === 'en' ? 'LAUNCH ONLINE!' : 'ЗАПУСТИТЬ ОНЛАЙН!'}</span>
        </button>

        {/* Secondary: User Manual */}
        {onOpenManual ? (
          <button
            onClick={onOpenManual}
            type="button"
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 sm:py-3 text-xs font-bold uppercase tracking-wider rounded border border-[#c8a860] bg-gradient-to-b from-[#4a3e2a] to-[#2c261c] hover:from-[#5c4d34] hover:to-[#383124] text-[#f0e6c8] hover:text-[#fff6e0] shadow-[inset_0_1px_0_rgba(255,200,80,0.15),0_2px_4px_rgba(0,0,0,0.5)] transition-all cursor-pointer text-center"
          >
            <BookOpen className="w-4 h-4 text-[#e8d080] shrink-0" />
            <span>{lang === 'en' ? 'MANUAL' : 'РУКОВОДСТВО'}</span>
          </button>
        ) : (
          <a
            href="manual.html"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 sm:py-3 text-xs font-bold uppercase tracking-wider rounded border border-[#c8a860] bg-gradient-to-b from-[#4a3e2a] to-[#2c261c] hover:from-[#5c4d34] hover:to-[#383124] text-[#f0e6c8] hover:text-[#fff6e0] shadow-[inset_0_1px_0_rgba(255,200,80,0.15),0_2px_4px_rgba(0,0,0,0.5)] transition-all text-center"
          >
            <BookOpen className="w-4 h-4 text-[#e8d080] shrink-0" />
            <span>{lang === 'en' ? 'MANUAL' : 'РУКОВОДСТВО'}</span>
          </a>
        )}

        {/* Secondary: YouTube Demo */}
        <a
          href="https://www.youtube.com/playlist?list=PLbR5Jg6Ojbn0"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 sm:py-3 text-xs font-bold uppercase tracking-wider rounded border border-[#c8a860] bg-gradient-to-b from-[#4a3e2a] to-[#2c261c] hover:from-[#5c4d34] hover:to-[#383124] text-[#f0e6c8] hover:text-[#fff6e0] shadow-[inset_0_1px_0_rgba(255,200,80,0.15),0_2px_4px_rgba(0,0,0,0.5)] transition-all text-center"
        >
          <span className="inline-flex items-center justify-center w-4 h-3 bg-red-600 rounded-xs shrink-0">
            <Play className="w-2.5 h-2.5 text-white fill-current ml-0.5" />
          </span>
          <span>{lang === 'en' ? 'YOUTUBE DEMO' : 'СМОТРЕТЬ ДЕМО'}</span>
        </a>
      </div>

      {/* Elegant contextual link for standalone desktop app */}
      <div className="mt-3.5 text-xs text-[#a09070] font-mono flex items-center justify-center gap-1.5 flex-wrap px-2">
        <span>
          {lang === 'en'
            ? 'Also available as a standalone desktop app.'
            : 'Также доступно как нативное десктопное приложение.'}
        </span>
        <a
          href="#download"
          className="text-[#c8a860] hover:text-[#ffd27f] underline underline-offset-3 font-semibold transition-colors inline-flex items-center gap-1"
        >
          <Download className="w-3 h-3 shrink-0" />
          <span>{lang === 'en' ? 'Download for Desktop' : 'Скачать для Windows'}</span>
        </a>
      </div>
    </section>
  );
}
