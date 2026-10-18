/**
 * yaPDP — canonical image identity
 *
 * An image identity is SHA-256 of the decompressed resource bytes. Compression
 * is a transport/storage detail: recompressing the same image must not change
 * its identity. The same value protects DiskStore blocks, snapshot overlays,
 * and snapshot compatibility checks.
 *
 * This implementation is synchronous and self-contained so it also works in
 * file:// pages and desktop WebViews where crypto.subtle may be unavailable.
 * Images are hashed once when mounted, not on every block read.
 *
 * Empty or absent byte arrays have no identity (null). Unknown identities are
 * permissive for hosts that genuinely cannot expose the original bytes.
 *
 * Public surface: window.__yapdpImageFingerprint (browser) and
 * module.exports { ImageFingerprint } (Node tests). Pure — no DOM.
 */
"use strict";

var ImageFingerprint = (function () {
    "use strict";

    var K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
        0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    function rotateRight(value, bits) {
        return (value >>> bits) | (value << (32 - bits));
    }

    function sha256(bytes) {
        var length = bytes.length;
        var paddedLength = Math.ceil((length + 9) / 64) * 64;
        var padded = new Uint8Array(paddedLength);
        for (var i = 0; i < length; i++) padded[i] = bytes[i] & 0xff;
        padded[length] = 0x80;

        // The resource sizes used by yaPDP are far below 2^29 bytes, but write
        // the full 64-bit message length as required by SHA-256.
        var bitLength = length * 8;
        var high = Math.floor(bitLength / 4294967296);
        var low = bitLength >>> 0;
        var tail = paddedLength - 8;
        padded[tail] = (high >>> 24) & 0xff;
        padded[tail + 1] = (high >>> 16) & 0xff;
        padded[tail + 2] = (high >>> 8) & 0xff;
        padded[tail + 3] = high & 0xff;
        padded[tail + 4] = (low >>> 24) & 0xff;
        padded[tail + 5] = (low >>> 16) & 0xff;
        padded[tail + 6] = (low >>> 8) & 0xff;
        padded[tail + 7] = low & 0xff;

        var h0 = 0x6a09e667;
        var h1 = 0xbb67ae85;
        var h2 = 0x3c6ef372;
        var h3 = 0xa54ff53a;
        var h4 = 0x510e527f;
        var h5 = 0x9b05688c;
        var h6 = 0x1f83d9ab;
        var h7 = 0x5be0cd19;
        var w = new Uint32Array(64);

        for (var offset = 0; offset < paddedLength; offset += 64) {
            var j;
            for (j = 0; j < 16; j++) {
                var p = offset + j * 4;
                w[j] = ((padded[p] << 24) | (padded[p + 1] << 16) |
                    (padded[p + 2] << 8) | padded[p + 3]) >>> 0;
            }
            for (j = 16; j < 64; j++) {
                var x = w[j - 15];
                var y = w[j - 2];
                var s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
                var s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
                w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
            }

            var a = h0, b = h1, c = h2, d = h3;
            var e = h4, f = h5, g = h6, h = h7;
            for (j = 0; j < 64; j++) {
                var big1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
                var choice = (e & f) ^ (~e & g);
                var t1 = (h + big1 + choice + K[j] + w[j]) >>> 0;
                var big0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
                var majority = (a & b) ^ (a & c) ^ (b & c);
                var t2 = (big0 + majority) >>> 0;

                h = g; g = f; f = e; e = (d + t1) >>> 0;
                d = c; c = b; b = a; a = (t1 + t2) >>> 0;
            }

            h0 = (h0 + a) >>> 0;
            h1 = (h1 + b) >>> 0;
            h2 = (h2 + c) >>> 0;
            h3 = (h3 + d) >>> 0;
            h4 = (h4 + e) >>> 0;
            h5 = (h5 + f) >>> 0;
            h6 = (h6 + g) >>> 0;
            h7 = (h7 + h) >>> 0;
        }

        return [h0, h1, h2, h3, h4, h5, h6, h7].map(function (word) {
            return ("00000000" + word.toString(16)).slice(-8);
        }).join("");
    }

    function ofBytes(bytes) {
        if (!bytes || typeof bytes.length !== "number" || bytes.length === 0) {
            return null;
        }
        return sha256(bytes);
    }

    // An unknown identity cannot contradict a known one. This preserves the
    // permissive behavior for hosts that cannot expose their image bytes.
    function matches(a, b) {
        if (a == null || b == null) return true;
        return String(a) === String(b);
    }

    function describe(then, now) {
        return "expected " + (then == null ? "unknown" : String(then)) +
            ", found " + (now == null ? "unknown" : String(now));
    }

    return {
        sha256: sha256,
        ofBytes: ofBytes,
        matches: matches,
        describe: describe
    };
})();

if (typeof window !== "undefined") window.__yapdpImageFingerprint = ImageFingerprint;
if (typeof module !== "undefined" && module.exports) {
    module.exports = { ImageFingerprint: ImageFingerprint };
}
