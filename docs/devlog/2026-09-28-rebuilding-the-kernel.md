---
title: "Rebuilding a 1981 kernel from the inside: 2.11 BSD without the network"
date: 2026-09-28
lang: en
summary: "The shipped BSD 2.11 image boots a kernel that was built for a machine with an Ethernet card, a SLIP line and a hostname that no longer exists. Here is how that kernel gets rebuilt inside the emulator itself — in headless mode, with no screen, and with only 64K of code and 64K of data to build it in."
draft: "true"
---

The BSD 2.11 image in `media/` boots with a kernel that announces itself like this:

```
2.11 BSD UNIX #19: Sat Oct 31 18:46:38 CST 1981
    root@vixen.skn.noip.me:/usr/src/sys/VIXEN

attaching sl
attaching lo0

phys mem  = 3915776
avail mem = 3490368
user mem  = 307200
```

It was built in 1981 for a machine called *vixen*, and it came with the network it was built for: a serial line interface, a loopback, and a TCP/IP stack compiled in. The emulator has no network card, so the boot then tries to configure one and fails in the most honest way possible:

```
Assuming NETWORKING system ...
ifconfig: ioctl (SIOCGIFFLAGS): no such interface
vixen.skn.noip.me: bad value
add net default: gateway 127.0.0.1
starting system logger
starting network daemons: inetd rwhod printer.
```

Three daemons start for a network that cannot exist, a system logger starts for them to log into, and the machine carries around a pile of kernel code, buffers and data structures for hardware that is not there. Every byte of that costs, on a machine where `avail mem` is measured in millions and printed with pride.

So: rebuild the kernel without the network, and give it a name of our own. The interesting part is *how* — because doing it the obvious way runs straight into the wall every PDP-11 programmer knew by heart.

## 64K of code, 64K of data

