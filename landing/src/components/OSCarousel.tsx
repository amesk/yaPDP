import { useState, useRef, type TouchEvent } from 'react';
import { GUEST_OS_SLIDES } from '../data.ts';
import { Lightbox } from './Lightbox.tsx';
import { ZoomIn } from 'lucide-react';

interface OSCarouselProps {
  lang: 'en' | 'ru';
}

export function OSCarousel({ lang }: OSCarouselProps) {
  const [selectedSlideIndex, setSelectedSlideIndex] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const touchStateRef = useRef<{ x: number; y: number; time: number } | null>(null);

  const scroll = (direction: 'left' | 'right') => {
    if (trackRef.current) {
      const scrollAmount = direction === 'left' ? -220 : 220;
      trackRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  const handleNextLightbox = () => {
    if (selectedSlideIndex !== null) {
      setSelectedSlideIndex((selectedSlideIndex + 1) % GUEST_OS_SLIDES.length);
    }
  };

  const handlePrevLightbox = () => {
    if (selectedSlideIndex !== null) {
      setSelectedSlideIndex(
        (selectedSlideIndex - 1 + GUEST_OS_SLIDES.length) % GUEST_OS_SLIDES.length
      );
    }
  };

  // Touch tracking to ensure taps on smartphones are detected reliably
  const handleTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    touchStateRef.current = { x: t.clientX, y: t.clientY, time: Date.now() };
  };

  const handleTouchEnd = (idx: number, e: TouchEvent) => {
    if (!touchStateRef.current) return;
    const t = e.changedTouches[0];
    const dx = Math.abs(t.clientX - touchStateRef.current.x);
    const dy = Math.abs(t.clientY - touchStateRef.current.y);
    const dt = Date.now() - touchStateRef.current.time;

    // Tap detected if user moved less than 12px within 500ms
    if (dx < 12 && dy < 12 && dt < 500) {
      setSelectedSlideIndex(idx);
    }
    touchStateRef.current = null;
  };

  return (
    <section id="screenshots" className="my-6">
      <hr className="border-0 border-t border-[#4a453a] my-6" />

      <div className="flex items-baseline justify-between gap-2 mb-2">
        <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] font-mono">
          {lang === 'en' ? 'Guest Operating Systems' : 'Гостевые операционные системы'}
        </h2>
        <span className="text-xs text-[#a09278] font-mono hidden sm:inline">
          {GUEST_OS_SLIDES.length} OS
        </span>
      </div>

      <p className="text-xs sm:text-sm text-[#d4c4a0] leading-relaxed mb-4">
        {lang === 'en'
          ? 'Screenshots of yaPDP running real guest operating systems — booted inside the emulator through the magic-wand wizard. Tap or click any thumbnail to view it full size.'
          : 'Скриншоты реальных операционных систем в yaPDP — запущенных внутри эмулятора с помощью мастера быстрой загрузки. Нажмите на любую миниатюру для полноэкранного просмотра.'}
      </p>

      {/* Carousel Container */}
      <div className="relative group my-4 w-full max-w-full overflow-hidden sm:overflow-visible">
        {/* Prev Arrow */}
        <button
          type="button"
          aria-label="Previous OS slide"
          onClick={() => scroll('left')}
          className="absolute left-0 sm:-left-2 top-1/2 -translate-y-1/2 z-10 w-8 h-8 sm:w-9 sm:h-9 min-w-[32px] min-h-[32px] flex items-center justify-center rounded border border-[#c8a860] bg-gradient-to-b from-[#5a4a30] to-[#3a3528] active:from-[#7a6848] active:to-[#5a5038] hover:from-[#6a5838] hover:to-[#4a4030] text-[#f0e6c8] shadow-md transition-colors cursor-pointer select-none touch-manipulation"
        >
          ◀
        </button>

        {/* Viewport & Track */}
        <div
          ref={trackRef}
          className="flex gap-3.5 overflow-x-auto scroll-smooth py-2 px-4 sm:px-6 no-scrollbar touch-pan-x"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {GUEST_OS_SLIDES.map((slide, idx) => (
            <button
              key={slide.id}
              type="button"
              aria-label={`Open screenshot of ${slide.title}`}
              onClick={() => setSelectedSlideIndex(idx)}
              onTouchStart={handleTouchStart}
              onTouchEnd={(e) => handleTouchEnd(idx, e)}
              className="flex-shrink-0 w-[200px] text-left cursor-pointer rounded-md border border-[#4a4438] hover:border-[#c8a860] focus:border-[#c8a860] focus:outline-none bg-[#1a1815] hover:bg-[#24201a] overflow-hidden p-2.5 transition-all duration-250 hover:shadow-[0_0_20px_rgba(200,168,96,0.35),0_2px_8px_rgba(0,0,0,0.6)] group/card touch-manipulation"
            >
              <figure className="m-0 p-0 w-full">
                <div className="relative w-full h-[135px] bg-black rounded overflow-hidden">
                  <img
                    src={slide.image}
                    alt={slide.alt}
                    width="200"
                    height="135"
                    draggable={false}
                    className="w-full h-full object-cover block rounded border border-[#2a2722] group-hover/card:brightness-108 transition-all duration-250 pointer-events-none"
                    loading="lazy"
                  />
                  <div className="absolute inset-0 bg-black/20 opacity-0 group-hover/card:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                    <span className="p-1.5 rounded-full bg-[#1c1915]/90 text-[#e8d080] border border-[#c8a860] shadow-md">
                      <ZoomIn className="w-4 h-4" />
                    </span>
                  </div>
                </div>
                <figcaption className="mt-2.5 px-1 text-center">
                  <div className="font-sans text-xs sm:text-[13px] font-bold text-[#9a9488] group-hover/card:text-[#ffd27f] transition-colors duration-250 truncate">
                    {slide.caption}
                  </div>
                  <span className="block text-[11px] font-normal text-[#8a857a] group-hover/card:text-[#c8a860] opacity-75 sm:opacity-0 group-hover/card:opacity-100 transition-all duration-250 mt-1">
                    {lang === 'en' ? 'Click to enlarge' : 'Кликните для увеличения'}
                  </span>
                </figcaption>
              </figure>
            </button>
          ))}
        </div>

        {/* Next Arrow */}
        <button
          type="button"
          aria-label="Next OS slide"
          onClick={() => scroll('right')}
          className="absolute right-0 sm:-right-2 top-1/2 -translate-y-1/2 z-10 w-8 h-8 sm:w-9 sm:h-9 min-w-[32px] min-h-[32px] flex items-center justify-center rounded border border-[#c8a860] bg-gradient-to-b from-[#5a4a30] to-[#3a3528] active:from-[#7a6848] active:to-[#5a5038] hover:from-[#6a5838] hover:to-[#4a4030] text-[#f0e6c8] shadow-md transition-colors cursor-pointer select-none touch-manipulation"
        >
          ▶
        </button>
      </div>

      {/* Lightbox portal for selected image */}
      {selectedSlideIndex !== null && (
        <Lightbox
          slide={GUEST_OS_SLIDES[selectedSlideIndex]}
          currentIndex={selectedSlideIndex}
          totalSlides={GUEST_OS_SLIDES.length}
          onClose={() => setSelectedSlideIndex(null)}
          onNext={handleNextLightbox}
          onPrev={handlePrevLightbox}
        />
      )}
    </section>
  );
}
