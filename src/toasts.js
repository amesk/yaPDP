/**
 * yaPDP — Toast notifications
 *
 * A small, DOM-independent notification subsystem. The window injects an
 * adapter (a set of callbacks) at startup; this module only owns the queue,
 * the timing and the categories — it never touches document, CSS or any DOM
 * element itself.
 *
 * Behaviour (single-slot + preemption stack):
 *   - every toast has an absolute deadline = start time + duration;
 *   - exactly one toast is visible at a time;
 *   - show() preempts the active toast: the active one is pushed to the FRONT
 *     of the queue and the new one is shown for its full duration;
 *   - when the active toast finishes, the first queued toast is restored for
 *     its remaining time (deadline - now); if its deadline has already passed
 *     it is dropped, and the next one is tried.
 *
 * Adapter contract (window-provided callbacks):
 *   mount()                — create/attach the DOM element (called on configure)
 *   update({ text, category }) — set text + category (CSS class)
 *   show()                 — make the element visible
 *   hide()                 — hide the element
 *
 * Public surface: window.Toasts (browser) and module.exports { Toasts }
 * (Node tests). Test hook: __setTimers({ now, set, clear }) replaces the
 * clock/timer functions so the queue can be driven deterministically.
 */
"use strict";

var Toasts = (function () {
    var adapter = null;
    var current = null;               // { text, category, deadline, timer }
    var queue = [];                   // preempted toasts: FRONT of queue first
    var DEFAULTS = { info: 3000, warning: 4000, error: 5000 };

    // Clock / timer functions. Replaceable via __setTimers for Node tests.
    var clock = {
        now: function () { return Date.now(); },
        set: function (fn, ms) { return setTimeout(fn, ms); },
        clear: function (id) { clearTimeout(id); }
    };

    function normalizeCategory(c) {
        return (c === "warning" || c === "error") ? c : "info";
    }

    // Called when the active toast expires: restore the first queued toast
    // that is still "owed" visible time, otherwise hide.
    function step() {
        var now = clock.now();
        current = null;
        while (queue.length) {
            var next = queue.shift();
            if (next.deadline <= now) continue;   // expired while hidden: drop
            current = next;
            if (adapter) { adapter.update(next); adapter.show(); }
            current.timer = clock.set(step, next.deadline - now);
            return;
        }
        if (adapter) adapter.hide();
    }

    function show(opts) {
        if (!adapter || !opts || !opts.text) return null;
        var category = normalizeCategory(opts.category);
        var duration = (typeof opts.duration === "number" && opts.duration >= 0)
            ? opts.duration
            : DEFAULTS[category];
        var now = clock.now();

        // Preempt the active toast: it goes to the FRONT of the queue (stack
        // of preemptions — the most recently preempted is restored first).
        if (current) {
            clock.clear(current.timer);
            queue.unshift({
                text: current.text,
                category: current.category,
                deadline: current.deadline
            });
        }

        current = { text: opts.text, category: category, deadline: now + duration, timer: null };
        adapter.update(current);
        adapter.show();
        current.timer = clock.set(step, duration);
        return current;
    }

    function clear() {
        if (current) clock.clear(current.timer);
        current = null;
        queue.length = 0;
        if (adapter) adapter.hide();
    }

    function configure(a) {
        adapter = (a && typeof a.update === "function") ? a : null;
        if (adapter && typeof adapter.mount === "function") adapter.mount();
    }

    return {
        configure: configure,
        show: show,
        clear: clear,
        __setTimers: function (c) {
            if (c && typeof c.now === "function" &&
                typeof c.set === "function" && typeof c.clear === "function") {
                clock = c;
            }
        }
    };
})();

if (typeof window !== "undefined") window.Toasts = Toasts;
if (typeof module !== "undefined" && module.exports) module.exports = { Toasts: Toasts };