A PDP-11/70 has megabytes of memory, but a single process can address exactly 64K of instructions and 64K of data. That is not an emulator shortcut: the memory management unit has eight pages of 8K per space, and the instruction and data spaces are selected by one bit of the virtual address. The emulator models it faithfully — page number from the virtual address and the current mode, physical address from the page register — see [`src/pdp11.js`](https://github.com/amesk/yaPDP/blob/master/src/pdp11.js).

Everything the kernel build does is shaped by that ceiling. Try to compile the kernel naively and a tool runs out of memory, because that is what happens when a compiler's symbol table alone needs more than 64K. The 2.11 BSD build does not fight the limit; it steps around it, in three moves that are visible in the make output:

```
cc -O -DKERNEL -DYAPDP -I. -I../h -S ../machine/trap.c
/bin/sed -f SPLFIX trap.s | /bin/as -V -u -o trap.o
rm -f trap.s
```

- **The compiler is split.** `cc -S` only produces assembler; a separate `as` assembles it. Two small processes instead of one large one.
- **The assembler spills its symbol table.** `as -V` writes the symbols to a temporary file instead of holding them in data space. `AS="/bin/as -V"` is in the generated makefile, not something I added.
- **The kernel is linked in overlays.** The link stage reports them afterwards: `overlays: 7680,7360,7680,…` — the resident part fits, the rest is paged over it.

`SPLFIX` is the third move: a `sed` script that rewrites the `spl` sequences of that particular kernel into the instructions the target machine actually has.

The whole build is a long, patient sequence of small processes, and it is the same sequence today as in 1981. What is different is that the machine running it is an emulator in a browser project, driven from a terminal in a text file.

## The config is a knob file

Coming from 4.3BSD's `config` — where you delete `device` lines and `options` — the 2.11 config is surprisingly friendly: it is a list of numbered knobs and `YES`/`NO` flags, and the network is exactly three of them.

```
IDENT           VIXEN           # machine name
INET            YES             # TCP/IP
NETHER          1               # ether pseudo-device
NSL             1               # Serial Line IP
```

Turning the network off is a `sed` one-liner, and the copy becomes the new configuration file:

```
cd /usr/src/sys/conf
sed -e '/^IDENT/s/VIXEN/YAPDP/' \
    -e '/^INET/s/YES/NO/' \
    -e '/^NETHER/s/1/0/' \
    -e '/^NSL/s/1/0/' VIXEN > YAPDP
./config YAPDP
```

```
Creating ../YAPDP.
Copying standard files to ../YAPDP.
Setting configuration options for YAPDP.
Creating device header files.
```

`config` builds the directory `/usr/src/sys/YAPDP` and writes a makefile into it. Then one `make` and one `make install`, and the machine has a new kernel.

There is a quiet confirmation buried in the make output. The makefile chain for this build is:

```
make -f Make.sys …
make -f Make.pdp …
make -f Make.pdpuba …
make -f Make.pdpmba …
```

`Make.net` — the networking variant, with `-DINET` and the `net`, `netinet`, `netimp`, `netns` directories in its `SUB` list — is not in that chain at all. The network is not disabled at runtime somewhere; the code was never compiled.

## The name gets baked in twice

Two things name a 2.11 BSD kernel, and both are decided *at build time*.

The configuration file's name becomes the `-D` define and the build directory. That gives the banner its `/usr/src/sys/YAPDP` tail.

The other one is the hostname: the version block is generated by `newvers.sh`, which takes `pwd`, the user, the date — and `hostname`. So before `make`:

```
hostname yapdp.local
```

and the banner follows:

```
2.11 BSD UNIX #1: Fri Jun 9 00:01:15 CDT 1995
    root@yapdp.local:/usr/src/sys/YAPDP
```

The `#1` is the fresh build's own counter: the new build directory starts its `version` file over. The running system's hostname is a third thing — the one the console prints at login — and in 2.11 BSD it comes from `/etc/netstart`, which held the old name on line 26. It is one more `sed` away, and the shutdown message proves it took:

```
*** FINAL System shutdown message from root@yapdp.local ***
```

## Driving it without a screen

The build runs headless, through [`tools/headless-term.js`](https://github.com/amesk/yaPDP/blob/master/tools/headless-term.js): the guest's console is piped to a batch script, and every line waits for the shell prompt before the next one is sent. There is no emulator window anywhere in this story — which is exactly the point, because a 40-minute kernel build is not something to babysit in a browser tab.

There was one thing missing, and it is the kind of thing you only discover by doing the work: **the guest's disk writes never reach the file on the host.** They land in the write-back overlay that `bootHeadless` keeps in memory, ready to be handed back as `imageBytes` — and then thrown away when the process exits. My first complete kernel build, forty minutes of `cc` and `as`, evaporated at the prompt. The `:export` command in the tool exports *paper tape*, not disks.

So the tool grew a `:save-disk` command. Its first version was wrong in a way worth keeping in the article: it wrote the image happily, and the image was byte-for-byte the pristine one, because the disk controller hands guest writes to the `DiskService` cache and only a flush pushes them to the provider that patches the image. The regression test caught it — the test asserts that the saved image *differs* from the pristine one, not merely that saving works. Now the command flushes first, and says so:

```
headless-term: flushed 1 drive(s): rp1.dsk
headless-term: saved 174423040 bytes to .tmp-yapdp.dsk
```

A second, smaller lesson came with it. The batch loop waits for a prompt after every line. `shutdown -h now` halts the machine, and a halted machine never prints a prompt — so the tool sat there for the full prompt timeout, an hour, before it got to the save. For anyone scripting a build: ask for a prompt only from a machine that still has one.

## The result

```
                        before                              after
kernel                  /unix  153723 bytes                 /unix  144782 bytes
banner                  2.11 BSD UNIX #19 (1981-10-31)      2.11 BSD UNIX #1 (1995-06-09)
built by                root@vixen.skn.noip.me:/…/VIXEN      root@yapdp.local:/…/YAPDP
console banner          2.11 BSD UNIX (vixen.skn.noip.me)    2.11 BSD UNIX (yapdp.local)
attaching sl / lo0      both present                        gone
memory                  avail mem = 3490368                   avail mem = 3612096
boot to login           ~160 s (the tool's own note)          ~80 s (tests/e2e-bsd-boot.js)
rc                      Assuming NETWORKING system           Assuming non-networking system
rc                      starting network daemons: inetd …     starting lpd
TERM                    vt52 (from the image)                 vt100 (from /etc/ttys)
stty erase              DEL (^?)                              ^H
```

The kernel is 8941 bytes smaller — 5.8% — and the free memory figure grew by 121728 bytes, because the network's buffers and data structures are not merely unused, they were never allocated. The daemons are gone from `ps`:

```
root         0   0   8 ?   0:00 [swapper]        root         0   0   8 ?   0:00 [swapper]
root         1   0  31 ?   0:01  (init)           root         1   0  31 ?   0:01  (init)
root        52   0  11 ?   0:00 update            root        44   0  11 ?   0:00 update
root        55   0  51 ?   0:00 cron              root        47   0  51 ?   0:00 cron
root        59  -1  23 ?   0:00 acctd             root        51  -1  23 ?   0:00 acctd
root        67   0  39 ?   0:01 /usr/sbin/inetd   root        57   0  47 ?   0:00 /usr/sbin/lpd
root        71   0  27 ?   0:00 rwhod             root        62   0  32 ?   0:00 … (getty)
root        75   0  47 ?   0:00 /usr/sbin/lpd     root        63   0  32 ?   0:00 … (getty)
root        42   0  58 co  0:01 syslogd           root        61   0  19 co  0:01 -sh
```

And `/.profile` — the file I came for — now does what a console operator needs instead of inheriting the image's assumptions. The original is kept beside it as `/.profile.orig`:

```sh
echo 'erase, kill ^U, intr ^C'
stty erase "^H"
PATH=/bin:/sbin:/usr/sbin:/etc:/usr/ucb:/usr/bin:/usr/new:/usr/games
export PATH
HOME=/
export HOME
```

Two of the lines I first put here turned out not to belong in a profile at all. `TERM` is not a user's business: a 2.11 BSD system takes the terminal type from the field in `/etc/ttys`, which is what `getty` passes to `login`, and on this image that field still said `vt52`. Setting it in `/.profile` "works" only for a login, only for root, and only after getty has already decided; the system-level place is the file that describes the terminal. So `/etc/ttys` now names `vt100` for the console and the two serial lines:

```
sed -e '/^console/s/vt52/vt100/' \
    -e '/^ttyl1/s/vt52/vt100/' \
    -e '/^ttyl2/s/vt52/vt100/' /etc/ttys > /tmp/ttys.new
cp /tmp/ttys.new /etc/ttys
```

`TERM` is not decoration. A VT100 is what the emulator's console is, and a full-screen program that scrolls chooses *how* it scrolls from that variable: `vi` looks up the `sf` and `sr` capabilities of the termcap entry named by `TERM`, and the 2.11 BSD `vt100` entry scrolls with the IND and RI sequences a DECscope two generations older had no answer for. Leave the type at `vt52` and `vi` spends its life redrawing the bottom line by cursor addressing, one line at a time.

## What the exercise is really about

None of this is special to yaPDP. Every step — `config`, `make`, `make install`, `/.profile` — is what the machine's own documentation told a 1981 operator to do, run through the machine's own toolchain, and the emulator is not a party to it: it supplies a CPU, a disk and a console, and stays out of the way.

That is the part worth keeping. The interesting question is not whether the emulator can boot a guest OS; it is whether the guest can *work* in it — rebuild itself, be reconfigured, be renamed — with no cooperation from the emulator beyond an accurate 64K wall and a console that behaves like a console. The wall is still the wall: the build's answer to it (`as -V`, split passes, overlays) is older than most of the code in this project, and it still fits.

The rebuilt image boots, runs, and is ready to become the default BSD 2.11 the project ships — a machine with no network to configure, no hostname from 1981, and a console profile that matches the terminal in the room.
