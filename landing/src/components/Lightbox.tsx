import { useEffect, useState, type TouchEvent } from 'react';
import { createPortal } from 'react-dom';
import { SlideItem } from '../types.ts';
import { X, ChevronLeft, ChevronRight, ZoomIn } from 'lucide-react';

interface LightboxProps {
  slide: SlideItem | null;
  currentIndex: number;
  totalSlides: number;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
}

export function Lightbox({
  slide,
  currentIndex,
  totalSlides,
  onClose,
  onNext,
  onPrev,
}: LightboxProps) {
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [touchEnd, setTouchEnd] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Lock body scroll and handle keyboard navigation
  useEffect(() => {
    if (!slide) return;

    const originalOverflow = document.body.style.overflow;
    const originalTouchAction = document.body.style.touchAction;
    document.body.style.overflow = 'hidden';
    document.body.style.touchAction = 'none';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowRight' && onNext) {
        onNext();
      } else if (e.key === 'ArrowLeft' && onPrev) {
        onPrev();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      document.body.style.touchAction = originalTouchAction;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [slide, onClose, onNext, onPrev]);

  // Handle touch swipes on mobile
  const handleTouchStart = (e: TouchEvent) => {
    setTouchEnd(null);
    setTouchStart(e.targetTouches[0].clientX);
  };

  const handleTouchMove = (e: TouchEvent) => {
    setTouchEnd(e.targetTouches[0].clientX);
  };

  const handleTouchEnd = () => {
    if (!touchStart || !touchEnd) return;
    const distance = touchStart - touchEnd;
    const isLeftSwipe = distance > 50;
    const isRightSwipe = distance < -50;

    if (isLeftSwipe && onNext) {
      onNext();
    } else if (isRightSwipe && onPrev) {
      onPrev();
    }
  };

  if (!slide || !mounted) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={slide.title}
      className="fixed inset-0 z-[100000] flex flex-col items-center justify-between bg-[#0a0806]/92 p-3 sm:p-6 backdrop-blur-md select-none touch-manipulation"
      onClick={(e) => {
        // Close if tapping the backdrop
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Top Bar with counter & Close Button */}
      <div className="w-full max-w-5xl flex items-center justify-between z-10 pt-1 pb-2">
        <div className="flex items-center gap-2 bg-[#1e1a14]/90 px-3 py-1 rounded-full border border-[#4a453a] text-xs font-mono text-[#c8a860]">
          <span>{currentIndex + 1}</span>
          <span className="text-[#6a5e48]">/</span>
          <span>{totalSlides}</span>
          <span className="hidden sm:inline text-[#a09278] ml-1">· Swipe to navigate</span>
        </div>

        <button
          type="button"
          aria-label="Close lightbox"
          onClick={onClose}
          className="w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full border border-[#c8a860] bg-gradient-to-b from-[#5a4a30] to-[#3a3528] active:from-[#7a6848] active:to-[#5a5038] hover:from-[#6a5838] hover:to-[#4a4030] text-[#f0e6c8] shadow-lg transition-colors cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Main Content Area (Image & Nav Arrows) */}
      <div
        className="relative flex-1 w-full max-w-5xl flex items-center justify-center my-auto px-2"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {/* Previous Button (Desktop) */}
        {onPrev && (
          <button
            type="button"
            aria-label="Previous image"
            onClick={(e) => {
              e.stopPropagation();
              onPrev();
            }}
            className="hidden sm:flex absolute left-2 top-1/2 -translate-y-1/2 z-20 w-11 h-11 min-w-[44px] min-h-[44px] items-center justify-center rounded-full border border-[#c8a860] bg-[#221e18]/90 hover:bg-[#332c22] text-[#f0e6c8] shadow-xl transition-all cursor-pointer hover:scale-105"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}

        {/* Screenshot Image */}
        <div
          className="relative max-w-full max-h-[64vh] sm:max-h-[76vh] flex items-center justify-center"
          onClick={(e) => e.stopPropagation()}
        >
          <img
            src={slide.image}
            alt={slide.alt}
            draggable={false}
            className="max-w-[94vw] max-h-[62vh] sm:max-h-[74vh] w-auto h-auto object-contain rounded border-2 border-[#c8a860] shadow-[0_12px_48px_rgba(0,0,0,0.85)] bg-black"
          />
        </div>

        {/* Next Button (Desktop) */}
        {onNext && (
          <button
            type="button"
            aria-label="Next image"
            onClick={(e) => {
              e.stopPropagation();
              onNext();
            }}
            className="hidden sm:flex absolute right-2 top-1/2 -translate-y-1/2 z-20 w-11 h-11 min-w-[44px] min-h-[44px] items-center justify-center rounded-full border border-[#c8a860] bg-[#221e18]/90 hover:bg-[#332c22] text-[#f0e6c8] shadow-xl transition-all cursor-pointer hover:scale-105"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        )}
      </div>

      {/* Caption & Mobile Nav Bar */}
      <div
        className="w-full max-w-xl text-center px-3 pt-2 pb-3 bg-[#191612]/90 rounded-t-lg border-t border-[#4a453a] sm:border-0 sm:bg-transparent"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[#f0e6c8] font-bold text-sm sm:text-base font-mono">
          {slide.caption}
        </p>
        {slide.description && (
          <p className="text-[#c8b890] italic text-xs sm:text-sm mt-1 leading-relaxed line-clamp-2 sm:line-clamp-none">
            {slide.description}
          </p>
        )}

        {/* Mobile Navigation Controls (Touch friendly >=44px) */}
        <div className="flex sm:hidden items-center justify-center gap-6 mt-2 pt-1">
          <button
            type="button"
            aria-label="Previous OS"
            onClick={onPrev}
            className="w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full border border-[#c8a860] bg-[#221e18] active:bg-[#3a3224] text-[#f0e6c8] shadow cursor-pointer"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          <span className="text-xs font-mono text-[#a09278]">
            {currentIndex + 1} / {totalSlides}
          </span>

          <button
            type="button"
            aria-label="Next OS"
            onClick={onNext}
            className="w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full border border-[#c8a860] bg-[#221e18] active:bg-[#3a3224] text-[#f0e6c8] shadow cursor-pointer"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
