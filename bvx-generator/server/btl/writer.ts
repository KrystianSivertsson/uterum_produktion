import type { Job, Operation, Part } from "../../shared/schema.ts";

/**
 * BTL V10.5-writer enligt den officiella specen (design2machine,
 * btl_v105.pdf). SCALEUNIT: 2 → alla mått och vinklar skrivs som
 * heltal i 1/100 (mm respektive grader), åttasiffrigt nollutfyllda,
 * samma som hsbCAD:s BTL-export.
 *
 * Processkey-format G-KEY-S: G = grupp (1 = balkstart, 2 = balkslut,
 * 3 = sidobearbetning), KEY = processnummer, S = referenssida.
 *
 * Stödda operationer: SawCut → Cut (010), Drilling → Drilling (040),
 * Lap → Lap Joint (030). Övriga rapporteras som varningar.
 */

export interface BtlResult {
  text: string;
  warnings: string[];
}

const SCALE = 100;

function num(value: number): string {
  const scaled = Math.round(value * SCALE);
  if (scaled < 0) return "-" + Math.abs(scaled).toString().padStart(7, "0");
  return scaled.toString().padStart(8, "0");
}

function paramLine(entries: [name: string, value: number][]): string {
  return "PROCESSPARAMETERS: " + entries.map(([name, value]) => `${name}:${num(value)}`).join("   ");
}

function processingLines(op: Operation, ident: number, part: Part, warnings: string[]): string[] {
  const partName = part.name;
  switch (op.type) {
    case "SawCut": {
      // Orientation Right = kap vid balkstart (grupp 1), Left = balkslut (grupp 2)
      const group = op.orientation === "Right" ? 1 : 2;
      const perpendicular = op.angle === 90 && op.bevel === 90;
      return [
        `PROCESSKEY: ${group}-010-${op.referenceSide}        Cut - ${perpendicular ? "Perpendicular" : "Angled"}`,
        paramLine([
          ["P01", op.lengthMeas],
          ["P02", 0],
          ["P03", 0],
          ["P06", op.angle],
          ["P07", op.bevel],
        ]),
        `PROCESSIDENT: ${ident}`,
        "PRIORITY: 0",
      ];
    }
    case "Drilling": {
      const params: [string, number][] = [
        ["P01", op.lengthMeas],
        ["P02", op.crossMeas1],
        ["P03", 0], // 0 = borrning från sida (inte ändträ)
        ["P06", 90],
        ["P07", 90],
        ["P11", op.drillDiam],
      ];
      // P12 utelämnad = genomgående (förinställning HRS i specen)
      if (op.holeDepth > 0) params.push(["P12", op.holeDepth]);
      return [
        `PROCESSKEY: 3-040-${op.referenceSide}        Drilling`,
        paramLine(params),
        `PROCESSIDENT: ${ident}`,
        "PRIORITY: 0",
      ];
    }
    case "Lap": {
      const start =
        op.lengthOrientation === "Center"
          ? op.lengthMeas - op.length / 2
          : op.lengthOrientation === "Left"
            ? op.lengthMeas
            : op.lengthMeas - op.length;
      const depth = op.depth ?? op.crossMeas1;
      // Parametermappning verifierad mot hsbCAD:s produktions-BTL
      // (takstol_7st.btl): P03 = 0 (urtaget börjar vid referenssidans
      // yta), P11 = bottnens avstånd från referenssidan, P14 = 0 →
      // full transversell bredd enligt specregeln P14 = WRS - P02.
      // G-siffran kodar öppningsriktningen: 3-030-S öppnar MOT
      // referenssidan S, 4-030-S öppnar BORT från den. Kalibrerat mot
      // facit (bärlina-hak = 4-030-2): maskinens sida 2 motsvarar vår
      // width-MAX, så öppning mot vår min-sida blir grupp 4.
      const lapKeys: Record<number, { group: number; side: number; floorFromSide: number }> = {
        2: { group: 4, side: 2, floorFromSide: part.width - depth },
        4: { group: 3, side: 2, floorFromSide: depth },
        3: { group: 4, side: 3, floorFromSide: part.height - depth },
        1: { group: 3, side: 3, floorFromSide: depth },
      };
      const lap = lapKeys[op.referenceSide] ?? { group: 3, side: op.referenceSide, floorFromSide: depth };
      // P07-konvention enligt facit: >90 när urtaget öppnar bort från
      // referenssidan (grupp 4), <90 mot den (grupp 3)
      const deviation = Math.abs((op.inclination ?? 90) - 90);
      const floorInclination = lap.group === 4 ? 90 + deviation : 90 - deviation;
      return [
        `PROCESSKEY: ${lap.group}-030-${lap.side}        Lap Joint`,
        paramLine([
          ["P01", start],
          ["P02", 0],
          ["P03", 0],
          ["P04", 0],
          ["P06", 90],
          ["P07", floorInclination],
          ["P08", 0],
          // P09/P10 = 90: urtagsväggar vinkelräta mot bottnen, samma som
          // hsbCAD:s export (0/0 betyder "parallella med ändytan" i specen)
          ["P09", 90],
          ["P10", 90],
          ["P11", lap.floorFromSide],
          ["P12", op.length],
          ["P13", 0],
          ["P14", 0],
        ]),
        `PROCESSIDENT: ${ident}`,
        "PRIORITY: 0",
      ];
    }
    default: {
      const label = op.type === "Generic" ? op.tag : op.type;
      warnings.push(`${partName}: ${label} exporteras inte till BTL ännu — hoppad (använd BVX för full täckning)`);
      return [];
    }
  }
}

