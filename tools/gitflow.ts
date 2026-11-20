#!/usr/bin/env bun
/**
 * gitflow — the governed branch-lifecycle tool for the Primebrick workspace.
 *
 * Raw `git merge`/`git branch -d` for feature/release/hotfix branches is
 * FORBIDDEN: closing goes only through `finish`, which always:
 *   merges --no-ff into the base → pushes the base → deletes the branch
 *   locally AND on origin → audits the final state.
 *
 * NOTE on `git flow` binaries (verified empirically 2026-11-20):
 * upstream nvie 0.4.2 fast-forwards linear feature merges; the AVH
 * edition 1.12.3 (installed in ~/bin) defaults to --no-ff except for
 * single-commit features — fixed via repo config
 * `gitflow.feature.finish.no-ff=true`. `git flow` stays usable for
 * start/publish/track helpers, but closing is NEVER delegated to it:
 * native finish neither pushes the base, nor deletes the remote branch,
 * nor audits the end state — the governed close lives here.
 *
 * Invariants (enforced by `audit`, exit 1 on violation):
 *   - at most ONE open branch across feature/*, release/*, hotfix/*
 *     (zero is clean — /develop + /main only)
 *   - an open feature/release/hotfix fully merged into its base is an
 *     ORPHAN — it should have been closed; reported, never silently fixed
 *   - remote carries at most main + develop + the one open branch
 *   - local branch must not be ahead of origin (commit ⇒ push — a commit
 *     that never reaches origin serves no one)
 *
 * Usage:
 *   bun tools/gitflow.ts audit
 *   bun tools/gitflow.ts finish            # closes the open feature/release/hotfix
 */

import { spawnSync } from "node:child_process";

const git = (args: string[]): { code: number; out: string } => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

const die = (msg: string): never => {
  console.error(`gitflow: ${msg}`);
  process.exit(1);
};

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const current = () => lines(git(["branch", "--show-current"]).out)[0] ?? "";
const localBranches = () =>
  lines(git(["branch", "--format=%(refname:short)"]).out).filter((b) => !b.startsWith("*"));
