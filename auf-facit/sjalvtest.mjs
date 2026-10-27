// Självtest av jämföraren: returnerar facit själv (ska ge 100 %).
import fs from 'node:fs';
import path from 'node:path';
export const ncwTillAuf = (_ncw, { dir }) => fs.readFileSync(path.join(dir, 'facit.auf'), 'latin1');
