---
title: "Working in Unix V5 on a teletype: no lower case, hash to erase, at-sign to kill"
date: 2026-09-28
lang: en
summary: "Unix V5, 1974, on a Model 33 ASR. No lower case anywhere — on paper or on the keyboard. Hash erases a character, at-sign erases the whole line, and you find out by reading the debris. What it is actually like to work on the system everything else grew from."
---

The [first article](2026-09-23-bringing-back-the-machine-room.html) was about how the emulator came alive; the [second](2026-09-24-own-pdp11-anyway.html) about what it cost; the [third](2026-09-27-drawing-the-machine.html) about how the three terminals are drawn inside. This one is about the thing all of that was for: working in it.

Open the emulator in a second tab before reading. Everything below happens on paper, and the paper is only there.

The oldest system this project runs is Unix V5 — 1974, the forty thousand lines that BSD, Linux, Android and, incidentally, my day job all grew out of. What follows is what happens when you sit down at it. There is no `stty`, no `vi`, no lower case, and no patience.

## Boot: two at-signs

Three steps, and none of them are worth memorising.

Power on. The console prints `@`. That is my own monitor — PDP-11 assembly, assembled by real DEC MACRO V04.00 running inside RT-11 inside this very emulator. The emulator built itself a bootloader on the machine it emulates. The source is in [`macro-asm/boot.mac`](https://github.com/amesk/yaPDP/blob/master/macro-asm/boot.mac); the assembled image is [`src/bootcode.js`](https://github.com/amesk/yaPDP/blob/master/src/bootcode.js).

The `@` was not arbitrary. That is exactly how the M9312 console ROM greeted an operator, and the comment in my source says so: `23-248F1: movb #<'@>,r2`. A small thing, and it is out of small things like this that a web page stops feeling like a web page.

:::spoiler On authenticity
It is not strictly historical: the real primary bootstrap was silent, and I do not have a DEC Boot ROM board (it is waiting for the core refactor to finish, so I do not end up debugging a monolith forever). It is the best I could come up with.
:::

Then type `boot rk0`. That is not an operating system command — there is no operating system yet. The monitor reads block 0 of disk RK0 and jumps to address 0. From that second on, code written in 1974 is running: the Unix V5 secondary bootstrap prints its own `@`, and to that second `@` you type `unix`, the name of the kernel file.

Two prompts, visibly identical, quietly different. The first is mine; the second is the real one.

Then the kernel swallows the disk, and a second or two later it prints `login:`. The login is `root`, the password is empty — `/etc/passwd` in the fifth edition reads `root::0:1::/:`, and that is not a hole I forgot to close in the image, it is the state of the system at the time.

:::spoiler Notice how quiet the system is
The difference in manner is visible in the first second: the system says nothing it does not have to, and prints `login:`.

Try `boot rp1` instead and feel it. 2.11 BSD will rattle for minutes, print a wall of text, and you will drown in it long before you consciously decide you no longer want to read this at 110 baud.

That is fundamental, not cosmetic: **expensive printing** runs through Unix top to bottom. The philosophy — if everything is fine, say nothing, and the user will thank you for the paper and the seconds — outlived the hardware that produced it by fifty years. The devices are gone; the habit of silence on success is not.
:::

The whole sequence does not have to be typed: the quick-boot wizard carries it per guest — `boot rk0`, then `unix`, then `root` at `login:` ([`src/osboot.js`](https://github.com/amesk/yaPDP/blob/master/src/osboot.js)). At ten characters a second that saves about two minutes, which you would not have noticed anyway.

There is no magic in it. I know what the guest expects, and that knowledge is a table with one row per guest. CI runs the same sequence in Chromium and counts a boot as complete when `#` — the shell prompt — appears on the paper ([`tests/e2e-osboot.js`](https://github.com/amesk/yaPDP/blob/master/tests/e2e-osboot.js)). That symbol has a second role further down.

## First shock: there is no lower case

The Model 33 ASR puts characters on paper with a type box — twenty-six typebars, all capitals. Lower case does not exist on the machine. It was never made.

The Model 33 was not designed for computers at all. It was a teletype: not fast, but cheap and therefore everywhere. When computers arrived, the obvious thought was to hang this mass-produced, reliable, inexpensive device off the machine through a 20 mA current loop — the telegraph standard — and get an operator console and a paper-tape input-output device in one purchase.

In practice: any program that believes it is printing `login:` puts `LOGIN:` on the paper. And that is correct. The real machine of 1974 could not do otherwise, and what still delights me is that the historical behaviour here comes not from rendering but from honestly reproducing the limitation of the iron.

Two separate flags control this on the **Equipment** tab ([`src/config.js`](https://github.com/amesk/yaPDP/blob/master/src/config.js)):

- **Upper Case Only** — your physical keyboard sends capitals. Off by default.
- **Force PDP Output Uppercase** — folds what the machine has *already printed* into capitals. On by default, because that is what an ASR-33 does.

Two flags rather than one, because case can be lost in two completely different places: on the way from the keyboard to the machine, and on the way from the machine to the paper. The second would have been enough for authenticity — but without the first, on a Model 33 you physically cannot type anything except capitals, and I have 2.11 BSD, where file names are lower case and the system stopped being able to live otherwise. So the keyboard is the operator's business; the paper is history's.

Here is the interesting part. On an ASR-33 the punch sits *before* the print mechanism: it copies the byte that came from the machine, as it is. The case fold therefore happens after the punch. What that gives you: `LS` on the paper, and `ls` on the tape, byte for byte. Read that tape in LOCAL mode and you see capitals again, because the same type box prints it; switch the teletype to LINE and the machine receives the original lower case, and 2.11 BSD is happy.

So one session leaves two media with different case, and both are right. I do not know what practical use that has. I like that it works that way — and it is how the hardware worked; I went and checked.

## A keyboard that makes hash, at-sign and even NUL

People know the Model 33 keyboard is "not like a PC". They usually do not know how much.

It is **bit-paired**: one contact per key, one code, and SHIFT and CTRL do not change one letter into another — they invert specific bits. SHIFT flips `0x10`, CTRL flips `0x40`. Everything odd about the seventies follows: `3` with SHIFT is `#`, `P` with SHIFT is `@`, `K` is `[`, `N` is `^`, `M` is `]`. There is no notion of shifting case. There is arithmetic on the code.

And the detail I love most. On the keys that carry two legends (`P @ DLE`, `K [ VT`, `N ^ SO`, `M ] CR`), holding SHIFT and CTRL together clears both bits at once, and on `P` that gives **NUL** — the only way to punch a zero byte by hand, without a tape and without a program. I read that in the machine description, went to check the emulator — [`model33KeyCode()`](https://github.com/amesk/yaPDP/blob/master/src/pdp11-app.js) — and it matched.

Rows of those blank characters had a purpose beyond tidiness: with REPT held, operators punched the run of NULs that leads a tape — the only track carrying holes is the feed track. A tape with no leader could not be threaded: the reader needs something to pull the paper down to the first meaningful row.

CTRL and SHIFT are *sticky* here. Press CTRL, it latches, press a letter, get a control code; any other press releases it. That is not convenience I invented: it is how the code bars work. Nobody had to hold SHIFT down with a finger, as on a typewriter.

The legends on the keycaps are not decoration either — every letter key prints, above the letter, the control code it produces with CTRL, and those are exactly the codes emulated here:

| Key | CTRL name | Code | What it means |
| --- | --- | --- | --- |
| D | EOT | 0x04 | end of input — the CTRL+D that closes a file |
| G | BELL | 0x07 | bell |
| H | BS | 0x08 | back one character — today's backspace |
| I | HT | 0x09 | tab |
| J | LF | 0x0A | line feed |
| L | FF | 0x0C | form feed |
| Q, S | DC1, DC3 | 0x11, 0x13 | tape start and stop — XON/XOFF, greetings from the sixties |
| P | DLE | 0x10 | and with SHIFT it gives `@` |

Mechanical keys stand apart: RETURN, LINE FEED, ESC, RUBOUT (also known as DELETE), REPT (auto-repeat while held), BREAK and HERE IS. The last one is about remote work: an "acknowledged" the teletype printed on request — your system ACK, arriving early and staying for decades.

There are no arrows, no function keys, no Home or End. Backspace, in the modern sense, is CTRL+H. Full stop.

## Erasing blind: hash and at-sign

Your first reflex on a typo is to look for DELETE. In V5 it erases nothing. Neither does CTRL+H — today's backspace.

The erase characters are compiled into the terminal driver, and there are exactly two: `#` erases the last character, `@` erases the whole line. There is no `stty` — it arrives in later editions, and with it the words erase and kill, which came from exactly here. In 1974, configuring a terminal was not configuration; it was a decision the driver's author had already made.

Why hash and at-sign? Because they are printing characters that turned up rarely in the programs and data of the time. Rarely — that is, until they were needed as ordinary characters. And then the system stops: to print a literal `@` you would have to protect it from the driver, and there is no protection. The rest is predictable. Erasing moves to DEL (the RUBOUT key), then the settings move into `stty`. But that is no longer V5.

In practice, on the emulator's Model 33 keyboard, `#` is SHIFT+`3` and `@` is SHIFT+`P`. Both capitals, both four keystrokes there and back, because SHIFT is sticky: SHIFT, `3`, then tidy up after yourself.

On paper, erasing is not deletion — paper cannot delete. The driver replays it: you press `#`, the carriage returns to the erased character, strikes a space over it, returns again, and only then prints the hash itself. A mistake in the middle of a line leaves a characteristic scribble on the paper, and the rest of the line prints over the top. You learn to read it in about two sessions.

One warning for later: be more careful with `@` than with `#`. A hash costs you one character; the at-sign costs you the whole line. On a teletype that is twenty seconds of your life, and it does not come back.

## Ten characters a second

Speed deserves its own note, because it changes how you work rather than merely making things duller.

110 baud is ten characters a second. `ls -al /usr/sys/ken` prints for minutes, and the teletype hammers the whole time. Nothing accelerates while a line is printing: the hardware prints.

The emulator has a switch for this: `authentic` — as the real machine was — and `fast`, roughly three times quicker. The default is `authentic`, and it is one more engineering compromise in a project with a collection of them (otherwise you would never see BSD finish booting).

Why keep the slow one at all: slow output is not decoration, it is the most gripping part of the sensation. On fast output the emulator becomes an ordinary terminal, and the whole business about an engineer of the mid-seventies falls apart.

Paper width lives in the same place: 72 or 80 columns, and an ASR-33 physically has no more. The wide 100 and 132 belong to the LP11 printer, which has its own page. And 72 is not "just in case" — nearly all such machines were 72-column, with 80 as the upper limit.

One more thing you come to value at this speed: paper tape. While a line prints you can punch it onto tape, and that is the only backup of a session you have besides the paper itself. Tape can go in a box, or be replayed later through the reader — which is the one assistance an operator cannot do without.

## What actually gets loaded

Here is the part I started all of this for. How does the system know what console is in front of it?

It does not. That is not an evasion, it is the point.

There is nothing in the line to identify a terminal with: a 20 mA current loop, bytes one way and bytes the other. Nobody and nothing can ask your keyboard whether it has lower case. In 1974 knowledge of the console lived in the code — the driver and the bootstrap assumed an ASR-33 and got on with it. Fit a VT52 instead and you rebuilt the system; at the protocol level nothing whatsoever changed.

So there is no heuristic in the bootstrap? There is. Not about detecting hardware, but about the case of input. From my own [`macro-asm/boot.mac`](https://github.com/amesk/yaPDP/blob/master/macro-asm/boot.mac), before the command is parsed:

```asm
; convert lowercase - uppercase (ASCII decimal)
        cmpb    r0, #97.           ; 'a'
        blt     30$
        cmpb    r0, #122.          ; 'z'
        bgt     30$
        bicb    #40, r0            ; clear ASCII case bit
```

The input line is folded into upper case *before* it is compared with the command names. So `BOOT RK0` and `boot rk0` are the same command, and no second parse is needed. DEC's own bootstraps do exactly the same: `CMPB` over `'a'..'z'`, then `BIC #40`. The authors of the seventies had nowhere to ask the keyboard, so it was simpler to normalise the input and print capitals on the way out. A classic compromise nobody ever undid.

What grows out of that is visible in the scenario table. The old DEC systems carry their command in capitals — `BOOT RK1`, `BOOT PR` — while the four Unix-like guests keep the lower-case `boot rk0`, even though the case fold makes both work. The difference is not in the code: the wizard shows the historically honest set. On a teletype an operator physically could not type lower case, so in 1974 `boot rk0` and `unix` were a sequence of SHIFT presses, not "lower-case letters that arrived from a PC keyboard".

The emulator does not try to guess the console from the guest's behaviour. It *declares* it. Every image in the scenario table carries a profile: which console (`teletype`, `vt52` or `vt100`), whether the LP11 printer is fitted, whether the VT11 vector display is, and whether output case should be folded. For Unix V5 it looks like this:

```js
hardware: { console: "teletype", printer: null, vt11: false,
    forceUpperCaseOut: true }
```

Why not do it "more cleverly"? Because guessing here is guaranteed to produce lies: the guest believes it is printing lower case, and has no way to find out what came out on paper. I got caught by exactly that once — and characteristically, not on V5.

The exception in the whole table is 2.11 BSD. Its bootstrap prints lower case and ignores the ASR-33: the system does not care that the paper shows capitals where it sent lower case, but the person and the system will both end up believing they are seeing different things. So 2.11 BSD runs on a VT52 console in its scenario, which has both cases, and no output fold is applied. It is the only guest with that exception, and it is recorded honestly among the known limitations ([`docs/known-issues.md`](https://github.com/amesk/yaPDP/blob/master/docs/known-issues.md)). I am sometimes willing to fake authenticity; I am not willing to pretend a machine printed what it cannot print.

On V5 the fold changes nothing at all: the kernel and the bootstrap write capitals themselves, as they did in 1974. The flag is there for a complete profile, not because anything breaks without it.

What remains is the hardware, and one element of it that is not "in the code" at all — the BREAK key.

BREAK on a Model 33 is not a character. It physically breaks the current loop for longer than 150 ms, and the DL11 receiver sees that as a break: not a byte but a state of the line. In the emulator it is a bit in the console status register, an interrupt on vector 060, and a flush of the teletype's accumulated output ([`src/iopage.js`](https://github.com/amesk/yaPDP/blob/master/src/iopage.js)). I added the flush after understanding something simple: if the guest ignores the break bit, you see nothing at all — you press it and that is that. And output on this machine can run far away: `cat` of a large file at ten characters a second is minutes of unbroken clatter, and there is no other way to stop it. No signals in the familiar sense, no job control yet.

## Something to do in there

Everyone knows V5 is a museum piece. More interesting is that it is a working system with things to do in it.

The first thing I usually show is the disk. In `/usr/sys/ken` sit the kernel sources of the fifth edition: `alloc.c`, `clock.c`, `fio.c`, `iget.c`, `main.c`. Not "inspired by" — the files everything started from, readable inside the emulator, on the machine that executes them. It feels like looking behind the scenes of your own childhood, except the childhood belongs to the whole industry.

Then the compiler. `/bin` has `cc`, and it honestly compiles C of that vintage: no `struct` as we know it, argument declarations after the function header. The classic K&R C:

```c
main(argc, argv)
char **argv;
{
printf("Hello world\n");
}
```

Type it with `cat > hello.c`, end with CTRL+D, then `cc hello.c`, then `a.out` — and you get `Hello world`.

Fortran is in there too (`fc`), with a result I adore: the program computes pi, and the paper says `PI is approximately 0.3141592653580503d+01`. That is not an error, that is the print format — a leading zero and an exponent. Correct, and looking exactly like a typo.

And finally blackjack. It has been a figure of speech in this series from the first title, but in V5 it is literally the file `/usr/games/bj`. Alongside it in `/usr/games` are chess, tic-tac-toe, `wump`, `moo` and `cubic` — the set that terminal game culture grew out of.

:::spoiler What a real session looks like (the full log is in docs/ExampleBoots.md)

```
@unix

login: root
# cat /etc/passwd
root::0:1::/:
daemon::1:1::/bin:
bin::3:1::/bin:
# chdir /usr/sys/ken
# ls -al
total 121
drwxr-xr-x  2 bin       352 Nov 26 18:13 .
drwxr-xr-x  5 bin       384 Nov 26 18:13 ..
-rw-r--r--  1 bin      3855 Nov 26 18:13 alloc.c
-rw-r--r--  1 bin      2159 Nov 26 18:13 clock.c
-rw-r--r--  1 bin      2662 Nov 26 18:13 fio.c
-rw-r--r--  1 bin      2941 Nov 26 18:13 iget.c
-rw-r--r--  1 bin      2674 Nov 26 18:13 main.c
# cal 10 1981
Oct 1981
S  M Tu  W Th  F  S
1  2  3
4  5  6  7  8  9 10
11 12 13 14 15 16 17
25 26 27 28 29 30 31
# cat > hello.c
...
CTRL/D
# cc hello.c
# a.out
Hello world
```

The case in the log is as the guest emits it. On a real teletype it is all of the above in capitals — which is exactly what the section above was for.
:::

The other systems in the emulator — RT-11, RSTS, RSX, BSD, XXDP — can wait for another time. The project was started for the machine room, not for a catalogue of operating systems.

## What next

I have wanted for a while to stop admiring V5 and start breaking it. The most honest task I can see: build V5's own kernel on V5 itself — `as`, `cc` and the sources are all there — then boot the result in the emulator and compare it with what shipped.

The second line is tape. The punch works in the emulator, the reader works, LOCAL and LINE work; it would be good to design a scenario in which files move between V5 and a modern machine through paper, with no network at all. That is precisely the task people of 1974 regarded as ordinary work rather than a retro exercise.

For now — try it yourself. Open the emulator, wait for `@`, type `boot rk0`, then `unix`, then `root`. And once you are on the paper, make a deliberate mistake at least once, so you can watch the hash erase a character under the returning carriage. From that moment the system of 1974 stops being a picture.
