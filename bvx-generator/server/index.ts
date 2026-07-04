import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jobSchema } from "../shared/schema.ts";
import { stepToParts } from "./step/solidToTimber.ts";
import { writeBvx } from "./bvx/writer.ts";
import { writeBtl } from "./btl/writer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 5175);

const app = express();
app.use(express.static(join(here, "..", "client")));

/** Rå STEP-text in → jobb + varningar ut */
app.post("/api/import-step", express.text({ type: () => true, limit: "200mb" }), (req, res) => {
  try {
    if (typeof req.body !== "string" || req.body.trim() === "") {
      res.status(400).json({ error: "Ingen filinnehåll mottaget" });
      return;
    }
    const { parts, warnings } = stepToParts(req.body);
    const job = jobSchema.parse({ parts });
    res.json({ job, warnings });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Jobb + format in → maskinfilens innehåll ut */
app.post("/api/export", express.json({ limit: "50mb" }), (req, res) => {
  const format = req.body?.format;
  if (format !== "bvx" && format !== "btl") {
    res.status(400).json({ error: 'format måste vara "bvx" eller "btl"' });
    return;
  }
  const parsed = jobSchema.safeParse(req.body?.job);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(rot)"}: ${issue.message}`);
    res.status(400).json({ error: "Ogiltigt jobb", issues });
    return;
  }
  if (format === "bvx") {
    res.json({ content: writeBvx(parsed.data), warnings: [] });
  } else {
    const btl = writeBtl(parsed.data, { projectName: String(req.body?.name ?? "") });
    res.json({ content: btl.text, warnings: btl.warnings });
  }
});

app.listen(port, () => {
  console.log(`StommarBTL kör på http://localhost:${port}`);
});
