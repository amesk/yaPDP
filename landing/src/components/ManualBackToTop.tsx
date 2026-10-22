import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';

interface ManualBackToTopProps {
  lang: 'en' | 'ru';
}

export function ManualBackToTop({ lang }: ManualBackToTopProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const updateVisibility = () => setVisible(window.scrollY > 320);

    updateVisibility();
    window.addEventListener('scroll', updateVisibility, { passive: true });
    return () => window.removeEventListener('scroll', updateVisibility);
  }, []);

  const scrollToTop = () => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  };

  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={scrollToTop}
      aria-label={lang === 'en' ? 'Back to top' : 'Наверх'}
      title={lang === 'en' ? 'Back to top' : 'Наверх'}
      className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-lg border border-[#6b5b3d] bg-[#1a1713]/95 px-3 py-2 text-xs font-mono text-[#e0d8c8] shadow-lg backdrop-blur-sm transition-colors hover:bg-[#2a241b] hover:text-[#fff6e0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c8a860] sm:bottom-6 sm:right-6"
    >
      <ArrowUp className="h-4 w-4 text-[#c8a860]" aria-hidden="true" />
      <span>{lang === 'en' ? 'Back to top' : 'Наверх'}</span>
    </button>
  );
}
