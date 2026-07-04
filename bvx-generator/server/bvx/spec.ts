/**
 * Attributordning och typning per BVX-operation. Ordningen följer hur
 * hsbCAD skriver attributen, så att genererade filer ser likadana ut
 * som de maskinen redan tar emot. Tabellen används av både writer och
 * parser — läggs en ny operation till räcker det att utöka den här och
 * i shared/schema.ts.
 */

export type AttrKind = "num" | "str";

export interface AttrSpec {
  attr: string;
  field: string;
  kind: AttrKind;
}

function a(attr: string, field: string, kind: AttrKind = "num"): AttrSpec {
  return { attr, field, kind };
}

export const OP_SPECS: Record<string, AttrSpec[]> = {
  SawCut: [
    a("ReferenceSide", "referenceSide"),
    a("LengthMeas", "lengthMeas"),
    a("CrossMeas1", "crossMeas1"),
    a("CrossMeas2", "crossMeas2"),
    a("Orientation", "orientation", "str"),
    a("Angle", "angle"),
    a("Bevel", "bevel"),
  ],
  Drilling: [
    a("ReferenceSide", "referenceSide"),
    a("LengthMeas", "lengthMeas"),
    a("CrossMeas1", "crossMeas1"),
    a("CrossMeas2", "crossMeas2"),
    a("Bevel", "bevel"),
    a("Angle", "angle"),
    a("DrillDiam", "drillDiam"),
    a("HoleDepth", "holeDepth"),
    a("CountersinkDiam", "countersinkDiam"),
    a("CountersinkDepth", "countersinkDepth"),
    a("SplinterFree", "splinterFree", "str"),
  ],
  Lap: [
    a("ReferenceSide", "referenceSide"),
    a("LengthMeas", "lengthMeas"),
    a("CrossMeas1", "crossMeas1"),
    a("CrossMeas2", "crossMeas2"),
    a("Angle", "angle"),
    a("Bevel", "bevel"),
    a("Rotation", "rotation"),
    a("Length", "length"),
    a("LengthOrientation", "lengthOrientation", "str"),
  ],
  Mortise: [
    a("ReferenceSide", "referenceSide"),
    a("LengthMeas", "lengthMeas"),
    a("CrossMeas", "crossMeas"),
    a("Angle", "angle"),
    a("Length", "length"),
    a("Width", "width"),
    a("Depth", "depth"),
    a("LengthOrientation", "lengthOrientation", "str"),
    a("Shape", "shape", "str"),
    a("SplinterFree", "splinterFree", "str"),
  ],
  Tenon: [
    a("ReferenceSide", "referenceSide"),
    a("LengthMeas", "lengthMeas"),
    a("CrossMeas", "crossMeas"),
    a("Orientation", "orientation", "str"),
    a("Angle", "angle"),
    a("Bevel", "bevel"),
    a("Rotation", "rotation"),
    a("Length", "length"),
    a("Width", "width"),
    a("Depth", "depth"),
    a("BackCut", "backCut"),
    a("Shape", "shape", "str"),
    a("SplinterFree", "splinterFree", "str"),
  ],
  DovetailMortise: [
    a("ReferenceSide", "referenceSide"),
    a("LengthMeas", "lengthMeas"),
    a("CrossMeas", "crossMeas"),
    a("ReferenceEdge", "referenceEdge", "str"),
    a("Rotation", "rotation"),
    a("Width", "width"),
    a("Depth", "depth"),
    a("MiddlePlane", "middlePlane"),
    a("Cone", "cone"),
    a("SplinterFree", "splinterFree", "str"),
  ],
  DovetailTenon: [
    a("ReferenceSide", "referenceSide"),
    a("LengthMeas", "lengthMeas"),
    a("CrossMeas", "crossMeas"),
    a("Orientation", "orientation", "str"),
    a("Angle", "angle"),
    a("Bevel", "bevel"),
    a("Rotation", "rotation"),
    a("Length", "length"),
    a("Width", "width"),
    a("Depth", "depth"),
    a("Offset", "offset"),
    a("MiddlePlane", "middlePlane"),
    a("Cone", "cone"),
    a("SplinterFree", "splinterFree", "str"),
  ],
};

export const PART_ATTRS: AttrSpec[] = [
  a("Name", "name", "str"),
  a("PartId", "partId"),
  a("ReqQuantity", "quantity"),
  a("Unit", "unit", "str"),
  a("Grade", "grade", "str"),
  a("Profile", "profile", "str"),
  a("Comments", "comments", "str"),
  a("Dimension", "dimension", "str"),
  a("Length", "length"),
  a("Height", "height"),
  a("Width", "width"),
];
