## Гостевые операционные системы

Эмулятор поставляется с готовыми к загрузке образами дисков и лент. Просто наберите `boot` на приглашении `@` — или выберите нужный с помощью [волшебной палочки](#quick-start).

В сборке с урезанным набором образов (например, настольный вариант **Minimal**) строки, чей образ не поставляется, затемнены и помечены *image not in this build* — таблица показывает ровно то, что здесь можно загрузить.

| Disk | Operating System | Boot Command | What Happens | Credentials |
|---|---|---|---|---|
| RK0{.disk}  | Unix V5 | boot rk0 | unix → войти как root | root |
| RK1{.disk}  | RT-11 v4.0 | BOOT RK1 | загружается сразу в монитор RT-11 |  |
| RK2{.disk}  | RSTS V06C-03 | BOOT RK2 | мастер вводит START на приглашение Option: |  |
| RK3{.disk}  | XXDP (diagnostics) | BOOT RK3 | полевая диагностическая система DEC |  |
| RK4{.disk}  | RT-11 3B Distribution | BOOT RK4 | дистрибутив базовой версии RT-11 |  |
| TM0{.disk}  | RSTS 4B-17 (tape) | BOOT TM0 | следуйте процедуре восстановления ROLLIN |  |
| RL0{.disk}  | BSD 2.9 | boot rl0 | rl(0,0)rlunix → CTRL/D → логин root | root |
| RL1{.disk}  | RSX-11M v3.2 | BOOT RL1 | автостарт; введите дату по запросу |  |
| RL2{.disk}  | RSTS/E v7.0 | BOOT RL2 | мастер вводит START на приглашение Option: |  |
| RL3{.disk}  | XXDP (extended) | BOOT RL3 | расширенная библиотека тестов XXDP |  |
| RP0{.disk}  | ULTRIX-11 V3.1 | boot rp0 | загружается в однопользовательский режим (multi-user — известный баг эмулятора) |  |
| RP1{.disk}  | BSD 2.11 | boot rp1 | автозагрузка в многопользовательский режим, логин root (без пароля) | root (no password) |
| RP2{.disk}  | RSTS/E v9.6 | BOOT RP2 | загружается до запроса даты; далее 11,70 / PDP | 11,70 (PDP) |
| RP3{.disk}  | RSX-11M v4.6 | BOOT RP3 | автостарт; введите дату и время по запросу |  |
| RP4{.disk}  | RSTS/E v10.1 | BOOT RP4 | загружается до запроса даты; далее 11,70 / PDP | 11,70 (PDP) |
