import fs from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';

const root = path.resolve(import.meta.dirname, '..');

const rows = [
  '03/02/2026,POS PURCHASE       CAFÉ RÉPUBLIQUE MONTREAL QC,12.75,,1000.00',
  '03/03/2026,INTERAC PURCHASE 9910 MÉTRO PLUS #221 LAVAL QC,64.20,,935.80',
  '03/04/2026,PRE-AUTH HYDRO-QUÉBEC,88.10,,847.70',
  '',
].join('\r\n');

const target = path.join(root, 'fixtures', 'td-chequing-win1252.csv');
fs.writeFileSync(target, iconv.encode(rows, 'win1252'));
console.log(`wrote ${target} (${fs.statSync(target).size} bytes, windows-1252)`);
