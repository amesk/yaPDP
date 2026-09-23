## Guest Operating Systems

The emulator ships with ready-to-boot disk and tape images. Just type `boot <device>` at the `@` prompt
at the `@` prompt — or pick one with the [magic wand](#quick-start).
In a build with a reduced image set (e.g. the **Minimal** desktop variant), rows whose
image is not shipped are dimmed and marked *image not in this build* — the table shows
exactly what can boot here.

| Disk | Operating System | Boot Command | What Happens | Credentials |
|---|---|---|---|---|
| RK0{.disk}  | Unix V5 | `boot rk0` | `unix` → login as root | root |
| RK1{.disk}  | RT-11 v4.0 | `BOOT RK1` | boots immediately to monitor prompt |  |
| RK2{.disk}  | RSTS V06C-03 | `BOOT RK2` | wizard answers START at the Option: prompt |  |
| RK3{.disk}  | XXDP (diagnostics) | `BOOT RK3` | DEC field diagnostic operating system |  |
| RK4{.disk}  | RT-11 3B Distribution | `BOOT RK4` | RT-11 distribution baseline |  |
| TM0{.disk}  | RSTS 4B-17 (tape) | `BOOT TM0` | follow ROLLIN restore procedure |  |
| RL0{.disk}  | BSD 2.9 | `boot rl0` | `rl(0,0)rlunix` → CTRL/D → login `root` | root |
| RL1{.disk}  | RSX-11M v3.2 | `BOOT RL1` | login `1,2` password `SYSTEM` |  |
| RL2{.disk}  | RSTS/E v7.0 | `BOOT RL2` | wizard answers START at the Option: prompt |  |
| RL3{.disk}  | XXDP (extended) | `BOOT RL3` | extended diagnostics library |  |
| RP0{.disk}  | ULTRIX-11 V3.1 | `boot rp0` | boots to a single-user shell (multi-user is a known emulator bug) |  |
| RP1{.disk}  | BSD 2.11 | `boot rp1` | autoboots to multiuser, login root (no password) | root (no password) |
| RP2{.disk}  | RSTS/E v9.6 | `BOOT RP2` | boots to the date prompt; then `11,70` / PDP | 11,70 (PDP) |
| RP3{.disk}  | RSX-11M v4.6 | `BOOT RP3` | auto-logs `1,2` `SYSTEM` |  |
| RP4{.disk}  | RSTS/E v10.1 | `BOOT RP4` | boots to the date prompt; then 11,70 / `PDP` | 11,70 (PDP) |
