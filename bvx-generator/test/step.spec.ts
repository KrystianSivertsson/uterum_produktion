import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jobSchema } from "../shared/schema.ts";
import { parseBvx } from "../server/bvx/parser.ts";
import { writeBvx } from "../server/bvx/writer.ts";
import { stepToParts } from "../server/step/solidToTimber.ts";

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(join(here, "fixtures", name), "utf8");
}

/**
 * Bygger en minimal STEP-fil för testerna: en låda 1000 x 45 x 145
 * plus valfria extra ytor (cylindrar, urtagsbottnar, urtagsväggar).
 */
class StepBuilder {
  private id = 100;
  private lines: string[] = [];
  private faceIds: number[] = [];

  private next(): number {
    return ++this.id;
  }

  private point(coords: number[]): number {
    const pointId = this.next();
    this.lines.push(`#${pointId}=CARTESIAN_POINT('',(${coords.join(",")}));`);
    return pointId;
  }

  private direction(coords: number[]): number {
    const directionId = this.next();
    this.lines.push(`#${directionId}=DIRECTION('',(${coords.join(",")}));`);
    return directionId;
  }

  private face(surfaceId: number, vertices: number[][]): void {
    const vertexIds = vertices.map((coords) => {
      const vertexId = this.next();
      this.lines.push(`#${vertexId}=VERTEX_POINT('',#${this.point(coords)});`);
      return vertexId;
    });
    const edgeId = this.next();
    this.lines.push(`#${edgeId}=EDGE_CURVE('',#${vertexIds[0]},#${vertexIds[1]},#${surfaceId},.T.);`);
    const orientedId = this.next();
    this.lines.push(`#${orientedId}=ORIENTED_EDGE('',*,*,#${edgeId},.T.);`);
    const loopId = this.next();
    this.lines.push(`#${loopId}=EDGE_LOOP('',(#${orientedId}));`);
    const boundId = this.next();
    this.lines.push(`#${boundId}=FACE_OUTER_BOUND('',#${loopId},.T.);`);
    const faceId = this.next();
    this.lines.push(`#${faceId}=ADVANCED_FACE('',(#${boundId}),#${surfaceId},.T.);`);
    this.faceIds.push(faceId);
  }

  plane(origin: number[], normal: number[], vertices: number[][]): this {
    const placementId = this.next();
    this.lines.push(`#${placementId}=AXIS2_PLACEMENT_3D('',#${this.point(origin)},#${this.direction(normal)},$);`);
    const surfaceId = this.next();
    this.lines.push(`#${surfaceId}=PLANE('',#${placementId});`);
    this.face(surfaceId, vertices);
    return this;
  }

  cylinder(origin: number[], axis: number[], radius: number, vertices: number[][]): this {
    const placementId = this.next();
    this.lines.push(`#${placementId}=AXIS2_PLACEMENT_3D('',#${this.point(origin)},#${this.direction(axis)},$);`);
    const surfaceId = this.next();
    this.lines.push(`#${surfaceId}=CYLINDRICAL_SURFACE('',#${placementId},${radius}.);`);
    this.face(surfaceId, vertices);
    return this;
  }

  /** Lådan 1000 x 45 x 145 med utåtriktade normaler */
  box(): this {
    return this.plane([0, 0, 0], [-1, 0, 0], [[0, 0, 0], [0, 45, 145]])
      .plane([1000, 45, 145], [1, 0, 0], [[1000, 0, 0], [1000, 45, 145]])
      .plane([0, 0, 0], [0, -1, 0], [[0, 0, 0], [1000, 0, 145]])
      .plane([1000, 45, 145], [0, 1, 0], [[0, 45, 0], [1000, 45, 145]])
      .plane([0, 0, 0], [0, 0, -1], [[0, 0, 0], [1000, 45, 0]])
      .plane([1000, 45, 145], [0, 0, 1], [[0, 0, 145], [1000, 45, 145]]);
  }

