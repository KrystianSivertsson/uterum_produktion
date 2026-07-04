import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jobSchema } from "../shared/schema.ts";
import { parseBvx } from "../server/bvx/parser.ts";
import { writeBvx } from "../server/bvx/writer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "fixtures", "hsbCAD2017Template.bvx"), "utf8");

function operationCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const part of parseBvx(text).parts) {
    for (const op of part.operations) {
      const key = op.type === "Generic" ? op.tag : op.type;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

describe("parseBvx på hsbCAD:s riktiga mallexport", () => {
  it("läser alla delar och operationer som typade objekt", () => {
    const job = parseBvx(fixture);
    expect(job.parts).toHaveLength(11);
    expect(job.deliveryDate).toBe("05.06.2019");

    const untyped = job.parts.flatMap((part) => part.operations).filter((op) => op.type === "Generic");
    expect(untyped).toEqual([]);

    const counts = operationCounts(fixture);
    expect(counts.get("SawCut")).toBe(22);
    expect(counts.get("Lap")).toBe(2);
    expect(counts.get("Drilling")).toBe(2);
    expect(counts.get("Tenon")).toBe(1);
    expect(counts.get("Mortise")).toBe(1);
    expect(counts.get("DovetailMortise")).toBe(1);
    expect(counts.get("DovetailTenon")).toBe(1);
  });

  it("rundtur parse → write → parse ger identisk struktur", () => {
    const first = parseBvx(fixture);
    const second = parseBvx(writeBvx(first));
    expect(second).toEqual(first);
  });
});

describe("writeBvx på exempeljobbet", () => {
  const exampleJob = jobSchema.parse(
    JSON.parse(readFileSync(join(here, "..", "data", "exempel-jobb.json"), "utf8")),
  );

  it("fyller i standardvärden och läses tillbaka oförändrat", () => {
    const roundTripped = parseBvx(writeBvx(exampleJob));

    expect(roundTripped.parts.map((part) => part.partId)).toEqual([1, 2, 3]);
    expect(roundTripped.parts.map((part) => part.name)).toEqual(["Väggregel", "Stolpe", "Hammarband"]);
    roundTripped.parts.forEach((part, index) => {
      expect(part.operations).toEqual(exampleJob.parts[index].operations);
      expect(part.quantity).toBe(exampleJob.parts[index].quantity);
    });
  });

  it("skriver perpendikulära kap med Angle=90 som standard", () => {
    const roundTripped = parseBvx(writeBvx(exampleJob));
    const firstCut = roundTripped.parts[0].operations[0];
    expect(firstCut).toMatchObject({ type: "SawCut", angle: 90, bevel: 90 });
  });
});

describe("XML-specialtecken", () => {
  it("escapar och avescapar attributvärden", () => {
    const job = jobSchema.parse({
      operator: 'A & B <täljare> "citat"',
      parts: [{ name: "Regel <45> & \"test\"", length: 1000, height: 45, width: 95 }],
    });
    const roundTripped = parseBvx(writeBvx(job));
    expect(roundTripped.operator).toBe(job.operator);
    expect(roundTripped.parts[0].name).toBe(job.parts[0].name);
  });
});
