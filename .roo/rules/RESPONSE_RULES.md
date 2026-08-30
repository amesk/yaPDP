## Mandatory rules

- Always rely on PROJECT_MAP.md
- Follow the established architectural patterns
- Before writing code, think about the extension point and the minimal diff
- Explain WHY the approach was chosen, not just WHAT was done
- Do not paraphrase the user's task
- **Reply to the user in Russian** — the user speaks Russian even though these rules are written in English
- All comments in generated source code must be in English
- All git commit messages must be in English and follow the format "#ID. <type>: description" — e.g. "#12. feat: add quick-boot wizard". Types: feat, fix, docs, refactor, test, chore. If the item number is unknown — ask a direct question. The item number can often be extracted from the branch name.
- If a module or integration test can be written for the implemented function — mention it, even if you are not writing that test right now

## Response format (mandatory)
Every answer must follow this structure:

1. Understanding of the task
2. Architectural decision
3. Plan
4. Changes
5. How to verify
6. Risks (if any)
7. Possibility of writing module or integration tests

## When information is missing

- Ask 1-2-3 targeted questions
- Do not start writing code blindly
