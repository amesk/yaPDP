# Known Issues / Открытые задачи

Открытые баги эмуляции и долгие задачи, которые не вписываются в один
коммит. Каждая запись: симптом, как воспроизвести, что уже выяснено.

---

## ULTRIX-11 (rp0): `panic: trap` при переходе из single-user в multi-user

**Статус:** открыто (не регрессия — воспроизводится и в v0.1.0-alpha2).

**Симптом.** ULTRIX-11 V3.1 грузится до single-user (`#`), но Ctrl-D
(переход в multi-user) роняет ядро:

```
# ^D
Restricted rights: ...
Mounted /dev/hp01 on /usr
Mounted /dev/hp04 on /user1
Sat Oct 31 09:11:15 PDT 1981
ERROR LOG has - 2 of 200 blocks used
ka6 = 7574
aps = 142602
pc = 136250 ps = 30011
ovno = 1
trap type 0
panic: trap
```

**Воспроизведение.**
1. `node tools/serve.js` (порт 1170), открыть `pdp11.html?bridge=1`.
2. Boot → `boot rp0` → дождаться single-user `#`.
3. Отправить Ctrl-D (`dlReceiveQueue(0, [4])`).

Либо e2e-сценарий: `node /tmp/ctrld-probe.js rp0` (скрипт-прототип).

**Что выяснено.**
- В v0.1.0-alpha2 паника идентичная (тот же `pc=136250`, `trap type 0`) —
  баг в общей части эмулятора (pdp11.js / MMU / user-mode), не в
  iopage-устройствах и не в рефакторинге.
- Ядро успевает смонтировать /usr и /user1 и записать error log — падает
  при возврате в user mode / старте init.
- Тот же «класс» проблем (multi-user / user-mode) наблюдался у BSD 2.9
  (ввод после `login:`), но там причина оказалась в госте (getty
  TIOCFLUSH) — здесь, судя по `panic: trap`, баг именно эмулятора.

**Кандидаты для поиска.**
- MMU-трансляция в user mode (PAR/PDR user-наборов) при переключении
  kernel→user.
- Обработка прерываний/trap в user mode (PSW-биты mode, стеки).
- Возможно, связано с `mapVirtualToPhysical` / `CPU.mmuMode` при
  смене контекста процесса.

**Инструменты:** `window.__tracePC` (окна трассировки инструкций),
`DEBUG_MMU`/`DEBUG_TRAP` (headless), дампы `CPU.mmuPAR/PDR`.

---

## (История) BSD 2.9 (rl0): ввод после `login:` «терялся»

**Статус:** решено — не баг эмуляции.

Getty BSD 2.9 сбрасывает входной буфер (TIOCFLUSH) при старте: логин,
набранный мгновенно после `login:`, теряется. Решение — пауза в
сценарии wizard: `{ send: "root", waitFor: "login:", wait: 3000 }`
(quickboot поддерживает `wait` с коммита 7dd3aa2).
