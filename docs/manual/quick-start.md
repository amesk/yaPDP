## Quick Start

On your very first launch the emulator greets you with a short onboarding hint that explains what to do
right away — which page to open, the mounted guest OSes and their boot commands. A **Quick boot**
button next to **Got it** opens the wizard directly, so a first-time user can see a guest OS running
in one click:

![First-run onboarding hint](assets/images/manual/dialog-onboarding.png)

The first-run onboarding hint.

### The magic wand

**In a hurry?** Use the **magic wand** button in the top-right corner of the window. It stays on
every page except **Info**. One click does everything:

- Opens a picker listing every guest operating system (and the paper tapes ) whose image this build ships — the picker is filtered by the build manifest ( media/manifest.json ), plus any images you have imported by drag & drop . Paper tapes always stay listed.
- Chooses one, switches to the operator console , and reboots the machine.
- Types the boot command — and the login too, where the credentials are known (e.g. Unix V5: boot rk0 → unix → login root ).

![Quick boot picker](assets/images/manual/dialog-quickboot.png)

The quick-boot picker lists every guest OS and paper tape.

The wizard is prompt-aware: it watches the console output and types the login only when the guest
actually prints `login:`, so slow boots with lots of output (e.g. 2.11 BSD) still reach the
prompt reliably. Each guest also declares the machine profile it wants — e.g. RT-11/RSX/RSTS enable the
LP11 line printer, and Unix V5/BSD force a teletype console — so the wizard
reconfigures the machine if
needed and resumes the boot automatically. Every wizard boot starts on a fresh page (clean paper and
clear screens), and a toast warns
*"Autoloading in progress — don't touch the teletype/keyboard"* while the sequence is being
typed.

![Autoloading in progress toast](assets/images/manual/dialog-autoload.png)

While the wizard types the boot sequence, a toast asks you not to touch the
teletype/keyboard.

### The classic way

- At the @ prompt, type boot rp1 and press ENTER.
- BSD 2.11 will autoboot into multiuser mode. Login as root (no password).
- Try ls , ps -aux , df — or compile a C program with cc .
