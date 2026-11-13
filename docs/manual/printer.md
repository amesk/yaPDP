## The LP11 Line Printer (Printer page)

The LP11 is an animated line printer on wide 132-column paper (72/80/100/132 selectable). It has no
keyboard — it only prints. Use the **Print** button to send the accumulated jobs to the real OS
printer via the system dialog, or **Save.txt** to export the output (page breaks are kept as real
`\f` markers).

**Print** lays the job out the way the mechanism did: one sheet per form feed (and never more than
66 lines on a sheet), with the configured column count — 132 by default — stretched across the
printable width of whatever paper you choose in the dialog, so a full line reaches the edge instead
of wrapping. The sheet is turned **landscape**, because a line-printer sheet is wider than it is
tall (14⅞ × 11″), and the character cell is the machine's own **6 LPI at 10 pitch**, so the
132 × 66 block keeps the proportion of the real 13.2 × 11″ printed area, with the remaining width
standing in for the tractor strips. As on a real line printer, the glyph is drawn **inside** the
cell rather than filling it — the dot matrix never covered the whole cell — which is why 6 LPI type
has air between the lines instead of touching. The sheet is drawn with the same artwork the Printer
page uses — the green-bar paper tile, one tile per four character rows so the bars keep their
period, and a column of black feed holes down each edge, half an inch apart — with the 132 columns
filling the space between the strips. Those are CSS backgrounds, so the browser prints them only
when **Background graphics** is enabled in the print dialog; on a job going onto real fanfold the
perforation is already in the paper. Double-struck glyphs (nroff bold) print bold and underscored
ones print underlined; a **composed** column prints the two strikes that built it, exactly like the
Printer page. **Save.txt** stays plain text.

![The LP11 line printer](assets/images/manual/printer.png){.shot}

The LP11 line printer printing a job listing.{.shot-caption}

- **Speed.** Like the real LP11, it echoes characters far faster than the [Model 33 ASR console teletype](#console) (which keeps its authentic ~33 cps pacing), printing at close to the original's ~300 lines/min.
- **DONE handshake.** The LP11 honours the historical DONE handshake: writing LPDB clears DONE and re-asserts it as each character is consumed by the mechanism, so a guest print job is throttled at printer speed.
- **OFF LINE.** When the printer is OFF LINE (or powered off), the controller latches a sticky ERROR flag in LPCS while keeping DONE set — so a guest OS driver reports an error (e.g. `?LP0: I/O error`) instead of silently discarding the job.
- **Composed characters.** A driver prints a character its printer's type train lacks by striking a base glyph and a mark over it in one column — Unix V5's `lp.c` prints a `{` as `(` struck over by `-`, backing the carriage up one column so the pair shares a single column. The paper paints the two strikes over each other, while **Save.txt** (and the paper kept in a saved state) carries the composed character (`{`, `}`, `|`, `~`, `` ` ``), so a listing keeps its alignment and the export stays readable. A character the guest printed directly, with no overstrike, is never composed back.
- **Form feed.** The LP11 honours form feed (FF, 0x0C) — the 2.11BSD spooler (`lpr` / `lpd`) sends FF between jobs so each starts on a fresh page: it fills the rest of the sheet (66 lines at 6 LPI) and closes it with a dashed fold/perforation marker. The same break is a sheet break in **Print**, and a form feed that arrives when nothing has been printed since the last one does not waste a blank sheet. The seam is a property of the fanfold, not of the job: a sheet that fills up on its own gets its perforation at the 66th line too, even when the driver never sends FF for it.
- **Tabs & paper.** The carriage advances to the next 8-column tab stop on TAB, and the paper is sized to the configured print width (centred in the machine body). The cabinet auto-scales down proportionally to fit the window when it gets too small, and the rising fanfold paper climbs the same fraction of the window after scaling.
