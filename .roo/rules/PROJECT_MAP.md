# What this project is about

Goal: build a working web emulator of the PDP-11/70 with an authentic control panel, a Model 33 ASR teletype connected as the operator console, a couple of VT52 terminals and an LP11 line printer.

# Building the project

Remember: the main way to build/verify the project is to run npm scripts from the repository root
(`npm test`, `npm run stage`, `npm run desktop:full`, `npm run serve`, etc., see package.json).
Frontend staging and running `cargo tauri build` are performed by the Node scripts
tools/build-desktop.js and tools/tauri-build.js.
