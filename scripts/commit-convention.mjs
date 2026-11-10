// Conventional Commits check for a commit message or a pull request title.
// Pull requests are squash-merged with their title as the commit message, so CI checks the
// title; `.githooks/commit-msg` applies the same rule to local commits.
//
// Usage: node scripts/commit-convention.mjs "<message>"
//        node scripts/commit-convention.mjs --file <commit message file>
import { readFileSync } from "node:fs";

export const TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];
export const MAX_LENGTH = 100;
const HEADER = new RegExp(`^(?:${TYPES.join("|")})(?:\\([a-z0-9][a-z0-9._/-]*\\))?!?: (\\S.*)$`);

/** Problems with the first line of `message`; empty when it follows the convention. */
export function checkHeader(message) {
  const header = message.split("\n")[0].trimEnd();
  const problems = [];
  const match = HEADER.exec(header);
  if (!match) {
    problems.push(
      `"${header}" must look like "type(scope)!: subject", with type one of ${TYPES.join(", ")}; scope and ! are optional.`,
    );
  } else if (match[1].endsWith(".")) {
    problems.push("The subject must not end with a period.");
  }
  if (header.length > MAX_LENGTH)
    problems.push(`The header is ${header.length} characters, at most ${MAX_LENGTH}.`);
  return problems;
}

/** Messages git writes itself, not subject to the convention. */
const isGitGenerated = (message) => /^(Merge |Revert "|fixup! |squash! |amend! )/.test(message);

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const raw = args[0] === "--file" ? readFileSync(args[1], "utf8") : args.join(" ");
  // Comment lines are dropped by git before committing.
  const message = raw
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
  const problems = isGitGenerated(message) ? [] : checkHeader(message);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error('See CONTRIBUTING.md, "Commit messages" (https://www.conventionalcommits.org).');
    process.exit(1);
  }
}
