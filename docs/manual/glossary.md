## Glossary

**ASR-33**
:   Model 33 ASR (Automatic Send-Receive) teletype, the operator console of the PDP-11/70. An electromechanical terminal that prints on paper roll and can read/punch 8-track paper tape.

**Boot device**
:   The emulated Boot ROM socket that determines what the machine does after power-on: None (idle), Interactive loader (@ prompt) or Last medium (boot the last-used device directly).

**CONFIG**
:   The configuration page where emulated peripherals are enabled or disabled: user terminals, LP11 printer, VT11 display, teletype width/speed, and behaviour options.

**Console**
:   The operator console (`TT0:`), the machine's own typewriter. Can be a Model 33 ASR teletype, a DECscope VT52 or a DEC VT100.

**DL11**
:   The asynchronous serial-line interface that connects the PDP-11 to its console and terminals.

**DECscope VT52**
:   A video terminal introduced by DEC in 1974, with a green-phosphor CRT and a limited set of control sequences (predecessor of the VT100).

**DEC VT100**
:   A video terminal introduced by DEC in 1978, with a white (P4) phosphor, full ANSI X3.64 escape-sequence support and a modular design.

**Guest OS**
:   An operating system that runs inside the emulated PDP-11/70: 2.11 BSD, Unix V5, RT-11, RSX-11M, RSTS/E, XXDP and others.

**LP11**
:   The Line Printer model LP11, an animated line printer page that prints guest output on fanfold paper.

**Magic wand**
:   The quick-boot wizard button (top-right corner) that picks a guest OS, reconfigures the machine, reboots and types the boot command and login automatically.

**Panel**
:   The front-panel page with switches, LEDs and rotary knobs that recreate the PDP-11/70 operator panel.

**Paper tape**
:   8-track punched tape used for data storage and exchange. The ASR-33 can read and punch paper tape; the Storage page manages tape files.

**Snapshot**
:   A saved state of the machine's memory and registers, which can be restored later. Snapshots are tied to the exact disk image build they were taken on.

**Storage**
:   The page that manages disk images, tape images and paper tapes: a drop zone for imports, a mount table and a paper-tape reader/punch archive.

**TTY 1 / TTY 2**
:   User video terminals (VT52 or VT100), shown as separate sidebar pages when configured.

**VT11**
:   The DEC VT11 vector-graphics display processor, an optional CRT page for graphical applications like Lunar Lander.

**@ prompt**
:   The interactive loader prompt (`@`) where boot commands are typed, e.g. `boot rp1` to start 2.11 BSD.