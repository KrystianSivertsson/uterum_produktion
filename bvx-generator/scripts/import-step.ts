import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { jobSchema } from "../shared/schema.ts";
import { stepToParts } from "../server/step/solidToTimber.ts";
import { writeBvx } from "../server/bvx/writer.ts";
import { writeBtl } from "../server/btl/writer.ts";

function usage(): never {
  console.error("Användning: npm run import-step -- <fil.step> [-o <jobb.json>] [--bvx] [--btl]");
  process.exit(1);
}

const args = process.argv.slice(2);
const emitBvx = args.includes("--bvx");
if (emitBvx) args.splice(args.indexOf("--bvx"), 1);
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
const { parts, warnings } = stepToParts(readFileSync(resolvedIn, "utf8"));
const job = jobSchema.parse({ parts });

const stem = resolvedIn.replace(/\.(stp|step)$/i, "");
const jsonPath = resolve(outPath ?? stem + ".json");
writeFileSync(jsonPath, JSON.stringify(job, null, 2) + "\n", "utf8");
console.log(`Skrev ${jsonPath}`);

if (emitBvx) {
  const bvxPath = stem + ".bvx";
  writeFileSync(bvxPath, writeBvx(job), "utf8");
  console.log(`Skrev ${bvxPath}`);
}

if (emitBtl) {
  const btlPath = stem + ".btl";
  const btl = writeBtl(job, { projectName: basename(stem) });
  writeFileSync(btlPath, btl.text, "utf8");
  console.log(`Skrev ${btlPath}`);
  warnings.push(...btl.warnings);
}

console.log(`\n${job.parts.length} delar:`);
for (const part of job.parts) {
  const opSummary = new Map<string, number>();
  for (const op of part.operations) {
    const key = op.type === "Generic" ? op.tag : op.type;
    opSummary.set(key, (opSummary.get(key) ?? 0) + 1);
  }
  const ops = [...opSummary].map(([type, count]) => `${count} ${type}`).join(", ") || "inga operationer";
  console.log(`  ${part.name}: ${part.length} x ${part.height} x ${part.width} mm — ${ops}`);
}

if (warnings.length > 0) {
  console.log("\nVarningar (granska innan skarp körning):");
  for (const warning of warnings) console.log(`  ! ${warning}`);
}
