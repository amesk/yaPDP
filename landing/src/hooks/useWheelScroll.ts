import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  cloneCountFor,
  indexAt,
  overflows,
  realStartFor,
  wheelItems,
  wrapOffset,
} from './wheelMath.js';

// A scroll-smooth animation keeps emitting scroll events; this is how long
// the track must be quiet before the offset is rewound. A little longer than
// the browser's smooth-scroll tail, short enough that the rewind still looks
// instant (the clones under the edge show the same cards).
const SETTLE_MS = 160;

/** One entry of the rendered (augmented) track. */
export interface WheelItem {
  /** Index into the caller's slide array — clones resolve to a real slide. */
  realIndex: number;
  /** True for the edge clones: aria-hidden and out of the tab order. */
  clone: boolean;
}

export interface WheelScroll {
  trackRef: RefObject<HTMLDivElement | null>;
  /** Cards to render, in order: [tail clones][real slides][head clones]. */
  items: WheelItem[];
  /** Move the window one card left or right, looping at either end. */
  scroll: (direction: 'left' | 'right') => void;
  /** True when the track actually loops (the cards overflow the viewport). */
  looping: boolean;
}

/**
 * Endless horizontal scrolling for a native `overflow-x` track.
 *
 * The classic index.html carousel is a circular buffer driven by a virtual
 * index plus edge clones. The landing cannot use that transform approach —
 * it would kill touch panning and the lazy-loaded screenshots — so the same
 * buffer is built on top of the native scroll offset: clones of the edge
 * cards pad the track, and once a scroll settles inside a clone the offset is
 * quietly rewound by one lap. The visitor sees the last card followed by the
 * first, in both directions, which is exactly what the classic gallery does.
 *
 * Every rendered card must carry `data-wheel-card` so the card pitch
 * (width + gap) can be measured.
 */
export function useWheelScroll(count: number): WheelScroll {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [clones, setClones] = useState(0);
  const clonesRef = useRef(0);
  const stepRef = useRef(0);
  const indexRef = useRef(0);
  const settleTimer = useRef<number | null>(null);
  const touchingRef = useRef(false);

  clonesRef.current = clones;

  // Move the window without animation: the inline scroll-behavior overrides
  // the Tailwind `scroll-smooth` class, and is restored after the jump.
  const jump = useCallback((left: number) => {
    const track = trackRef.current;
    if (!track) return;
    const previous = track.style.scrollBehavior;
    track.style.scrollBehavior = 'auto';
    track.scrollLeft = left;
    requestAnimationFrame(() => {
      track.style.scrollBehavior = previous;
    });
  }, []);

  // Measure the card pitch and decide how many edge clones keep the viewport
  // filled. Runs before paint, so the first frame is already on real card 0.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || count < 2) {
      setClones(0);
      return;
    }

    const measure = () => {
      const card = track.querySelector<HTMLElement>('[data-wheel-card]');
      if (!card) return;
      const style = getComputedStyle(track);
      const gap = Number.parseFloat(style.columnGap || '0') || 0;
      const step = card.getBoundingClientRect().width + gap;
      if (!(step > 0)) return;
      const padding =
        (Number.parseFloat(style.paddingLeft) || 0) +
        (Number.parseFloat(style.paddingRight) || 0);
      const viewport = track.clientWidth - padding;

      // Remember the slide under the left edge: a resize rebuilds the clones
      // and must not throw the visitor back to the first card.
      const previousStep = stepRef.current || step;
      indexRef.current = indexAt(track.scrollLeft, clonesRef.current, count, previousStep);
      stepRef.current = step;

      // A gallery narrower than its viewport has nowhere to loop to; cloning
      // it would only add cards the arrows could never reach.
      setClones(overflows(count, viewport, step) ? cloneCountFor(count, viewport, step) : 0);
    };

    measure();
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(track);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [count]);

  // After the clone count settles (first mount, resize), put the remembered
  // slide back under the left edge — instantly, before the frame is painted.
  useLayoutEffect(() => {
    if (count < 2 || !clones) return;
    const step = stepRef.current;
    if (!(step > 0)) return;
    jump(realStartFor(clones, step) + indexRef.current * step);
  }, [clones, count, jump]);

  const scroll = useCallback(
    (direction: 'left' | 'right') => {
      const track = trackRef.current;
      const step = stepRef.current;
      if (!track || count < 2 || !(step > 0)) return;
      track.scrollBy({ left: direction === 'left' ? -step : step, behavior: 'smooth' });
    },
    [count]
  );

  // Rewind the offset once the scroll has settled: if it stopped inside a
  // clone, shift it back by whole laps until a real card is under the edge.
  const settle = useCallback(() => {
    const track = trackRef.current;
    const step = stepRef.current;
    if (!track || count < 2 || !clonesRef.current || !(step > 0)) return;
    if (touchingRef.current) return;

    const left = wrapOffset(track.scrollLeft, clonesRef.current, count, step);
    if (Math.abs(left - track.scrollLeft) >= 1) jump(left);
    indexRef.current = indexAt(left, clonesRef.current, count, step);
  }, [count, jump]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track || count < 2) return;

    const schedule = () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        settleTimer.current = null;
        settle();
      }, SETTLE_MS);
    };
    // A finger owns the position: never rewind under it, only after it lifts.
    const onTouchStart = () => {
      touchingRef.current = true;
      if (settleTimer.current !== null) {
        window.clearTimeout(settleTimer.current);
        settleTimer.current = null;
      }
    };
    const onTouchEnd = () => {
      touchingRef.current = false;
      schedule();
    };

    track.addEventListener('scroll', schedule, { passive: true });
    track.addEventListener('touchstart', onTouchStart, { passive: true });
    track.addEventListener('touchend', onTouchEnd, { passive: true });
    track.addEventListener('touchcancel', onTouchEnd, { passive: true });
    // A track that starts out inside a clone (browser scroll restoration).
    schedule();

    return () => {
      track.removeEventListener('scroll', schedule);
      track.removeEventListener('touchstart', onTouchStart);
      track.removeEventListener('touchend', onTouchEnd);
      track.removeEventListener('touchcancel', onTouchEnd);
      if (settleTimer.current !== null) {
        window.clearTimeout(settleTimer.current);
        settleTimer.current = null;
      }
    };
  }, [count, settle]);

  const items = useMemo<WheelItem[]>(
    () => wheelItems(count, clones) as WheelItem[],
    [count, clones]
  );

  return { trackRef, items, scroll, looping: clones > 0 };
}