  build(): string {
    const shellId = this.next();
    this.lines.push(`#${shellId}=CLOSED_SHELL('',(${this.faceIds.map((faceId) => `#${faceId}`).join(",")}));`);
    const solidId = this.next();
    this.lines.push(`#${solidId}=MANIFOLD_SOLID_BREP('Testregel',#${shellId});`);
    return ["ISO-10303-21;", "HEADER;", "ENDSEC;", "DATA;", ...this.lines, "ENDSEC;", "END-ISO-10303-21;"].join("\n");
  }
}

describe("stepToParts på del_1.step (degenererad fil utan topologi)", () => {
  it("hämtar mått ur planytorna och ger två vinkelräta kap", () => {
    const { parts } = stepToParts(fixture("del_1.step"));
    expect(parts).toHaveLength(1);

    const part = parts[0];
    expect(part.name).toBe("del_1");
    expect(part.length).toBe(3360);
    expect(part.height).toBe(200);
    expect(part.width).toBe(3360);

    expect(part.operations).toHaveLength(2);
    expect(part.operations[0]).toMatchObject({
      type: "SawCut",
      lengthMeas: 0,
      orientation: "Right",
      angle: 90,
      bevel: 90,
    });
    expect(part.operations[1]).toMatchObject({
      type: "SawCut",
      lengthMeas: 3360,
      orientation: "Left",
      angle: 90,
      bevel: 90,
    });
  });
});

describe("stepToParts på backBeam_1_1.step (riktig Open CASCADE-assembly)", () => {
  const result = stepToParts(fixture("backBeam_1_1.step"));

  it("hittar båda soliderna med produktnamn och virkesdimensioner", () => {
    expect(result.parts.map((part) => part.name)).toEqual(["backBeam_1_1 23.1", "backBeam_1_1 23.2"]);
    expect(result.parts[0]).toMatchObject({ length: 3570, height: 56, width: 225 });
    expect(result.parts[1]).toMatchObject({ length: 3472, height: 56, width: 225 });
  });

  it("ger varje del två ändkap", () => {
    for (const part of result.parts) {
      const cuts = part.operations.filter((op) => op.type === "SawCut");
      expect(cuts).toHaveLength(2);
    }
  });

  it("ger delar som validerar och överlever BVX-rundtur", () => {
    const job = jobSchema.parse({ parts: result.parts });
    const roundTripped = parseBvx(writeBvx(job));
    expect(roundTripped.parts.map((part) => part.name)).toEqual(job.parts.map((part) => part.name));
    // depth/inclination är interna fält (för BTL-export) som med avsikt inte finns i BVX
    const withoutInternal = job.parts[0].operations.map((op) =>
      op.type === "Lap" ? (({ depth: _depth, inclination: _inclination, ...rest }) => rest)(op) : op,
    );
    expect(roundTripped.parts[0].operations).toEqual(withoutInternal);
  });
});

describe("stepToParts med cylinderytor", () => {
  it("konverterar en genomgående cylinder till en borrning", () => {
    const text = new StepBuilder()
      .box()
      .cylinder([500, 0, 70], [0, 1, 0], 6, [[500, 0, 64], [500, 45, 64]])
      .build();
    const { parts, warnings } = stepToParts(text);
    expect(warnings).toEqual([]);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ length: 1000, height: 45, width: 145 });

    const drillings = parts[0].operations.filter((op) => op.type === "Drilling");
    expect(drillings).toHaveLength(1);
    expect(drillings[0]).toMatchObject({
      referenceSide: 3,
      lengthMeas: 500,
      crossMeas1: 70,
      drillDiam: 12,
      holeDepth: 0,
    });
  });
});

describe("stepToParts med lutande balk (takstol)", () => {
  it("hittar virkesdimensionerna trots att urtagen följer byggnadens axlar", () => {
    // Samma låda 1000 x 45 x 145 men roterad 15° (som en takstol i en
    // stomme-modell), plus fem små byggnadsriktade ytor (hak/kap).
    // Med hörnpunkts-viktning röstar småytorna fram fel axlar och
    // delen får bounding box-mått — area-viktningen ska hindra det.
    const radians = (15 * Math.PI) / 180;
    const rot = (p: number[]) => [
      p[0] * Math.cos(radians) - p[1] * Math.sin(radians),
      p[0] * Math.sin(radians) + p[1] * Math.cos(radians),
      p[2],
    ];
    const boxPlanes = [
      { origin: [0, 0, 0], normal: [-1, 0, 0], diag: [[0, 0, 0], [0, 45, 145]] },
      { origin: [1000, 45, 145], normal: [1, 0, 0], diag: [[1000, 0, 0], [1000, 45, 145]] },
      { origin: [0, 0, 0], normal: [0, -1, 0], diag: [[0, 0, 0], [1000, 0, 145]] },
      { origin: [1000, 45, 145], normal: [0, 1, 0], diag: [[0, 45, 0], [1000, 45, 145]] },
      { origin: [0, 0, 0], normal: [0, 0, -1], diag: [[0, 0, 0], [1000, 45, 0]] },
      { origin: [1000, 45, 145], normal: [0, 0, 1], diag: [[0, 0, 145], [1000, 45, 145]] },
    ];
    const builder = new StepBuilder();
    for (const plane of boxPlanes) {
      builder.plane(rot(plane.origin), rot(plane.normal), plane.diag.map(rot));
    }
    // Byggnadsriktade småytor (vågräta hak-bottnar och lodräta väggar),
    // alla med hörnpunkter inne i den roterade balken
    builder
      .plane([300, 100, 20], [0, 1, 0], [[300, 100, 20], [340, 100, 80]])
      .plane([500, 150, 20], [0, 1, 0], [[500, 150, 20], [540, 150, 80]])
      .plane([680, 200, 20], [0, 1, 0], [[680, 200, 20], [700, 200, 80]])
      .plane([400, 130, 20], [1, 0, 0], [[400, 115, 20], [400, 145, 80]])
      .plane([600, 180, 30], [1, 0, 0], [[600, 165, 30], [600, 200, 90]]);

    const { parts } = stepToParts(builder.build());
    expect(parts[0].length).toBeCloseTo(1000, 1);
    expect(parts[0].height).toBeCloseTo(45, 1);
    expect(parts[0].width).toBeCloseTo(145, 1);

    const cuts = parts[0].operations.filter((op) => op.type === "SawCut");
    expect(cuts.map((cut) => cut.lengthMeas)).toEqual([0, 1000]);
  });
});