function partLines(part: Part, memberNumber: number, warnings: string[]): string[] {
  const lines = [
    "[PART]",
    `SINGLEMEMBERNUMBER: ${memberNumber}`,
    'ASSEMBLYNUMBER: ""',
    "ORDERNUMBER: 0",
    `DESIGNATION: "${part.name}"`,
    `ANNOTATION: "${part.comments}"`,
    'STOREY: ""',
    'GROUP: ""',
    'PACKAGE: ""',
    'MATERIAL: ""',
    `TIMBERGRADE: "${part.grade}"`,
    'QUALITYGRADE: ""',
    `COUNT: ${part.quantity}`,
    `LENGTH: ${num(part.length)}`,
    `HEIGHT: ${num(part.height)}`,
    `WIDTH: ${num(part.width)}`,
    `UID: ${memberNumber}`,
    "TRANSFORMATION: OX:00000000  OY:00000000  OZ:00000000  XX:00100000  XY:00000000  XZ:00000000  YX:00000000  YY:00100000  YZ:00000000",
    "PROCESSINGQUALITY: AUTOMATIC",
  ];
  let ident = 0;
  for (const op of part.operations) {
    const processing = processingLines(op, ++ident, part, warnings);
    if (processing.length === 0) ident--;
    lines.push(...processing);
  }
  return lines;
}

export function writeBtl(job: Job, options: { projectName?: string; now?: Date } = {}): BtlResult {
  const warnings: string[] = [];
  const now = options.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8);

  const lines = [
    'VERSION: "BTL V10.5"',
    'BUILD: "10501"',
    "[GENERAL]",
    'PROJECTNUMBER: ""',
    `PROJECTNAME: "${options.projectName ?? ""}"`,
    'PROJECTPART: ""',
    'LISTNAME: ""',
    'CUSTOMER: ""',
    'ARCHITECT: ""',
    `EDITOR: "${job.operator}"`,
    `DELIVERYDATE: "${job.deliveryDate}"`,
    `EXPORTDATE: "${date}"`,
    `EXPORTTIME: "${time}"`,
    'EXPORTRELEASE: "bvx-generator"',
    'LANGUAGE: ""',
    "SCALEUNIT: 2",
    'COMPUTERNAME: ""',
    `USER: "${job.operator}"`,
    'COMMENT: ""',
  ];
  job.parts.forEach((part, index) => lines.push(...partLines(part, index + 1, warnings)));
  return { text: lines.join("\r\n") + "\r\n", warnings };
}
