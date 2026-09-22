## Guest Operating Systems

The emulator ships with ready-to-boot disk and tape images. Just type `boot`
at the `@` prompt — or pick one with the magic wand.
In a build with a reduced image set (e.g. the **Minimal** desktop variant), rows whose
image is not shipped are dimmed and marked *image not in this build* — the table shows
exactly what can boot here.

| Disk | Operating System | Boot Command | What Happens | Credentials |
|---|---|---|---|---|
| RK0 | Unix V5 | boot rk0 | unix → login as root | root |
| RK1 | RT-11 v4.0 | boot rk1 | boots immediately to monitor prompt |  |
| RK2 | RSTS V06C-03 | boot rk2 | wizard answers START at the Option: prompt |  |
| RK3 | XXDP (diagnostics) | boot rk3 | DEC field diagnostic operating system |  |
| RK4 | RT-11 3B Distribution | boot rk4 | RT-11 distribution baseline |  |
| TM0 | RSTS 4B-17 (tape) | boot tm0 | follow ROLLIN restore procedure |  |
| RL0 | BSD 2.9 | boot rl0 | rl(0,0)rlunix → CTRL/D → login root | root |
| RL1 | RSX-11M v3.2 | boot rl1 | autostarts; enter the date when asked |  |
| RL2 | RSTS/E v7.0 | boot rl2 | wizard answers START at the Option: prompt |  |
| RL3 | XXDP (extended) | boot rl3 | extended diagnostics library |  |
| RP0 | ULTRIX-11 V3.1 | boot rp0 | boots to a single-user shell (multi-user is a known emulator bug) |  |
| RP1 | BSD 2.11 | boot rp1 | autoboots to multiuser, login root (no password) | root (no password) |
| RP2 | RSTS/E v9.6 | boot rp2 | boots to the date prompt; then 11,70 / PDP | 11,70 (PDP) |
| RP3 | RSX-11M v4.6 | boot rp3 | autostarts; enter date/time when asked |  |
| RP4 | RSTS/E v10.1 | boot rp4 | boots to the date prompt; then 11,70 / PDP | 11,70 (PDP) |
