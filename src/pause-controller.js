/* Global pause coordination for the emulated machine. */
(function (global) {
    "use strict";

    let paused = false;
    const participants = [];

    function isPaused() {
        return paused;
    }

    function register(participant) {
        if (!participant || participants.indexOf(participant) !== -1) return;
        participants.push(participant);
        if (paused && typeof participant.pause === "function") participant.pause();
    }

    function setPaused(value) {
        value = !!value;
        if (paused === value) return;
        paused = value;

        participants.forEach(function (participant) {
            const method = paused ? participant.pause : participant.resume;
            if (typeof method === "function") method();
        });

        const button = typeof document !== "undefined"
            ? document.getElementById("pause-btn") : null;
        if (button) {
            button.setAttribute("aria-pressed", String(paused));
            button.setAttribute("aria-label", paused ? "Resume the machine" : "Pause the machine");
            button.title = paused ? "Resume the machine" : "Pause the machine";
        }
        if (typeof document !== "undefined" && typeof document.dispatchEvent === "function" &&
            typeof CustomEvent !== "undefined") {
            document.dispatchEvent(new CustomEvent("yapdp:pausechange", {
                detail: { paused: paused }
            }));
        }
    }

    const api = {
        isPaused: isPaused,
        register: register,
        pause: function () { setPaused(true); },
        resume: function () { setPaused(false); },
        toggle: function () { setPaused(!paused); }
    };

    global.YapdpPauseController = api;

    if (typeof document !== "undefined") {
        const button = document.getElementById("pause-btn");
        if (button) button.addEventListener("click", function () { api.toggle(); });
    }
})(typeof window !== "undefined" ? window : globalThis);
