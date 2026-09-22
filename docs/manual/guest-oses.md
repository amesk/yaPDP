## Guest Operating Systems

The emulator ships with ready-to-boot disk and tape images. Just type `boot`
at the `@` prompt — or pick one with the magic wand.
In a build with a reduced image set (e.g. the **Minimal** desktop variant), rows whose
image is not shipped are dimmed and marked *image not in this build* — the table shows
exactly what can boot here.

| Disk | Operating System | How to Boot |
|---|---|---|
| RK0 | Unix V5 | boot rk0 → unix → login as root |
| RK1 | RT‑11 v4.0 | BOOT RK1 |
| RK2 | RSTS V06C‑03 | BOOT RK2 — login 11,70 password PDP |
| RK3 | XXDP (diagnostics) | BOOT RK3 |
| RK4 | RT‑11 3B Distribution | BOOT RK4 |
| TM0 | RSTS 4B‑17 (tape) | BOOT TM0 — follow ROLLIN restore procedure |
| RL0 | BSD 2.9 | boot rl0 → rl(0,0)rlunix → CTRL/D → login root |
| RL1 | RSX‑11M v3.2 | BOOT RL1 — login 1,2 password SYSTEM |
| RL2 | RSTS/E v7.0 | BOOT RL2 — login 11,70 password PDP |
| RL3 | XXDP (extended) | BOOT RL3 |
| RP0 | ULTRIX‑11 V3.1 | boot rp0 → CTRL/D → login root |
| RP1 | BSD 2.11 | boot rp1 — autoboots to multiuser, login root |
| RP2 | RSTS/E v9.6 | BOOT RP2 — answer prompts, login 11,70 |
| RP3 | RSX‑11M v4.6 | BOOT RP3 — auto-logs 1,2 SYSTEM |
| RP4 | RSTS/E v10.1 | BOOT RP4 — answer prompts, login 11,70 |
