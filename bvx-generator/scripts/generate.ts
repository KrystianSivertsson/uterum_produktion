import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { jobSchema } from "../shared/schema.ts";
import { writeBvx } from "../server/bvx/writer.ts";
import { writeBtl } from "../server/btl/writer.ts";

function usage(): never {
  console.error("Användning: npm run generate -- <jobb.json> [-o <utfil.bvx>] [--btl]");
  process.exit(1);
}

const args = process.argv.slice(2);
const emitBtl = args.includes("--btl");
if (emitBtl) args.splice(args.indexOf("--btl"), 1);
const outFlagIndex = args.indexOf("-o");
let outPath: string | undefined;
if (outFlagIndex !== -1) {
  outPath = args[outFlagIndex + 1];
  if (!outPath) usage();
  args.splice(outFlagIndex, 2);
}
const inPath = args[0];
if (!inPath || args.length > 1) usage();

const resolvedIn = resolve(inPath);
const parsed = jobSchema.safeParse(JSON.parse(readFileSync(resolvedIn, "utf8")));
if (!parsed.success) {
  console.error(`Ogiltigt jobb i ${resolvedIn}:`);
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".") || "(rot)"}: ${issue.message}`);
  }
  process.exit(1);
}

const job = parsed.data;
const resolvedOut = resolve(outPath ?? resolvedIn.replace(/\.json$/i, "") + ".bvx");
writeFileSync(resolvedOut, writeBvx(job), "utf8");

const totalPieces = job.parts.reduce((sum, part) => sum + part.quantity, 0);
const totalOps = job.parts.reduce((sum, part) => sum + part.operations.length, 0);
console.log(`Skrev ${resolvedOut}`);
console.log(`  ${job.parts.length} delar (${totalPieces} st totalt), ${totalOps} bearbetningar`);

if (emitBtl) {
  const btlPath = resolvedOut.replace(/\.bvx$/i, "") + ".btl";
  const btl = writeBtl(job, { projectName: basename(btlPath, ".btl") });
  writeFileSync(btlPath, btl.text, "utf8");
  console.log(`Skrev ${btlPath}`);
  for (const warning of btl.warnings) console.log(`  ! ${warning}`);
}
