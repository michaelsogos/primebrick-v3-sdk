#!/usr/bin/env bun
/**
 * check-stringify.ts — typed display-coercion gate (the semantic half of the
 * eslint `no-base-to-string` rule we dropped from the dev gate: type-aware
 * lint made `eslint .` a 45min+ run, so the syntactic approximation moved to
 * check-standards `display-coerce` and THIS pass owns the precise check).
 *
 * One `ts.Program` — the same construction `pnpm check` already pays — then
 * a single AST walk. Flags, inside the scanned scope:
 *   - `String(expr)` where expr is not provably string-safe
 *   - `${expr}` substitutions where expr is not provably string-safe
 * "string-safe" = string/number/boolean/bigint/symbol/enum-literal/
 * undefined/null unions thereof, OR an object type that declares its own
 * `toString`/`valueOf` (URL, Date, Error, user classes — the eslint
 * `no-base-to-string` semantics: only default-Object stringification is a
 * violation). `any`/`unknown`/plain records flag: wire values decoded by
 * extJsonParse are plain objects — `String(obj)` silently yields
 * "[object Object]" and `String(null)` yields "null" — silent display
 * corruption, not a crash. Display coercion goes through `toDisplayString`
 * (@primebrick/ui) — see docs/ai/display-coercion.md.
 *
 * Usage:
 *   bun tools/check-stringify.ts <srcDir> [--scope=lib,routes] [--baseline]
 *
 * Exit 1 on any violation. `--baseline` writes .devin/check-stringify-baseline.json
 * (declared debt — never mint new debt silently; it is only for migration).
 */
import ts from "typescript";
import { readdirSync, statSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const srcDir = args.find((a) => !a.startsWith("--"));
const scopeArg = args.find((a) => a.startsWith("--scope="))?.split("=")[1];
const scopes = scopeArg ? scopeArg.split(",") : null;
const writeBaseline = args.includes("--baseline");
const BASELINE = resolve(".devin/check-stringify-baseline.json");

if (!srcDir) {
	console.error("usage: check-stringify <srcDir> [--scope=lib,routes] [--baseline]");
	process.exit(2);
}

const repoRoot = process.cwd();
const srcRoot = resolve(srcDir);

function* walk(dir: string): Generator<string> {
	for (const ent of readdirSync(dir)) {
		if (ent === "node_modules" || ent.startsWith(".")) continue;
		const p = join(dir, ent);
		const st = statSync(p);
		if (st.isDirectory()) yield* walk(p);
		else if (/\.ts$/.test(ent) && !/\.d\.ts$/.test(ent)) yield p;
	}
}

const targets = [...walk(srcRoot)].filter((f) => {
	if (!scopes) return true;
	const rel = relative(srcRoot, f).split("\\").join("/");
	return scopes.some((s) => rel.startsWith(s.replace(/\/+$/, "") + "/") || rel === s);
});

const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, "tsconfig.json");
if (!configPath) {
	console.error("check-stringify: tsconfig.json not found");
	process.exit(2);
}
const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, repoRoot);

const program = ts.createProgram({
	rootNames: parsed.fileNames.filter((f) => /\.ts$/.test(f)),
	options: { ...parsed.options, noEmit: true, checkJs: false },
});
const checker = program.getTypeChecker();

const SAFE =
	ts.TypeFlags.String |
	ts.TypeFlags.StringLiteral |
	ts.TypeFlags.Number |
	ts.TypeFlags.NumberLiteral |
	ts.TypeFlags.Boolean |
	ts.TypeFlags.BooleanLiteral |
	ts.TypeFlags.BigInt |
	ts.TypeFlags.BigIntLiteral |
	ts.TypeFlags.ESSymbol |
	ts.TypeFlags.ESSymbolLike |
	ts.TypeFlags.Enum |
	ts.TypeFlags.EnumLiteral |
	ts.TypeFlags.Undefined |
	ts.TypeFlags.Null |
	ts.TypeFlags.Void |
	ts.TypeFlags.Never;

/** A declared toString/valueOf is "real" unless its ONLY declaration is the
 *  `Object` interface itself — the default that renders "[object Object]". */
function hasRealToString(t: ts.Type): boolean {
	for (const name of ["toString", "valueOf"]) {
		const prop = t.getProperty(name);
		for (const d of prop?.getDeclarations() ?? []) {
			const p = d.parent;
			if (p && ts.isInterfaceDeclaration(p) && p.name.text === "Object") continue;
			return true;
		}
	}
	return false;
}

function isDisplaySafe(t: ts.Type): boolean {
	if (t.isUnion()) return t.types.every(isDisplaySafe);
	if ((t.getFlags() & SAFE) !== 0) return true;
	if (t.flags & ts.TypeFlags.Intersection) {
		return (t as ts.IntersectionType).types.every(isDisplaySafe);
	}
	return hasRealToString(t);
}

interface Violation { file: string; line: number; col: number; text: string }
const violations: Violation[] = [];
const targetSet = new Set(targets.map((f) => resolve(f)));

function flag(node: ts.Node, expr: ts.Expression) {
	const t = checker.getTypeAtLocation(expr);
	if (isDisplaySafe(t)) return;
	const sf = node.getSourceFile();
	const { line, character } = sf.getLineAndCharacterOfPosition(expr.getStart(sf));
	violations.push({
		file: relative(repoRoot, sf.fileName).split("\\").join("/"),
		line: line + 1,
		col: character + 1,
		text: expr.getText(sf).slice(0, 60),
	});
}

function visit(node: ts.Node) {
	if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "String" && node.arguments.length >= 1) {
		flag(node, node.arguments[0]);
	} else if (ts.isTemplateExpression(node)) {
		for (const span of node.templateSpans) flag(node, span.expression);
	} else if (ts.isTemplateHead(node)) {
		// tagged/head segments carry no substitutions — covered via TemplateExpression
	}
	ts.forEachChild(node, visit);
}

for (const f of targetSet) {
	const sf = program.getSourceFile(f);
	if (sf) visit(sf);
}

const key = (v: Violation) => `${v.file}:${v.line}`;
let baseline: Set<string> | null = null;
if (existsSync(BASELINE)) {
	baseline = new Set(
		(JSON.parse(readFileSync(BASELINE, "utf8")) as { violations?: string[] }).violations ?? [],
	);
}
if (writeBaseline) {
	writeFileSync(BASELINE, JSON.stringify({ violations: violations.map(key).sort() }, null, 2) + "\n");
	console.log(`check-stringify: baseline written (${violations.length} entries)`);
	process.exit(0);
}
const current = baseline ? violations.filter((v) => !baseline.has(key(v))) : violations;

if (current.length) {
	console.error(`check-stringify: ${current.length} violation(s)${baseline ? ` (+${violations.length - current.length} baseline)` : ""}`);
	console.error(`  display coercion goes through toDisplayString (@primebrick/ui) — docs/ai/display-coercion.md`);
	for (const v of current.slice(0, 50)) {
		console.error(`  ${v.file}:${v.line}:${v.col}  ${v.text}`);
	}
	if (current.length > 50) console.error(`  … and ${current.length - 50} more`);
	process.exit(1);
}
console.log(`check-stringify: clean${baseline ? ` (${baseline.size} baseline)` : ""} [typed, ${targetSet.size} files]`);
