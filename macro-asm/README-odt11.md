# ODT-11 — Historic Console ODT for the T-11 (2716 PROM)

This directory holds the historic build artifacts of **ODT11**, a console
ODT (Octal Debugging Technique) monitor for the Soviet T-11 CPU, intended
to be blown into a 2716 PROM. The source is the DECUS offering `ODT11X`,
heavily extended (many features resembling RT-11's ODT), borrowed from
http://dph.fluff.org/pdp11/odts.mac

## Files

| File              | Description |
|-------------------|-------------|
| `odt11.mac`       | Source, ~29 KB, LF line endings. **One cosmetic fix applied**: a final newline was appended to the last line (`.end ; odt`), see "The EQ 0 mystery" below. |
| `odt11-v04.lst`   | **Reference listing**: assembled with real DEC **MACRO V04.00** (RT-11SJ V04.00C) inside the yaPDP emulator — **0 errors**. |
| `ODT11.OBJ`       | Relocatable object produced by the same V04.00C build (entry point ODT = 000000R, psect ODT11S = 004326 words). |
| `odt11.lst`       | Older reference listing from **V05.05** (Krehbiel `macro11.exe`). **Use with caution**: V05.05 assembles a *different* program — see below. |

## The "EQ 0" mystery (resolved)

Assembling the pristine source under V04.00C produced exactly one error:

```
EQ    0						.end	; odt
ERRORS DETECTED:  1
```

**Root cause:** the source file ended with `.end ; odt` **without a trailing
newline** (last byte of file = `t` of `odt`). MACRO V04.00 mishandles an
`.end` directive in the final line of a file that lacks the terminating
line-feed: it prints `EQ 0` (the entry point loses its relocatable flag —
`0` instead of the correct `000001`) and counts it as an error.

**Fix:** append a single newline to the file (`printf '\n' >> odt11.mac`).
The file then assembles clean:

```
   1078		000001 				.end	; odt
ERRORS DETECTED:  0
```

No source lines were changed; the fix is purely cosmetic (EOF terminator).

## V04.00 vs V05.05 — which reference is correct?

The two assemblers **disagree on which conditional branch to take**:

- V04.00C (real DEC RT-11 MACRO) assembles the `.if df,test` branch
  (lines 60-63: `jsr r5,svttyp` / `.asciz 'ODT11'` /
  `mov #break,@#tvec` / `mov #stm,@#tvec+2`).
- V05.05 (Krehbiel `macro11.exe`) **silently skips** that branch and
  assembles the `.iff` alternative (`clr csr1`) instead.

Since `test=1` is defined at the top of the file, **V04.00C is correct** and
V05.05's "clean" listing is of a *different program*. This also explains the
persistent 10₈-word size difference between the two listings
(`ODT11S 004326` under V04 vs `004314` under V05).

## PROM build (T-11, no RT-11 test harness)

`odt11-prom.mac` is the same source with the `test=1` line **deleted**
(not set to 0: `.if df,test` tests *definedness*, so `test=0` still selects
the RT-11 branch). With `test` undefined:

- `o.break = 0` (HALT trap), `.asect`, code located at **170000**
- restart vectors: `power:` = 172000 (`jmp odt`), `reset:` = 172004
- the 120-byte stack and terminal greeting are omitted;
  `. = 174000+210` places the workspace at 174210

Files:

| File | Description |
|------|-------------|
| `odt11-prom.mac` | Source with `test=1` line removed |
| `odt11-prom.lst` | V04.00C listing, **0 errors** |
| `odt11-prom.bin` | Raw image, 170000-174375 (2302 bytes), little-endian words. Code ends at 174006; the tail (174210-174375) is the zero-filled RAM workspace (`ur0`..`csr2`), not ROM contents |

**Size note:** the code proper is `4006` octal (2054 decimal) bytes —
6 bytes too large for a 2716 (2K x 8 = 2048 bytes); a 2732 (4K) fits.
The source's own ROM-size check (`.iif gt,.-174000 .error ...`) is
commented out in the original.

## Rebuilding (RT-11SJ V04.00C in the yaPDP emulator)

### bootcode (src/bootcode.js) — one command

The boot loader is rebuilt end to end by `npm run rebuild-boot`
(`tools/rebuild-bootcode.js`), which joins the three working pieces — the
headless batch driver, the RT-11 build script below, and `bin2bootdump` — and
writes `src/bootcode.js`. It needs no host-side cross tools (`macro11.exe` is
not used) and fails if the result is not byte-for-byte identical to the
shipped image.

Notes for anyone editing the script:
- the tape wants **CRLF** line endings (RT-11 reads CR as the line delimiter);
- the headless machine mounts a **single** RK drive, so its RT-11 name is
  `DK:` (not `DK1:` — that needs a second drive);
- `--prompt ""` is passed to `headless-term` because the guest prompt is `.`
in the RT-11 monitor but `*` inside MACRO/LINK, so the script drives every
  transition with `:wait`;
- the assembler and linker are left with Ctrl-C (`:raw 03`) instead of a
  smoke run — running the assembled loader would take over the console;
- the linker base is set with `/B:120000` (`DK:BOOT.SAV=DK:BOOT/B:120000`);
  without it the module links at the RT-11 default `1000` and four absolute
  words stay `0o117000` low.

### ODT-11 (odt11.mac) — manual script

1. Punch the source to paper tape (raw bytes, no header):
   `cp odt11.mac odt11.ptap`
2. In the emulator (`tools/headless-term.js` batch mode — headless, no browser;
   the older puppeteer-based `tools/rt11-term.js` is kept as legacy):
   ```
   :mount odt11.ptap
   COPY PC: ODT11.MAC
   R MACRO
   DK1:ODT11.OBJ,DK1:ODT11.LST=DK1:ODT11.MAC
   ```
3. Export the listing/object back:
   ```
   COPY DK1:ODT11.LST PC:
   COPY DK1:ODT11.OBJ PC:
   ```

## Notes

- `ODT11S` is a relocatable csect (length `004326`); `odt::` (the entry
  point) is its first label. The `.end odt` entry is `000001` (0R + the
  relocatable flag bit).
- The `test=1` conditional selects the RT-11 test harness (BREAK = 3,
  terminal init, 120-byte stack). For a real 2716 PROM build, assemble
  with `test=0` (T-11: BREAK = 0, `.asect`, code at 170000).
- This ODT is **not** part of the yaPDP runtime; it is preserved here as a
  historical build kit.
