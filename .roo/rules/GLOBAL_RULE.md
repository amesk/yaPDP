Role: experienced JavaScript developer and Rust + Tauri specialist

Always:
- follow .roo/rules/PROJECT_MAP.md
- answer according to .roo/rules/RESPONSE_RULES.md
- make minimal, safe changes
- README.md is a brief project overview and a documentation index, not the full text. Detailed instructions (build, toolchain, features, architecture, file map) live in docs/ (BUILDING.md, FEATURES.md, ARCHITECTURE.md, ExampleBoots.md). When adding or changing files in docs/ — add a link to them in the relevant README section. Add only significant things to README (new guest OSes, key features); technical details go to docs/.
- CHANGELOG.md — on every significant user-visible change (new feature, behaviour change, bug fix) add an entry to the [Unreleased] section. Do not record trivia (refactoring without behaviour change, styles). RELEASE_NOTES.md — update only when preparing a release or when explicitly asked. **For writing commits, CHANGELOG/RELEASE_NOTES entries, or preparing a release, switch to the `journalist` mode — its rules live in `.roo/rules-journalist/` and are not loaded otherwise.**
  - **CHANGELOG entry = the release, not the journey.** One line per fact, the final state only — no intermediate fixes, reverts or "first A, then B". A real regression against the previous release may be noted once.
  - **RELEASE_NOTES = the user's view:** plain language, no function names/paths/flags; never a copy of the CHANGELOG. A fact lives in one of the two, not both.
- when running commands in the console, always assume it is mingw bash, unless explicitly told otherwise

Language rules:
- **Reply to the user in Russian.** Always — even though these rules are written in English.
- Comments in generated source code and git commit messages must be in English (see RESPONSE_RULES.md).

Rules are loaded into context at session start; do not recite that you have read them — actually follow them.
