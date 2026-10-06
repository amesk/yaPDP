import { useState, useRef, type TouchEvent } from 'react';
import { GAME_SLIDES } from '../data.ts';
import { Lightbox } from './Lightbox.tsx';
import { ZoomIn, Play } from 'lucide-react';

interface GamesCarouselProps {
    lang: 'en' | 'ru';
    // Play on a tile: receives the tile's state URL. The parent opens the
    // emulator with ?state=<url>, which fetches the saved machine state and
    // applies it — the game is ALREADY RUNNING, so nothing boots. Same contract
    // as InstantRun's onTeleport; the label differs because a game is played,
    // not teleported into.
    onPlay?: (stateUrl: string) => void;
}

// The game tiles, in the order they appear. A tile without a saved state is
// simply not offered: better a shorter gallery than a button that cannot keep
// its promise.
const GAME_TILES = GAME_SLIDES.filter((s) => !!s.stateUrl);

export function GamesCarousel({ lang, onPlay }: GamesCarouselProps) {
    const [selectedSlideIndex, setSelectedSlideIndex] = useState<number | null>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const touchStateRef = useRef<{ x: number; y: number; time: number } | null>(null);

    if (!GAME_TILES.length) return null;

    // The reader's language decides which description the lightbox shows.
    // Russian falls back to English for a game with no translation yet.
    const tiles = GAME_TILES.map((s) => ({
        ...s,
        description: lang === 'ru' ? (s.descriptionRu || s.description) : s.description,
    }));

    const scroll = (direction: 'left' | 'right') => {
        if (trackRef.current) {
            const scrollAmount = direction === 'left' ? -220 : 220;
            trackRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
        }
    };

    const handleNextLightbox = () => {
        if (selectedSlideIndex !== null) {
            setSelectedSlideIndex((selectedSlideIndex + 1) % GAME_TILES.length);
        }
    };

    const handlePrevLightbox = () => {
        if (selectedSlideIndex !== null) {
            setSelectedSlideIndex(
                (selectedSlideIndex - 1 + GAME_TILES.length) % GAME_TILES.length
            );
        }
    };

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
        if (dx < 12 && dy < 12 && dt < 500) setSelectedSlideIndex(idx);
        touchStateRef.current = null;
    };

    return (
        <section id="games" className="my-6">
            <hr className="border-0 border-t border-[#4a453a] my-6" />

            <div className="flex items-baseline justify-between gap-2 mb-2">
                <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] font-mono">
                    {lang === 'en' ? 'Games' : 'Игры'}
                </h2>
                <span className="text-xs text-[#a09278] font-mono hidden sm:inline">
                    {GAME_TILES.length} {lang === 'en' ? 'games' : 'игр'}
                </span>
            </div>

            <p className="text-xs sm:text-sm text-[#d4c4a0] leading-relaxed mb-4">
                {lang === 'en'
                    ? 'Games that ran on the PDP-11, each parked in a saved machine state so you can play immediately — no boot, no waiting. Press Play and the emulator opens with the game already running.'
                    : 'Игры, которые шли на PDP-11, — каждая сохранена в виде состояния машины, поэтому играть можно сразу: без загрузки и ожидания. Нажмите «Играть», и эмулятор откроется с уже запущенной игрой.'}
            </p>

            <div className="relative group my-4 w-full max-w-full overflow-hidden sm:overflow-visible">
                <button
                    type="button"
                    aria-label="Previous game slide"
                    onClick={() => scroll('left')}
                    className="absolute left-0 sm:-left-2 top-1/2 -translate-y-1/2 z-10 w-8 h-8 sm:w-9 sm:h-9 min-w-[32px] min-h-[32px] flex items-center justify-center rounded border border-[#c8a860] bg-gradient-to-b from-[#5a4a30] to-[#3a3528] active:from-[#7a6848] active:to-[#5a5038] hover:from-[#6a5838] hover:to-[#4a4030] text-[#f0e6c8] shadow-md transition-colors cursor-pointer select-none touch-manipulation"
                >
                    ◀
                </button>

                <div
                    ref={trackRef}
                    className="flex gap-3.5 overflow-x-auto scroll-smooth py-2 px-4 sm:px-6 no-scrollbar touch-pan-x"
                    style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                >
                    {tiles.map((slide, idx) => (
                        <div
                            key={slide.id}
                            className="flex-shrink-0 w-[200px] rounded-md border border-[#4a4438] hover:border-[#c8a860] focus-within:border-[#c8a860] bg-[#1a1815] hover:bg-[#24201a] overflow-hidden p-2.5 transition-all duration-250 hover:shadow-[0_0_20px_rgba(200,168,96,0.35),0_2px_8px_rgba(0,0,0,0.6)] group/card"
                        >
                            <button
                                type="button"
                                aria-label={`Open screenshot of ${slide.title}`}
                                onClick={() => setSelectedSlideIndex(idx)}
                                onTouchStart={handleTouchStart}
                                onTouchEnd={(e) => handleTouchEnd(idx, e)}
                                className="block w-full text-left cursor-pointer focus:outline-none touch-manipulation"
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
                                        {/* The state's own promise, so the tile does not lie about
                        what the visitor will find there. */}
                                        {slide.stateReady && (
                                            <span className="block text-[10px] font-normal text-[#8a857a] mt-0.5 truncate">
                                                {slide.stateReady}
                                            </span>
                                        )}
                                    </figcaption>
                                </figure>
                            </button>

                            {slide.stateUrl && onPlay && (
                                <button
                                    type="button"
                                    onClick={() => onPlay(slide.stateUrl!)}
                                    aria-label={`Play ${slide.title}, already running`}
                                    title={lang === 'en'
                                        ? `Play ${slide.title} already running`
                                        : `Играть в ${slide.title} — уже запущена`}
                                    className="mt-2 w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded border border-[#7a9a5a] bg-gradient-to-b from-[#3a4a30] to-[#27331f] hover:from-[#4a5c3a] hover:to-[#33422a] active:from-[#5a6e48] active:to-[#3d4d33] text-[#e8f0d8] shadow-md transition-colors cursor-pointer touch-manipulation"
                                >
                                    <Play className="w-3 h-3" />
                                    {lang === 'en' ? 'Play!' : 'Играть!'}
                                </button>
                            )}
                        </div>
                    ))}
                </div>

                <button
                    type="button"
                    aria-label="Next game slide"
                    onClick={() => scroll('right')}
                    className="absolute right-0 sm:-right-2 top-1/2 -translate-y-1/2 z-10 w-8 h-8 sm:w-9 sm:h-9 min-w-[32px] min-h-[32px] flex items-center justify-center rounded border border-[#c8a860] bg-gradient-to-b from-[#5a4a30] to-[#3a3528] active:from-[#7a6848] active:to-[#5a5038] hover:from-[#6a5838] hover:to-[#4a4030] text-[#f0e6c8] shadow-md transition-colors cursor-pointer select-none touch-manipulation"
                >
                    ▶
                </button>
            </div>

            {selectedSlideIndex !== null && (
                <Lightbox
                    slide={tiles[selectedSlideIndex]}
                    currentIndex={selectedSlideIndex}
                    totalSlides={tiles.length}
                    onClose={() => setSelectedSlideIndex(null)}
                    onNext={handleNextLightbox}
                    onPrev={handlePrevLightbox}
                />
            )}
        </section>
    );
}
