import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jobSchema } from "../shared/schema.ts";
import { writeBtl } from "../server/btl/writer.ts";

const here = dirname(fileURLToPath(import.meta.url));

const exampleJob = jobSchema.parse(
  JSON.parse(readFileSync(join(here, "..", "data", "exempel-jobb.json"), "utf8")),
);

describe("writeBtl på exempeljobbet", () => {
  const { text, warnings } = writeBtl(exampleJob, { now: new Date("2026-07-04T12:00:00") });
  const lines = text.split("\r\n");

  it("skriver V10.5-huvud med SCALEUNIT 2", () => {
    expect(lines[0]).toBe('VERSION: "BTL V10.5"');
    expect(lines).toContain("SCALEUNIT: 2");
    expect(lines).toContain('EDITOR: "Krystian"');
  });

  it("skriver delarna med mått i 1/100 mm", () => {
    expect(lines).toContain('DESIGNATION: "Väggregel"');
    expect(lines).toContain("LENGTH: 00240000"); // 2400 mm
    expect(lines).toContain("HEIGHT: 00004500"); // 45 mm
    expect(lines).toContain("COUNT: 12");
  });

  it("mappar kap till 1/2-010-S med vinklar i 1/100 grader", () => {
    expect(lines).toContain("PROCESSKEY: 1-010-3        Cut - Perpendicular");
    expect(lines).toContain("PROCESSKEY: 2-010-3        Cut - Perpendicular");
    // Hammarbandets 45°-kap vid balkslutet
    expect(lines).toContain("PROCESSKEY: 2-010-3        Cut - Angled");
    expect(text).toContain("P06:00004500   P07:00009000");
  });

  it("mappar borrning till 3-040-S med diameter i P11 och genomgående utan P12", () => {
    expect(lines).toContain("PROCESSKEY: 3-040-3        Drilling");
    const drillingParams = lines[lines.indexOf("PROCESSKEY: 3-040-3        Drilling") + 1];
    expect(drillingParams).toContain("P01:00120000"); // 1200 mm
    expect(drillingParams).toContain("P11:00001200"); // Ø12
    expect(drillingParams).not.toContain("P12:");
  });

  it("varnar för operationstyper som inte stöds i BTL ännu", () => {
    expect(warnings.some((warning) => warning.includes("Tenon"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("Mortise"))).toBe(true);
  });
});

describe("writeBtl med Lap", () => {
  it("mappar urtag till 3-030-S med P01 = start, P03 = djup, P12 = längd", () => {
    const job = jobSchema.parse({
      parts: [
        {
          name: "Regel med urtag",
          length: 1000,
          height: 45,
          width: 145,
          operations: [
            {
              type: "Lap",
              referenceSide: 1,
              lengthMeas: 350,
              crossMeas1: 20,
              crossMeas2: 72.5,
              length: 100,
              depth: 20,
            },
          ],
        },
      ],
    });
    const { text, warnings } = writeBtl(job);
    expect(warnings).toEqual([]);
    // referenceSide 1 = öppnar mot height-max → grupp 3 mot sida 3
    expect(text).toContain("PROCESSKEY: 3-030-3        Lap Joint");
    // P03 = 0 (urtaget börjar vid ytan), djupet ligger i P11 —
    // verifierat mot hsbCAD:s produktions-BTL (takstol_7st.btl)
    expect(text).toContain("P01:00030000   P02:00000000   P03:00000000");
    expect(text).toContain("P11:00002000"); // djup 20
    expect(text).toContain("P12:00010000"); // längd 100
  });

  it("skriver negativa värden med minustecken och sju siffror", () => {
    const job = jobSchema.parse({
      parts: [
        {
          name: "Ändhalvning",
          length: 1000,
          height: 45,
          width: 145,
          operations: [
            {
              type: "Lap",
              referenceSide: 1,
              lengthMeas: -87.5,
              crossMeas1: 22.5,
              crossMeas2: 72.5,
              length: 305,
            },
          ],
        },
      ],
    });
    const { text } = writeBtl(job);
    expect(text).toContain("P01:-0024000"); // -87.5 - 305/2 = -240
  });
});
