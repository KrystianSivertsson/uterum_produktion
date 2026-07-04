import type { Job, Operation, Part } from "../../shared/schema.ts";
import { OP_SPECS, PART_ATTRS } from "./spec.ts";
import { escapeAttr } from "./xml.ts";

function formatNumber(value: number): string {
  return String(Math.round(value * 1e8) / 1e8);
}

function formatValue(value: unknown, kind: "num" | "str"): string {
  if (kind === "num") return formatNumber(value as number);
  return escapeAttr(String(value ?? ""));
}

function extraAttrString(extra: Record<string, string> | undefined): string {
  if (!extra) return "";
  return Object.entries(extra)
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
    .join("");
}

function operationLine(op: Operation, indent: string): string {
  if (op.type === "Generic") {
    return `${indent}<${op.tag}${extraAttrString(op.attrs)} />`;
  }
  const specs = OP_SPECS[op.type];
  const attrs = specs
    .map((spec) => ` ${spec.attr}="${formatValue((op as unknown as Record<string, unknown>)[spec.field], spec.kind)}"`)
    .join("");
  return `${indent}<${op.type}${attrs} />`;
}

function partLines(part: Part, partId: number, lines: string[]): void {
  const resolved: Record<string, unknown> = { ...part, partId: part.partId ?? partId };
  const attrs = PART_ATTRS.map((spec) => ` ${spec.attr}="${formatValue(resolved[spec.field], spec.kind)}"`).join("");
  const extra = extraAttrString(part.extraAttrs);

  if (part.operations.length === 0) {
    lines.push(`    <Part${attrs}${extra} />`);
    return;
  }
  lines.push(`    <Part${attrs}${extra}>`);
  lines.push("      <Operations>");
  for (const op of part.operations) {
    lines.push(operationLine(op, "        "));
  }
  lines.push("      </Operations>");
  lines.push("    </Part>");
}

export function writeBvx(job: Job): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push(
    `<Job BvxVersion="1.0" Operator="${escapeAttr(job.operator)}" DeliveryDate="${escapeAttr(job.deliveryDate)}"${extraAttrString(job.extraAttrs)}>`,
  );
  lines.push("  <Parts>");
  job.parts.forEach((part, index) => partLines(part, index + 1, lines));
  lines.push("  </Parts>");
  lines.push("</Job>");
  return lines.join("\r\n") + "\r\n";
}