const remoteBranches = () =>
  lines(git(["branch", "-r", "--format=%(refname:short)"]).out)
    .map((b) => b.replace(/^origin\//, ""))
    .filter((b) => b !== "HEAD" && b !== "HEAD -> main" && !b.startsWith("HEAD"));
const aheadOf = (base: string, branch: string) =>
  Number(lines(git(["rev-list", "--count", `${base}..${branch}`]).out)[0] ?? "0");
const exists = (ref: string) => git(["rev-parse", "--verify", "--quiet", ref]).code === 0;

const WIP = /^((?:feature|release|hotfix)\/.+)$/;
const BASE: Record<string, string> = { feature: "develop", release: "main", hotfix: "main" };

function audit(): number {
  const cur = current();
  const locals = localBranches();
  const remotes = remoteBranches();
  const open = locals.filter((b) => WIP.test(b));
  let bad = 0;

  console.log(`gitflow audit — ${process.cwd().replace(/\\/g, "/").split("/").pop()}`);
  console.log(`  current: ${cur || "(detached)"}`);
  console.log(`  local:   ${locals.join(", ") || "-"}`);
  console.log(`  remote:  ${remotes.join(", ") || "-"}`);

  if (open.length > 1) {
    bad++;
    console.log(`  ✗ ${open.length} open work branches (${open.join(", ")}) — at most ONE of feature/release/hotfix may be open`);
  }
  for (const b of open) {
    const kind = b.split("/")[0];
    // ORPHAN = landed-but-never-closed: every commit is in the base AND the
    // tip is a strict ancestor (a finished base always grows a merge commit
    // past it). A branch sitting AT the base tip is fresh work, not an orphan.
    const sameTip = exists(BASE[kind])
      ? git(["rev-parse", b]).out.trim() === git(["rev-parse", BASE[kind]]).out.trim()
      : false;
    if (exists(BASE[kind]) && !sameTip && aheadOf(BASE[kind], b) === 0) {
      bad++;
      console.log(`  ✗ ORPHAN: ${b} is fully merged into ${BASE[kind]} — it should have been closed via gitflow finish. STOP and report.`);
    }
  }
  const remoteOpen = remotes.filter((b) => WIP.test(b));
  if (remoteOpen.length > 1 || (remoteOpen.length === 1 && !open.includes(remoteOpen[0]))) {
    bad++;
    console.log(`  ✗ remote work branches: ${remoteOpen.join(", ") || "—"} — remote must carry only main/develop (+ the one open branch)`);
  }
  for (const b of ["main", "develop", ...open]) {
    if (!exists(b)) continue;
    const [behind, ahead] = (git(["rev-list", "--left-right", "--count", `origin/${b}...${b}`]).out.trim() || "0\t0").split(/\s+/).map(Number);
    if (ahead > 0) console.log(`  ! ${b} is ${ahead} commit(s) AHEAD of origin — push required (commit ⇒ push)`);
    if (behind > 0) console.log(`  ! ${b} is ${behind} commit(s) behind origin — sync needed`);
  }
  if (git(["status", "--porcelain"]).out.trim()) console.log("  ! uncommitted changes present");
  if (bad === 0) console.log("  ✓ clean — develop + main (+ at most one open work branch)");
  return bad ? 1 : 0;
}

function finish(name?: string): number {
  const open = localBranches().filter((b) => WIP.test(b));
  if (open.length === 0) die("no open feature/release/hotfix branch — nothing to finish");
  const br = name
    ? open.find((b) => b === name || b === `feature/${name}` || b === `release/${name}` || b === `hotfix/${name}`)
    : open.length === 1
      ? open[0]
      : undefined;
  if (!br) die(`ambiguous: open branches are ${open.join(", ")} — pass the name explicitly`);
  const kind = br.split("/")[0];
  const base = BASE[kind];
  const cur = current();

  if (cur !== base && git(["checkout", base]).code !== 0) die(`cannot checkout ${base}`);
  if (git(["status", "--porcelain"]).out.trim()) die("uncommitted changes — commit or stash first");

  // --no-ff merge; conflicts abort the close and surface to the user
  const m = git(["merge", "--no-ff", br, "-m", `Merge branch '${br}'`]);
  if (m.code !== 0) {
    git(["merge", "--abort"]);
    die(`merge of ${br} into ${base} conflicts — resolve manually, closing aborted:\n${m.out.trim().slice(0, 400)}`);
  }

  // release/hotfix also tag main and back-merge into develop
  if (kind !== "feature") {
    const version = br.split("/")[1];
    if (!version) die(`${br}: cannot derive tag from branch name`);
    if (git(["tag", version]).code !== 0) die(`tag ${version} failed`);
    if (git(["push", "origin", base, "--tags"]).code !== 0) die("push main --tags failed");
    if (git(["checkout", "develop"]).code !== 0) die("checkout develop for back-merge failed");
    if (git(["merge", "--no-ff", "main", "-m", `Merge branch 'main' into develop`]).code !== 0)
      die("back-merge main→develop conflicts — resolve manually");
  }
  // feature: push develop (main untouched). release/hotfix: main already
  // pushed with --tags; push develop carrying the back-merge.
  if (git(["push", "origin", "develop"]).code !== 0) die("push develop failed");

  // branch disappears — local AND remote (never leave closed pointers)
  const d = git(["branch", "-d", br]);
  if (d.code !== 0) git(["branch", "-D", br]);
  if (remoteBranches().includes(br)) git(["push", "origin", "--delete", br]);

  console.log(`gitflow: closed ${br} → merged into ${base}, pushed, deleted local+remote`);
  return audit();
}

const cmd = process.argv[2];
if (cmd === "audit") process.exit(audit());
if (cmd === "finish") process.exit(finish(process.argv[3]));
die("usage: gitflow audit | gitflow finish [branch]");
