/**
 * Minimal STEP Part 21-läsare (ISO 10303-21). Läser DATA-sektionens
 * instanser till en uppslagbar graf. Endast det som behövs för
 * solid-till-timber-analysen tolkas — okända entiteter lagras men rörs
 * inte.
 */

export interface StepRef {
  ref: number;
}

export interface StepTyped {
  type: string;
  args: StepValue[];
}

export type StepValue = number | string | boolean | null | StepRef | StepValue[] | StepTyped;

export interface StepRecord {
  type: string;
  args: StepValue[];
}

export interface StepInstance {
  id: number;
  /** Typ för enkla instanser; "" för komplexa (flerpostiga) instanser */
  type: string;
  args: StepValue[];
  /** Poster i en komplex instans: #n = ( TYP_A(...) TYP_B(...) ) */
  records: StepRecord[];
}

export function isRef(value: StepValue): value is StepRef {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "ref" in value;
}

class Cursor {
  constructor(
    readonly text: string,
    public pos = 0,
  ) {}

  skipWs(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
  }

  peek(): string {
    return this.text[this.pos];
  }
}

function parseString(cursor: Cursor): string {
  // STEP-strängar: '' är escapad apostrof
  let result = "";
  cursor.pos++; // öppnande '
  while (cursor.pos < cursor.text.length) {
    const ch = cursor.text[cursor.pos];
    if (ch === "'") {
      if (cursor.text[cursor.pos + 1] === "'") {
        result += "'";
        cursor.pos += 2;
        continue;
      }
      cursor.pos++;
      return result;
    }
    result += ch;
    cursor.pos++;
  }
  throw new Error("Oavslutad sträng i STEP-fil");
}

function parseValue(cursor: Cursor): StepValue {
  cursor.skipWs();
  const ch = cursor.peek();

  if (ch === "'") return parseString(cursor);

  if (ch === "#") {
    cursor.pos++;
    const match = /^\d+/.exec(cursor.text.slice(cursor.pos));
    if (!match) throw new Error(`Ogiltig referens vid position ${cursor.pos}`);
    cursor.pos += match[0].length;
    return { ref: Number(match[0]) };
  }

  if (ch === "(") {
    cursor.pos++;
    const list: StepValue[] = [];
    cursor.skipWs();
    if (cursor.peek() === ")") {
      cursor.pos++;
      return list;
    }
    for (;;) {
      list.push(parseValue(cursor));
      cursor.skipWs();
      if (cursor.peek() === ",") {
        cursor.pos++;
        continue;
      }
      if (cursor.peek() === ")") {
        cursor.pos++;
        return list;
      }
      throw new Error(`Väntade , eller ) vid position ${cursor.pos}`);
    }
  }

  if (ch === ".") {
    // Enum: .MILLI. / .T. / .F.
    const match = /^\.([A-Z_0-9]+)\./.exec(cursor.text.slice(cursor.pos));
    if (!match) throw new Error(`Ogiltig enum vid position ${cursor.pos}`);
    cursor.pos += match[0].length;
    if (match[1] === "T") return true;
    if (match[1] === "F") return false;
    return `.${match[1]}.`;
  }

  if (ch === "$" || ch === "*") {
    cursor.pos++;
    return null;
  }

  const numMatch = /^[+-]?(\d+\.?\d*|\.\d+)(E[+-]?\d+)?/i.exec(cursor.text.slice(cursor.pos));
  if (numMatch && /^[+-\d.]/.test(ch)) {
    cursor.pos += numMatch[0].length;
    return Number(numMatch[0]);
  }

  // Typad parameter: NAMN(arg, ...)
  const nameMatch = /^[A-Z_][A-Z_0-9]*/.exec(cursor.text.slice(cursor.pos));
  if (nameMatch) {
    cursor.pos += nameMatch[0].length;
    cursor.skipWs();
    if (cursor.peek() !== "(") throw new Error(`Väntade ( efter ${nameMatch[0]}`);
    const args = parseValue(cursor) as StepValue[];
    return { type: nameMatch[0], args };
  }

  throw new Error(`Otolkbart värde vid position ${cursor.pos}: "${cursor.text.slice(cursor.pos, cursor.pos + 30)}"`);
}

