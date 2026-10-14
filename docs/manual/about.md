## About yaPDP

yaPDP is a high-fidelity interactive environment for exploring the DEC
PDP-11/70 computer system and its software ecosystem. Unlike simple CPU
emulators, yaPDP recreates the entire user experience of the 1970s:
from toggling bits on the front panel to booting Unix V5 on a teletype
console.

The project is designed as a professional-grade pet project,
demonstrating engineering culture and attention to historical detail.
It serves not just as a tool for retro-computing enthusiasts, but as a
platform for education and digital preservation.

### Key Features

- **Authentic Hardware:** Faithful recreation of the PDP-11/70 front
  panel, Model 33 ASR teletype, VT52/VT100 terminals, LP11 line
  printer, and VT11 vector display.
- **Real Software:** Ships with 16+ guest operating systems including
  Unix V5, RT-11, RSTS/E, RSX-11M, and BSD 2.11.
- **Shareable States:** Save and share complete machine states (memory,
  devices, screen content) via links or GitHub Gists.
- **Museum-Ready:** Designed for embedding in educational websites and
  digital exhibitions with guided restore scenarios.

### For Museums & Educators

yaPDP is built to be easily integrated into museum exhibits, educational
platforms, and personal blogs. The emulator works seamlessly in web
environments without requiring complex server setup.

#### Embedding the Emulator

You can embed yaPDP in any website using a standard HTML iframe. This
allows visitors to interact with a live PDP-11 without leaving your
site. See the [Embedding the emulator](#machine-state) section in the
Machine State chapter for detailed instructions and examples.

#### Creating Interactive Exhibits

Use the **Share** feature to create self-contained exhibits. You can add
custom titles, descriptions, screenshots, and automated post-restore
commands (e.g., launching a specific program).

To ensure reliable loading for all visitors, we recommend hosting these
states on GitHub Gist. This bypasses common CORS (Cross-Origin Resource
Sharing) restrictions that often block direct file loading from external
servers.

#### Why yaPDP for Education?

- **Zero Installation:** Runs directly in the browser.
- **Guided Learning:** Use "Guided Restore" to lead students through
  historical workflows step-by-step.
- **Historical Context:** Includes detailed documentation on hardware
  fidelity and limitations, helping users distinguish between emulator
  behaviour and original hardware characteristics.