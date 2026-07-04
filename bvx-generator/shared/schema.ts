import { z } from "zod";

/**
 * Datamodell för ett Hundegger BVX-jobb. Fälten speglar attributen i
 * BVX 1.0-filer så som hsbCAD exporterar dem (se test/fixtures för en
 * riktig exportfil). Alla mått i mm, alla vinklar i grader.
 *
 * ReferenceSide är balkens referenssida 1–4 (Hundegger-konvention),
 * LengthMeas mäts längs balken från nollpunkten, CrossMeas tvärs balken.
 */

const referenceSide = z.number().int().min(1).max(6);
const splinterFree = z.string().default("sfNone");

export const sawCutSchema = z.object({
  type: z.literal("SawCut"),
  referenceSide,
  lengthMeas: z.number(),
  crossMeas1: z.number(),
  crossMeas2: z.number(),
  orientation: z.enum(["Left", "Right"]),
  angle: z.number().default(90),
  bevel: z.number().default(90),
});

export const drillingSchema = z.object({
  type: z.literal("Drilling"),
  referenceSide,
  lengthMeas: z.number(),
  crossMeas1: z.number(),
  crossMeas2: z.number().default(0),
  bevel: z.number().default(0),
  angle: z.number().default(0),
  drillDiam: z.number().positive(),
  /** 0 = genomgående hål */
  holeDepth: z.number().default(0),
  countersinkDiam: z.number().default(0),
  countersinkDepth: z.number().default(0),
  splinterFree,
});

export const lapSchema = z.object({
  type: z.literal("Lap"),
  referenceSide,
  lengthMeas: z.number(),
  crossMeas1: z.number(),
  crossMeas2: z.number(),
  angle: z.number().default(90),
  bevel: z.number().default(0),
  rotation: z.number().default(0),
  length: z.number().positive(),
  lengthOrientation: z.enum(["Left", "Center", "Right"]).default("Center"),
  /**
   * Urtagsdjup från referenssidan. Ingår inte i BVX-attributen (där
   * anger CrossMeas1 djupet) men behövs för BTL-exportens P11.
   */
  depth: z.number().positive().optional(),
  /**
   * Urtagsbottens lutning mot referenssidan i grader (90 = plan botten).
   * Används för birdsmouth-liknande hak i "platta delar" — blir P07 i
   * BTL. Ingår inte i BVX-attributen.
   */
  inclination: z.number().optional(),
});

export const mortiseSchema = z.object({
  type: z.literal("Mortise"),
  referenceSide,
  lengthMeas: z.number(),
  crossMeas: z.number(),
  angle: z.number().default(90),
  length: z.number().positive(),
  width: z.number().positive(),
  depth: z.number().positive(),
  lengthOrientation: z.enum(["Left", "Center", "Right"]).default("Center"),
  shape: z.string().default("Round"),
  splinterFree,
});

export const tenonSchema = z.object({
  type: z.literal("Tenon"),
  referenceSide,
  lengthMeas: z.number(),
  crossMeas: z.number(),
  orientation: z.enum(["Left", "Right"]),
  angle: z.number().default(90),
  bevel: z.number().default(0),
  rotation: z.number().default(0),
  length: z.number().positive(),
  width: z.number().positive(),
  depth: z.number().positive(),
  backCut: z.number().default(0),
  shape: z.string().default("Round"),
  splinterFree,
});

export const dovetailMortiseSchema = z.object({
  type: z.literal("DovetailMortise"),
  referenceSide,
  lengthMeas: z.number(),
  crossMeas: z.number(),
  referenceEdge: z.string().default("Qmin"),
  rotation: z.number().default(0),
  width: z.number().positive(),
  depth: z.number().positive(),
  middlePlane: z.number().default(0),
  cone: z.number(),
  splinterFree,
});

export const dovetailTenonSchema = z.object({
  type: z.literal("DovetailTenon"),
  referenceSide,
  lengthMeas: z.number(),
  crossMeas: z.number(),
  orientation: z.enum(["Left", "Right"]),
  angle: z.number().default(90),
  bevel: z.number().default(0),
  rotation: z.number().default(0),
  length: z.number().positive(),
  width: z.number().positive(),
  depth: z.number().positive(),
  offset: z.number().default(0),
  middlePlane: z.number().default(0),
  cone: z.number(),
  splinterFree,
});

/**
 * Operationstyp som inte finns i den typade listan ovan. Skrivs ut
 * ordagrant med sina attribut, så att inga bearbetningar tappas när en
 * befintlig fil läses in och skrivs tillbaka.
 */
export const genericOperationSchema = z.object({
  type: z.literal("Generic"),
  tag: z.string(),
  attrs: z.record(z.string()),
});

export const operationSchema = z.discriminatedUnion("type", [
  sawCutSchema,
  drillingSchema,
  lapSchema,
  mortiseSchema,
  tenonSchema,
  dovetailMortiseSchema,
  dovetailTenonSchema,
  genericOperationSchema,
]);

export const partSchema = z.object({
  name: z.string().min(1),
  /** Sätts automatiskt till löpnummer om det utelämnas */
  partId: z.number().int().positive().optional(),
  quantity: z.number().int().positive().default(1),
  unit: z.string().default(""),
  grade: z.string().default(""),
  profile: z.string().default(""),
  comments: z.string().default(""),
  dimension: z.string().default(""),
  length: z.number().positive(),
  height: z.number().positive(),
  width: z.number().positive(),
  operations: z.array(operationSchema).default([]),
  /** Okända Part-attribut från inlästa filer, bevaras vid återexport */
  extraAttrs: z.record(z.string()).optional(),
});

export const jobSchema = z.object({
  operator: z.string().default(""),
  /** Format DD.MM.YYYY, som i hsbCAD:s export */
  deliveryDate: z.string().default(""),
  parts: z.array(partSchema).min(1),
  extraAttrs: z.record(z.string()).optional(),
});

export type SawCut = z.infer<typeof sawCutSchema>;
export type Drilling = z.infer<typeof drillingSchema>;
export type Lap = z.infer<typeof lapSchema>;
export type Mortise = z.infer<typeof mortiseSchema>;
export type Tenon = z.infer<typeof tenonSchema>;
export type DovetailMortise = z.infer<typeof dovetailMortiseSchema>;
export type DovetailTenon = z.infer<typeof dovetailTenonSchema>;
export type GenericOperation = z.infer<typeof genericOperationSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type Part = z.infer<typeof partSchema>;
export type Job = z.infer<typeof jobSchema>;
