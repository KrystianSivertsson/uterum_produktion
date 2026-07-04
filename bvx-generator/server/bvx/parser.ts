import type { Job, Operation, Part } from "../../shared/schema.ts";
import { OP_SPECS, PART_ATTRS, type AttrSpec } from "./spec.ts";
import { parseXml, type XmlElement } from "./xml.ts";

interface MappedAttrs {
  fields: Record<string, unknown>;
  extra: Record<string, string>;
}

/**
 * Mappar elementattribut mot en spec-tabell. Attribut som inte finns i
 * tabellen hamnar i `extra` så att de kan skrivas tillbaka oförändrade.
 * Returnerar null om ett numeriskt attribut inte går att tolka.
 */
function mapAttrs(element: XmlElement, specs: AttrSpec[]): MappedAttrs | null {
  const bySpecAttr = new Map(specs.map((spec) => [spec.attr, spec]));
  const fields: Record<string, unknown> = {};
  const extra: Record<string, string> = {};

  for (const [name, raw] of Object.entries(element.attrs)) {
    const spec = bySpecAttr.get(name);
    if (!spec) {
      extra[name] = raw;
      continue;
    }
    if (spec.kind === "num") {
      const value = Number(raw);
      if (Number.isNaN(value)) return null;
      fields[spec.field] = value;
    } else {
      fields[spec.field] = raw;
    }
  }
  return { fields, extra };
}

function parseOperation(element: XmlElement): Operation {
  const specs = OP_SPECS[element.tag];
  if (specs) {
    const mapped = mapAttrs(element, specs);
    const hasAllFields = mapped && specs.every((spec) => spec.field in mapped.fields);
    if (mapped && hasAllFields && Object.keys(mapped.extra).length === 0) {
      return { type: element.tag, ...mapped.fields } as Operation;
    }
  }
  // Okänd operation, okända attribut eller otolkbara värden: bevara
  // elementet ordagrant i stället för att gissa.
  return { type: "Generic", tag: element.tag, attrs: { ...element.attrs } };
}

function parsePart(element: XmlElement): Part {
  const mapped = mapAttrs(element, PART_ATTRS);
  if (!mapped) {
    throw new Error(`Otolkbart numeriskt attribut i <Part>: ${JSON.stringify(element.attrs)}`);
  }
  for (const required of ["name", "length", "height", "width"]) {
    if (!(required in mapped.fields)) {
      throw new Error(`<Part> saknar attribut för fältet "${required}"`);
    }
  }

  const operationsElement = element.children.find((child) => child.tag === "Operations");
  const operations = (operationsElement?.children ?? []).map(parseOperation);

  const part: Part = {
    quantity: 1,
    unit: "",
    grade: "",
    profile: "",
    comments: "",
    dimension: "",
    ...(mapped.fields as Pick<Part, "name" | "length" | "height" | "width">),
    operations,
  };
  if (Object.keys(mapped.extra).length > 0) part.extraAttrs = mapped.extra;
  return part;
}

export function parseBvx(text: string): Job {
  const root = parseXml(text);
  if (root.tag !== "Job") {
    throw new Error(`Väntade <Job> som rotelement, hittade <${root.tag}>`);
  }

  const { BvxVersion: _version, Operator, DeliveryDate, ...rest } = root.attrs;
  const partsElement = root.children.find((child) => child.tag === "Parts");
  const parts = (partsElement?.children ?? []).filter((child) => child.tag === "Part").map(parsePart);

  const job: Job = {
    operator: Operator ?? "",
    deliveryDate: DeliveryDate ?? "",
    parts,
  };
  if (Object.keys(rest).length > 0) job.extraAttrs = rest;
  return job;
}