describe("stepToParts på rafter_4_4.step (platt takstol med birdsmouth-hak)", () => {
  const result = stepToParts(fixture("rafter_4_4.step"));

  it("ger virkesdimensioner och vinklade ändkap utan varningar", () => {
    expect(result.warnings).toEqual([]);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({ length: 4282.535, height: 58, width: 225 });

    const cuts = result.parts[0].operations.filter((op) => op.type === "SawCut");
    expect(cuts).toHaveLength(2);
    for (const cut of cuts) {
      expect(cut.angle).toBeCloseTo(82.74, 2); // plumb-kap i lutande tak
    }
  });

  it("konverterar haken till lutande Lap med sunda djup", () => {
    const laps = result.parts[0].operations.filter((op) => op.type === "Lap");
    expect(laps).toHaveLength(3);
    for (const lap of laps) {
      expect([2, 4]).toContain(lap.referenceSide);
      // Botten följer taklutningen (7.26°), tecknet beror på öppningssidan
      expect(Math.abs((lap.inclination ?? 90) - 90)).toBeCloseTo(7.26, 2);
      expect(lap.depth ?? 0).toBeGreaterThan(0);
      expect(lap.depth ?? 0).toBeLessThan(225);
    }
    // Alla tre urtagen (frambärlina-hak 140, bakbärlina-hak 56, överhäng)
    // öppnar åt samma håll — undersidan, där kantytan saknas
    expect(laps.map((lap) => lap.referenceSide)).toEqual([2, 2, 2]);
  });
});

describe("stepToParts med urtag", () => {
  it("konverterar ett fullbreddsurtag till Lap och räknar inte väggarna som ändytor", () => {
    // Urtag 300–400 mm, djup 20 från ovansidan (botten på h=25), full bredd
    const text = new StepBuilder()
      .box()
      .plane([300, 25, 0], [0, 1, 0], [[300, 25, 0], [400, 25, 145]])
      .plane([300, 35, 72], [1, 0, 0], [[300, 25, 0], [300, 45, 145]])
      .plane([400, 35, 72], [-1, 0, 0], [[400, 25, 0], [400, 45, 145]])
      .build();
    const { parts, warnings } = stepToParts(text);
    expect(warnings).toEqual([]);

    const laps = parts[0].operations.filter((op) => op.type === "Lap");
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({
      referenceSide: 1,
      lengthMeas: 350,
      length: 100,
      crossMeas1: 20,
      depth: 20,
      crossMeas2: 72.5,
      lengthOrientation: "Center",
    });

    const cuts = parts[0].operations.filter((op) => op.type === "SawCut");
    expect(cuts.map((cut) => cut.lengthMeas)).toEqual([0, 1000]);
  });

  it("varnar för delbreddsficka i stället för att gissa", () => {
    // Ficka 300–400 mm som bara är 60 mm bred (z 20–80) — kan inte bli Lap
    const text = new StepBuilder()
      .box()
      .plane([300, 25, 20], [0, 1, 0], [[300, 25, 20], [400, 25, 80]])
      .build();
    const { parts, warnings } = stepToParts(text);
    expect(warnings.some((warning) => warning.includes("delbreddsurtag") || warning.includes("ficka"))).toBe(true);
    expect(parts[0].operations.filter((op) => op.type === "Lap")).toHaveLength(0);
  });
});
