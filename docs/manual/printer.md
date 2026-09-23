## The LP11 Line Printer (Printer page)

The LP11 is an animated line printer on wide 132-column paper (72/80/100/132 selectable). It has no
keyboard — it only prints. Use the **Print** button to send the accumulated jobs to the real OS
printer via the system dialog, or **Save.txt** to export the output (page breaks are kept as
`\f` markers).

![The LP11 line printer](assets/images/manual/printer.png)

The LP11 line printer printing a job listing.

- Speed. Like the real LP11, it echoes characters far faster than the Model 33 ASR console teletype (which keeps its authentic ~33 cps pacing), printing at close to the original's ~300 lines/min.
- DONE handshake. The LP11 honours the historical DONE handshake: writing LPDB clears DONE and re-asserts it as each character is consumed by the mechanism, so a guest print job is throttled at printer speed.
- OFF LINE. When the printer is OFF LINE (or powered off), the controller latches a sticky ERROR flag in LPCS while keeping DONE set — so a guest OS driver reports an error (e.g. ?LP0: I/O error) instead of silently discarding the job.
- Form feed. The LP11 honours form feed (FF, 0x0C) — the 2.11BSD spooler (lpr / lpd) sends FF between jobs so each starts on a fresh page: it fills the rest of the sheet (66 lines at 6 LPI) and closes it with a dashed fold/perforation marker.
- Tabs & paper. The carriage advances to the next 8-column tab stop on TAB, and the paper is sized to the configured print width (centred in the machine body). The cabinet auto-scales down proportionally to fit the window when it gets too small, and the rising fanfold paper climbs the same fraction of the window after scaling.