function parseInstanceBody(body: string): { type: string; args: StepValue[]; records: StepRecord[] } {
  const cursor = new Cursor(body);
  cursor.skipWs();

  if (cursor.peek() === "(") {
    // Komplex instans: ( TYP_A(...) TYP_B(...) )
    cursor.pos++;
    const records: StepRecord[] = [];
    for (;;) {
      cursor.skipWs();
      if (cursor.peek() === ")") break;
      const record = parseValue(cursor);
      if (typeof record !== "object" || record === null || Array.isArray(record) || !("type" in record)) {
        throw new Error("Väntade typad post i komplex instans");
      }
      records.push({ type: record.type, args: record.args });
    }
    return { type: "", args: [], records };
  }

  const record = parseValue(cursor);
  if (typeof record !== "object" || record === null || Array.isArray(record) || !("type" in record)) {
    throw new Error("Väntade entitet");
  }
  return { type: record.type, args: record.args, records: [{ type: record.type, args: record.args }] };
}

export class StepFile {
  readonly instances = new Map<number, StepInstance>();
  private readonly typeIndex = new Map<string, StepInstance[]>();

  add(instance: StepInstance): void {
    this.instances.set(instance.id, instance);
    for (const record of instance.records) {
      const list = this.typeIndex.get(record.type);
      if (list) {
        if (list[list.length - 1] !== instance) list.push(instance);
      } else {
        this.typeIndex.set(record.type, [instance]);
      }
    }
  }

  byType(type: string): StepInstance[] {
    return this.typeIndex.get(type) ?? [];
  }

  deref(value: StepValue): StepInstance {
    if (!isRef(value)) throw new Error(`Väntade referens, fick ${JSON.stringify(value)}`);
    const instance = this.instances.get(value.ref);
    if (!instance) throw new Error(`Referens #${value.ref} saknas i filen`);
    return instance;
  }

  /** Skala till mm utifrån filens längdenhet (mm → 1, m → 1000, ...). */
  lengthScale(): number {
    const prefixScale: Record<string, number> = {
      ".MILLI.": 1e-3,
      ".CENTI.": 1e-2,
      ".DECI.": 1e-1,
      ".KILO.": 1e3,
    };
    for (const instance of this.instances.values()) {
      const isLengthUnit = instance.records.some((record) => record.type === "LENGTH_UNIT");
      if (!isLengthUnit) continue;
      const siUnit = instance.records.find((record) => record.type === "SI_UNIT");
      if (!siUnit || siUnit.args[1] !== ".METRE.") continue;
      const prefix = typeof siUnit.args[0] === "string" ? prefixScale[siUnit.args[0]] : 1;
      return (prefix ?? 1) * 1000; // meter → mm
    }
    return 1; // ingen enhet funnen: anta mm
  }
}

/**
 * Delar upp DATA-sektionerna i instanser ( #id = ...; ) med hänsyn till
 * att strängar kan innehålla ; och #.
 */
export function parseStep(text: string): StepFile {
  const file = new StepFile();

  const dataSections: string[] = [];
  const sectionRe = /\bDATA\s*;([\s\S]*?)ENDSEC\s*;/g;
  let sectionMatch: RegExpExecArray | null;
  while ((sectionMatch = sectionRe.exec(text)) !== null) {
    dataSections.push(sectionMatch[1]);
  }
  if (dataSections.length === 0) throw new Error("Ingen DATA-sektion hittades — är detta en STEP Part 21-fil?");

  for (const section of dataSections) {
    let pos = 0;
    while (pos < section.length) {
      const hash = section.indexOf("#", pos);
      if (hash === -1) break;
      const idMatch = /^#(\d+)\s*=/.exec(section.slice(hash));
      if (!idMatch) {
        pos = hash + 1;
        continue;
      }
      // Hitta avslutande ; utanför strängar
      let cursor = hash + idMatch[0].length;
      let inString = false;
      let end = -1;
      while (cursor < section.length) {
        const ch = section[cursor];
        if (inString) {
          if (ch === "'") {
            if (section[cursor + 1] === "'") cursor++;
            else inString = false;
          }
        } else if (ch === "'") {
          inString = true;
        } else if (ch === ";") {
          end = cursor;
          break;
        }
        cursor++;
      }
      if (end === -1) throw new Error(`Instans #${idMatch[1]} saknar avslutande ;`);

      const body = section.slice(hash + idMatch[0].length, end);
      const parsed = parseInstanceBody(body);
      file.add({ id: Number(idMatch[1]), ...parsed });
      pos = end + 1;
    }
  }

  return file;
}
