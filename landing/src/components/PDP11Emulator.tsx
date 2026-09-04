import { useState } from 'react';
import {
  RefreshCw,
  ExternalLink,
  BookOpen,
  ArrowLeft
} from 'lucide-react';

interface PDP11EmulatorProps {
  lang: 'en' | 'ru';
  onBackToHome: () => void;
  onOpenManual: () => void;
}

export function PDP11Emulator({ lang, onBackToHome, onOpenManual }: PDP11EmulatorProps) {
  const [iframeKey, setIframeKey] = useState(0);

  const reloadVM = () => {
    setIframeKey((prev) => prev + 1);
  };

  return (
    <div className="w-full space-y-3">
      {/* Top Breadcrumb & Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 pb-2.5 border-b border-[#3a3528]/80 text-xs font-mono">
        <div className="flex items-center gap-2">
          <button
            onClick={onBackToHome}
            type="button"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded border border-[#5a4a30] bg-[#1a1815] hover:bg-[#28231c] text-[#c8a860] hover:text-[#f0e6c8] transition-colors cursor-pointer font-bold"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>{lang === 'en' ? 'Back to Overview' : 'На главную'}</span>
          </button>

          <button
            onClick={onOpenManual}
            type="button"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded border border-[#3a3528] bg-[#1a1815] hover:bg-[#28231c] text-[#d4c4a0] hover:text-[#f0e6c8] transition-colors cursor-pointer"
          >
            <BookOpen className="w-3.5 h-3.5 text-[#c8a860]" />
            <span>{lang === 'en' ? 'User Manual' : 'Мануал'}</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <a
            href="pdp11.html"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded border border-[#4a4030] bg-[#221e18] hover:bg-[#2e2820] text-[#c8a860] hover:text-[#f0e6c8] transition-colors"
            title={lang === 'en' ? 'Open pdp11.html in new tab' : 'Открыть pdp11.html в новой вкладке'}
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>{lang === 'en' ? 'Open standalone' : 'Открыть отдельно'}</span>
          </a>

          <button
            onClick={reloadVM}
            type="button"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded border border-[#4a4030] bg-[#221e18] hover:bg-[#2e2820] text-[#c8b890] hover:text-[#f0e6c8] transition-colors cursor-pointer"
            title={lang === 'en' ? 'Reload VM' : 'Сброс ВМ'}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>{lang === 'en' ? 'Reset' : 'Сброс'}</span>
          </button>
        </div>
      </div>

      {/* Main Console Chassis */}
      <section className="relative rounded-lg border border-[#4a4030] bg-black shadow-[0_12px_40px_rgba(0,0,0,0.85)] overflow-hidden">
        {/* Live Emulator Viewport */}
        <div className="relative w-full bg-black min-h-[640px] h-[78vh] max-h-[920px]">
          <iframe
            key={iframeKey}
            src="pdp11.html"
            title="yaPDP Live Emulator Console"
            className="w-full h-full border-0 bg-black"
            allow="fullscreen; clipboard-read; clipboard-write; autoplay"
          />
        </div>
      </section>
    </div>
  );
}
