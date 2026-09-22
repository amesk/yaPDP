## The Front Panel (Panel page)

Every switch, LED, and rotary knob of a real PDP‑11/70 is faithfully recreated. The Panel page is where
you toggle in a bootstrap loader the way DEC engineers did in the 1970s.

![The PDP-11/70 front panel](assets/images/manual/panel.png)

The PDP‑11/70 front panel, powered on.

### Front panel switch sequences

A simple light chaser — toggle this in to see the address and data LEDs dance:

`Switch sequence: HALT, 001000, LOAD ADDRESS
012700, DEPOSIT
000001, DEPOSIT
006100, DEPOSIT
000005, DEPOSIT
000775, DEPOSIT
001000, LOAD ADDRESS, ENABLE, START`

Restart the bootloader:

`HALT, 120000, LOAD ADDRESS, ENABLE, START`

The **Bootstrap now!** button refuses to start the machine while it is powered off:

![Bootstrap now! power-off guard](assets/images/manual/dialog-poweroff.png)

Bootstrap now! requires the machine to be powered on first.

The dialog also offers a shortcut to the CONFIG **Auto-boot** option: tick the checkbox to start
the default bootstrap automatically on every future power-on, without visiting the Config page. The
choice persists and stays in sync with the CONFIG page checkbox.
