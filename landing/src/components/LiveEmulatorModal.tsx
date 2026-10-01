import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ExternalLink, Terminal } from 'lucide-react';

interface LiveEmulatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  lang: 'en' | 'ru';
  // Optional QuickBoot scenario key (src/osboot.js). When present the embedded
  // emulator is opened as pdp11.html?boot=<key>, which boots that guest OS
  // with the whole machine profile it needs; when absent the visitor gets the
  // machine as it was left, which is what the plain "launch online" wants.
  bootKey?: string | null;
}

export function LiveEmulatorModal({ isOpen, onClose, lang, bootKey }: LiveEmulatorModalProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !mounted) return null;

  // Deep link read by the emulator itself (QuickBoot.deviceFromSearch): the
  // landing never touches the machine, it only names the scenario to boot.
  const emulatorUrl = bootKey
    ? `pdp11.html?boot=${encodeURIComponent(bootKey)}`
    : 'pdp11.html';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/92 p-2 sm:p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-6xl h-[94vh] flex flex-col rounded-lg border border-[#c8a860] bg-[#1a1714] shadow-[0_20px_60px_rgba(0,0,0,0.95)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Top Bar */}
        <div className="flex items-center justify-between px-3 sm:px-4 py-2 bg-[#252019] border-b border-[#4a453a] flex-shrink-0">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-[#e8d080]" />
            <span className="font-mono text-xs sm:text-sm font-bold text-[#f0e6c8]">
              yaPDP Online PDP‑11/70
            </span>
            <span className="hidden sm:inline text-xs text-[#a09278]">
              (amesk.github.io/yaPDP/pdp11.html)
            </span>
          </div>

          <div className="flex items-center gap-2">
            <a
              href={emulatorUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded border border-[#5a4a30] bg-[#1a1714] hover:bg-[#2e2820] text-[#c8a860] hover:text-[#f0e6c8] transition-colors"
              title={lang === 'en' ? 'Open in dedicated browser window' : 'Открыть в отдельном окне браузера'}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">
                {lang === 'en' ? 'Open standalone' : 'Открыть отдельно'}
              </span>
            </a>

            <button
              onClick={onClose}
              type="button"
              aria-label="Close emulator"
              className="w-8 h-8 min-w-[32px] min-h-[32px] flex items-center justify-center rounded border border-[#5a4a30] bg-[#221e18] hover:bg-[#332c22] text-[#f0e6c8] transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Live Emulator iFrame */}
        <div className="relative flex-1 bg-black w-full h-full">
          <iframe
            key={emulatorUrl}
            src={emulatorUrl}
            title="yaPDP Live Emulator"
            className="w-full h-full border-0"
            allow="fullscreen"
          />
        </div>
      </div>
    </div>,
    document.body
  );
}
