// Fails if any runtime (production) dependency has a licence outside the allow-list.
// docs/TESTING_STRATEGY.md §1; the list of dependencies is documented in docs/DEPENDENCIES.md.
import { execFileSync } from "node:child_process";

const ALLOWED = new Set([
  "MIT",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "CC0-1.0",
  "GPL-3.0",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
]);

// Under `npm run`, npm_execpath points at npm's CLI script, which runs without a shell on every OS.
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error("Run this through npm: npm run licenses");
  process.exit(2);
}
const output = execFileSync(process.execPath, [npmCli, "query", ".prod"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

const packages = JSON.parse(output).filter((pkg) => pkg.location); // the root project has no location
const licenceOf = (pkg) => (typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "UNKNOWN");
// SPDX "A OR B" expressions are allowed if any alternative is allowed.
const allowed = (licence) => licence.replace(/[()]/g, "").split(/\s+OR\s+/).some((part) => ALLOWED.has(part.trim()));

const rejected = packages.filter((pkg) => !allowed(licenceOf(pkg)));
for (const pkg of packages) console.log(`${allowed(licenceOf(pkg)) ? "ok  " : "FAIL"} ${pkg.name}@${pkg.version} ${licenceOf(pkg)}`);

if (rejected.length > 0) {
  console.error(`\n${rejected.length} runtime dependenc${rejected.length === 1 ? "y has" : "ies have"} a licence that is not on the allow-list.`);
  process.exit(1);
}
console.log(`\nAll ${packages.length} runtime dependencies have allowed licences.`);
