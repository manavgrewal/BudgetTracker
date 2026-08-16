# Fixtures — PLACEHOLDERS

Every CSV in this folder is an **invented placeholder** that imitates the shape of a real
Canadian bank export. None of it is real account data.

Replace each file with a scrubbed export from the corresponding real account before trusting
the built-in presets: download the real CSV, delete or fuzz the balance/reference columns and
any personal names, keep the column layout and date format exactly as the bank emits them,
then overwrite the file here. The parser tests will immediately tell you whether the preset in
`src/lib/import/presets.ts` still matches.

| File | Preset it validates |
|---|---|
| `td-chequing.csv` | TD Chequing/Debit |
| `td-visa.csv` | TD Visa |
| `scotia.csv` | Scotiabank Chequing/Debit |
| `amex.csv` | Amex Canada (quoted multi-line fields) |
| `td-chequing-win1252.csv` | encoding fallback — generated, not hand-edited (see below) |
| `mint-like-edge-cases.csv` | row-level error handling |

`td-chequing-win1252.csv` holds windows-1252 bytes and must be regenerated rather than edited
in a UTF-8 editor:

```
npm run fixtures
```
