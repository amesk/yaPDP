## Гостевые операционные системы

<!-- translated: needs review -->
Эмулятор поставляется с готовыми к загрузке образами дисков и лент. Просто наберите `boot` на приглашении `@` — или выберите нужный волшебной палочкой.

<!-- translated: needs review -->
В сборке с урезанным набором образов (например, настольный вариант **Minimal**) строки, чей образ не поставляется, затемнены и помечены *image not in this build* — таблица показывает ровно то, что здесь можно загрузить.

| Disk | Operating System | Boot Command | What Happens | Credentials |
|---|---|---|---|---|
| RK0 | Unix V5 | boot rk0 | unix → войти как root | root |
| RK1 | RT-11 v4.0 | BOOT RK1 | загружается сразу в монитор RT-11 |  |
| RK2 | RSTS V06C-03 | BOOT RK2 | мастер вводит START на приглашение Option: |  |
| RK3 | XXDP (diagnostics) | BOOT RK3 | полевая диагностическая система DEC |  |
| RK4 | RT-11 3B Distribution | BOOT RK4 | дистрибутив базовой версии RT-11 |  |
| TM0 | RSTS 4B-17 (tape) | BOOT TM0 | следуйте процедуре восстановления ROLLIN |  |
| RL0 | BSD 2.9 | boot rl0 | rl(0,0)rlunix → CTRL/D → логин root | root |
| RL1 | RSX-11M v3.2 | BOOT RL1 | автостарт; введите дату по запросу |  |
| RL2 | RSTS/E v7.0 | BOOT RL2 | мастер вводит START на приглашение Option: |  |
| RL3 | XXDP (extended) | BOOT RL3 | расширенная библиотека тестов XXDP |  |
| RP0 | ULTRIX-11 V3.1 | boot rp0 | загружается в однопользовательский режим (multi-user — известный баг эмулятора) |  |
| RP1 | BSD 2.11 | boot rp1 | автозагрузка в многопользовательский режим, логин root (без пароля) | root (no password) |
| RP2 | RSTS/E v9.6 | BOOT RP2 | загружается до запроса даты; далее 11,70 / PDP | 11,70 (PDP) |
| RP3 | RSX-11M v4.6 | BOOT RP3 | автостарт; введите дату и время по запросу |  |
| RP4 | RSTS/E v10.1 | BOOT RP4 | загружается до запроса даты; далее 11,70 / PDP | 11,70 (PDP) |
