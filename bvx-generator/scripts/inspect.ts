import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseBvx } from "../server/bvx/parser.ts";

const inPath = process.argv[2];
if (!inPath) {
  console.error("Användning: npm run inspect -- <fil.bvx>");
  process.exit(1);
}

const job = parseBvx(readFileSync(resolve(inPath), "utf8"));

console.log(`Operatör: ${job.operator || "-"}   Leveransdatum: ${job.deliveryDate || "-"}`);
console.log(`${job.parts.length} delar:\n`);

for (const part of job.parts) {
  const dims = `${part.length} x ${part.height} x ${part.width} mm`;
  console.log(`  #${part.partId ?? "?"} ${part.name}  (${part.quantity} st, ${dims}${part.grade ? ", " + part.grade : ""})`);
  const counts = new Map<string, number>();
  for (const op of part.operations) {
    const key = op.type === "Generic" ? `${op.tag} (otypad)` : op.type;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [type, count] of counts) {
    console.log(`      ${count} x ${type}`);
  }
}
