/**
 * yaPDP — Image fingerprint
 *
 * The identity of a disk/tape image, as a short string. Everything that
 * remembers something about an image — the write-back block cache in
 * IndexedDB, a captured disk overlay, a snapshot — has to answer one
 * question before it is trusted again: "is this still the same disk?"
 *
 * It used to be answered by a hand-maintained constant (IMAGE_VERSION in
 * diskstore.js). That constant was bumped by hand, and the hand forgot: the
 * BSD 2.11 image (media/rp1.dsk.zst) was repacked three times in two days
 * while IMAGE_VERSION stayed at "0.1.0". A stale cached block then matched
 * the current version and was overlaid onto a different disk — the very
 * corruption the constant was introduced to prevent.
 *
 * So the answer is computed instead of remembered: the fingerprint of the
 * IMAGE BYTES the browser actually received. Repack the image and every
 * fingerprint derived from it changes, without anyone having to remember
 * anything.
 *
 * Fingerprint = FNV-1a/32 of the raw `.zst` body, as 8 lowercase hex digits.
 * FNV-1a is the right size for this: the job is "did the bytes change", not
 * "did an attacker forge them", and it is a few lines that run everywhere
 * (no crypto.subtle, no async, no WebCrypto policy in a file:// page).
 *
 * Deliberate edges:
 *   - The fingerprint is of the COMPRESSED body, not the decompressed image:
 *     that is the byte stream the fetcher already holds (fetchBlock streams
 *     `media/<url>.zst`), so no second pass over a 20 MB image is needed.
 *     A repack with the same bytes still changes the fingerprint when the
 *     archive differs, which is the conservative direction: a fingerprint
 *     mismatch discards a cache, never a disk.
 *   - A `null`/absent fingerprint is NOT "everything matches": callers must
 *     treat it as "unknown", and unknown never invalidates (see matches()).
 *     That keeps the file:// and desktop-bundle paths, which never fetch a
 *     `.zst`, working exactly as before.
 *
 * Public surface: window.__yapdpImageFingerprint (browser) and
 * module.exports { ImageFingerprint } (Node tests). Pure — no DOM.
 */
"use strict";

var ImageFingerprint = (function () {
    "use strict";

    // FNV prime 16777619 split into 16-bit halves (HI=256, LO=403).
    const FNV_PRIME_HI = 16777619 >>> 16; // 256
    const FNV_PRIME_LO = 16777619 & 0xffff; // 403

    // h * FNV_PRIME mod 2^32, in exact float64 arithmetic.
    //
    // Neither shortcut works: `h * 16777619` exceeds 2^53 for large h (the
    // product is exact only up to 2^53, and 2^32 * 16777619 is ~7.2e16), so
    // `>>> 0` truncates a number that already lost its low bits; and the
    // shift decomposition ((h << 24) + ...) is wrong because `<<` is a
    // 32-bit SIGNED shift, so the high term goes negative for large h and
    // `>>> 0` on the term wraps it before the addition.
    //
    // Splitting the prime keeps every intermediate exact:
    //   h * (HI*2^16 + LO)  =  (h*LO) + ((h*HI) mod 2^16) * 2^16   (mod 2^32)
    // with h*LO < 2^48 and h*HI < 2^48, both well inside 2^53.
    function mul32(h) {
        var lo = h * FNV_PRIME_LO; // < 2^48, exact
        var hi = (h * FNV_PRIME_HI) % 65536; // low 16 bits, < 2^16
        return (lo + hi * 65536) % 4294967296;
    }

    // FNV-1a/32 over a byte array (Uint8Array, Buffer, any indexable bytes).
    // Returns a number in [0, 2^32); format() turns it into the stored form.
    function fnv1a32(bytes) {
        var h = 0x811c9dc5; // offset basis
        for (var i = 0; i < bytes.length; i++) {
            h = (h ^ (bytes[i] & 0xFF)) >>> 0;
            h = mul32(h);
        }
        return h >>> 0;
    }

    // The stored form: 8 lowercase hex digits, zero padded, always the same
    // width so a fingerprint sorts and compares like a plain string.
    function format(hash) {
        return ("0000000" + (hash >>> 0).toString(16)).slice(-8);
    }

    // Fingerprint of an image body. Empty or absent bytes have no identity:
    // return null so callers store "unknown" rather than a hash of nothing.
    function ofBytes(bytes) {
        if (!bytes || typeof bytes.length !== "number" || bytes.length === 0) {
            return null;
        }
        return format(fnv1a32(bytes));
    }

    // Do two fingerprints describe the same image? An UNKNOWN fingerprint on
    // EITHER side matches: a value that was never computed cannot contradict
    // anything, and treating "unknown" as a mismatch would throw away good
    // caches (and refuse good snapshots) on every host without a `.zst`.
    function matches(a, b) {
        if (a == null || b == null) return true;
        return String(a) === String(b);
    }

    // Human-facing note for a mismatch, used by the dialogs. Kept here so the
    // wording and the rule live together.
    function describe(then, now) {
        return "expected " + (then == null ? "unknown" : String(then)) +
            ", found " + (now == null ? "unknown" : String(now));
    }

    return {
        fnv1a32: fnv1a32,
        format: format,
        ofBytes: ofBytes,
        matches: matches,
        describe: describe
    };
})();

if (typeof window !== "undefined") window.__yapdpImageFingerprint = ImageFingerprint;
if (typeof module !== "undefined" && module.exports) {
    module.exports = { ImageFingerprint: ImageFingerprint };
}
