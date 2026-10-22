/**
 * Pure scroll math for the landing carousels.
 *
 * The landing keeps its native `overflow-x` track (so touch panning still
 * works) and loops by rendering clones of the edge cards: the track becomes
 * [tail clones][real cards][head clones]. The clone count is whatever keeps
 * the viewport filled; after every scroll settles the offset is rewound by a
 * whole lap (count * step) once it has crossed into a clone. The cards there
 * are identical to the ones they wrap to, so the rewind is invisible. This is
 * the same circular buffer the classic index.html carousel builds with
 * transforms, without giving up native scrolling.
 *
 * Kept free of React and the DOM so tests/carousel-loop.test.js can drive it
 * without a browser.
 */

/**
 * How many edge clones the viewport needs to stay filled.
 * 0 means "the real cards fit, do not loop".
 *
 * The count is NOT capped at the slide count. The rewind target of a step past
 * the last card sits a whole lap away, and the browser clamps scrollLeft at the
 * end of the content: a trailing run narrower than the viewport would leave
 * that target unreachable and the rewind would land off-card. When the gallery
 * is shorter than the viewport the run repeats the real cards instead.
 */
export function cloneCountFor(count, viewport, step) {
    if (!(count > 1) || !(step > 0) || !(viewport > 0)) return 0;
    return Math.max(1, Math.ceil(viewport / step));
}

/** Whether the real cards overflow the viewport (i.e. the arrows do anything). */
export function overflows(count, viewport, step) {
    return count > 1 && step > 0 && count * step > viewport + 1;
}

/** Scroll offset that puts real card 0 under the left edge. */
export function realStartFor(clones, step) {
    return clones * step;
}

/**
 * Rewind an offset that ran into (or past) an edge clone back into the real
 * window, preserving the fractional position so a half-panned drag is not
 * yanked to a card boundary.
 */
export function wrapOffset(left, clones, count, step) {
    const total = count * step;
    if (!(total > 0) || !(step > 0)) return left;
    const realStart = clones * step;
    let out = left;
    while (out < realStart - step / 2) out += total;
    while (out >= realStart + total - step / 2) out -= total;
    return out;
}

/** Real slide index under the left edge at the given offset. */
export function indexAt(left, clones, count, step) {
    if (!(step > 0) || count < 1) return 0;
    const raw = Math.round((left - clones * step) / step);
    return ((raw % count) + count) % count;
}

/**
 * Render order of the augmented track: [tail clones][real cards][head clones].
 * The tail run ends on the last real card, the head run starts on the first;
 * runs longer than the gallery simply repeat it.
 */
export function wheelItems(count, clones) {
    const items = [];
    if (!(count > 0)) return items;
    const laps = Math.max(0, Math.floor(clones));
    for (let i = 0; i < laps; i++) {
        items.push({ realIndex: ((count - laps + i) % count + count) % count, clone: true });
    }
    for (let i = 0; i < count; i++) items.push({ realIndex: i, clone: false });
    for (let i = 0; i < laps; i++) items.push({ realIndex: i % count, clone: true });
    return items;
}
