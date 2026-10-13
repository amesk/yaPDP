/**
 * yaPDP — Text envelope for sharing .state.zst via GitHub Gist.
 *
 * The envelope wraps a binary .state.zst file in a text format that can be
 * pasted into a GitHub Gist (or any text pastebin). The format:
 *
 *   yapdp-text-envelope-v1
 *   <base64-encoded content, wrapped at 76 characters>
 *
 * Public surface: window.__yapdpStateEnvelope (browser) and
 * module.exports { StateEnvelope } (Node tools and tests).
 */
"use strict";

var StateEnvelope = (function () {
    "use strict";

    var MARKER = "yapdp-text-envelope-v1";
    var LINE_WRAP = 76;

    // Encode bytes to a base64 string with chunked processing for large arrays.
    function bytesToBase64(bytes) {
        var binary = "";
        var chunkSize = 8192;
        for (var i = 0; i < bytes.length; i += chunkSize) {
            var end = Math.min(i + chunkSize, bytes.length);
            var chunk = bytes.subarray(i, end);
            binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
    }

    // Decode a base64 string to bytes.
    function base64ToBytes(b64) {
        var binaryStr = atob(b64);
        var len = binaryStr.length;
        var bytes = new Uint8Array(len);
        for (var i = 0; i < len; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
        }
        return bytes;
    }

    /**
     * Encode binary .state.zst bytes into a text envelope string.
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    function encode(bytes) {
        var b64 = bytesToBase64(bytes);
        var lines = [MARKER];
        for (var i = 0; i < b64.length; i += LINE_WRAP) {
            lines.push(b64.substr(i, LINE_WRAP));
        }
        return lines.join("\n");
    }

    /**
     * Decode a text envelope string back to binary .state.zst bytes.
     * Returns null when the text is not a valid envelope.
     * @param {string} text
     * @returns {Uint8Array|null}
     */
    function decode(text) {
        if (!isEnvelope(text)) return null;
        var lines = text.split("\n");
        // Skip the marker line, join the rest.
        var b64 = lines.slice(1).join("");
        if (!b64 || !b64.length) return null;
        try {
            return base64ToBytes(b64);
        } catch (e) {
            return null;
        }
    }

    /**
     * Check whether a string is a text envelope.
     * @param {string} text
     * @returns {boolean}
     */
    function isEnvelope(text) {
        return typeof text === "string" && text.startsWith(MARKER + "\n");
    }

    return {
        MARKER: MARKER,
        encode: encode,
        decode: decode,
        isEnvelope: isEnvelope,
    };
})();

if (typeof window !== "undefined") window.__yapdpStateEnvelope = StateEnvelope;
if (typeof module !== "undefined" && module.exports) {
    module.exports = { StateEnvelope: StateEnvelope };
}