// Loads a demo plant: suppliers, 12 EV parts, and 28 days of backfilled line consumption.
//   INVENTORY_URL=http://localhost:8080 npx tsx scripts/seed.ts
// Safe to re-run: suppliers upsert, existing parts are skipped, and every
// historical movement carries a deterministic idempotency key.

const BASE = process.env.INVENTORY_URL ?? "http://localhost:8080";
const DAYS = 28;

const suppliers = [
  { id: "SUP-CELLS", name: "Northline Cells", leadTimeDays: 21 },
  { id: "SUP-METAL", name: "Great Lakes Stamping", leadTimeDays: 7 },
  { id: "SUP-ELEC", name: "Prairie Electronics", leadTimeDays: 14 },
  { id: "SUP-TRIM", name: "Ridgeway Interiors", leadTimeDays: 10 },
  { id: "SUP-DRIVE", name: "Summit Drive Systems", leadTimeDays: 12 },
];

// mean = typical units consumed per day; onHand chosen so some parts start near their reorder point.
const parts = [
  { id: "BM-4680", sku: "BM-4680-A", name: "Battery module", supplierId: "SUP-CELLS", unitCostCents: 125_000, safetyStock: 40, mean: 18, cv: 0.25, onHand: 520 },
  { id: "BMS-200", sku: "BMS-200-C", name: "Battery management board", supplierId: "SUP-ELEC", unitCostCents: 18_500, safetyStock: 25, mean: 9, cv: 0.3, onHand: 300 },
  { id: "DU-QUAD", sku: "DU-Q-110", name: "Quad-motor drive unit", supplierId: "SUP-DRIVE", unitCostCents: 410_000, safetyStock: 8, mean: 4, cv: 0.2, onHand: 46 },
  { id: "BRG-6205", sku: "BRG-6205-2RS", name: "Drive unit bearing", supplierId: "SUP-DRIVE", unitCostCents: 1_400, safetyStock: 60, mean: 32, cv: 0.35, onHand: 1_400 },
  { id: "HV-HARN", sku: "HV-HARN-07", name: "High-voltage harness", supplierId: "SUP-ELEC", unitCostCents: 62_000, safetyStock: 20, mean: 9, cv: 0.4, onHand: 120 },
  { id: "INV-SIC", sku: "INV-SIC-3", name: "SiC inverter", supplierId: "SUP-ELEC", unitCostCents: 290_000, safetyStock: 10, mean: 5, cv: 0.3, onHand: 110 },
  { id: "SF-DRV", sku: "SF-DRV-L", name: "Seat frame, driver", supplierId: "SUP-TRIM", unitCostCents: 21_000, safetyStock: 15, mean: 9, cv: 0.2, onHand: 260 },
  { id: "SF-PAS", sku: "SF-PAS-R", name: "Seat frame, passenger", supplierId: "SUP-TRIM", unitCostCents: 19_500, safetyStock: 15, mean: 9, cv: 0.2, onHand: 95 },
  { id: "DP-ALU", sku: "DP-ALU-FL", name: "Door panel, aluminum", supplierId: "SUP-METAL", unitCostCents: 34_000, safetyStock: 20, mean: 18, cv: 0.15, onHand: 300 },
  { id: "TB-ROOF", sku: "TB-ROOF-X", name: "Roof crossmember", supplierId: "SUP-METAL", unitCostCents: 9_800, safetyStock: 10, mean: 9, cv: 0.25, onHand: 70 },
  { id: "CAM-ADAS", sku: "CAM-ADAS-11", name: "ADAS camera", supplierId: "SUP-ELEC", unitCostCents: 7_600, safetyStock: 50, mean: 99, cv: 0.2, onHand: 2_900 },
  { id: "LMP-HEAD", sku: "LMP-HEAD-LED", name: "Headlamp assembly", supplierId: "SUP-TRIM", unitCostCents: 48_000, safetyStock: 12, mean: 18, cv: 0.3, onHand: 520 },
];

// Deterministic PRNG so every seed produces the same history.
let state = 20261012;
const rand = () => ((state = (state * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());

async function call(method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

for (const s of suppliers) await call("PUT", `/v1/suppliers/${s.id}`, { name: s.name, leadTimeDays: s.leadTimeDays });

let moves = 0;
for (const p of parts) {
  // Opening balance = today's target on-hand plus everything the history will consume.
  const history = Array.from({ length: DAYS }, () => Math.max(0, Math.round(p.mean * (1 + p.cv * gauss()))));
  const consumed = history.reduce((a, b) => a + b, 0);
  const created = await call("POST", "/v1/parts", {
    id: p.id,
    sku: p.sku,
    name: p.name,
    supplierId: p.supplierId,
    unitCostCents: p.unitCostCents,
    safetyStock: p.safetyStock,
    initialOnHand: p.onHand + consumed,
  });
  if (created.status === 409) {
    console.log(`skip ${p.id} (exists)`);
    continue;
  }
  if (created.status !== 201) throw new Error(`creating ${p.id} failed: ${JSON.stringify(created.body)}`);
  for (let d = 0; d < DAYS; d++) {
    const qty = history[d]!;
    if (qty === 0) continue;
    const when = new Date(Date.now() - (DAYS - d) * 86_400_000);
    when.setUTCHours(14, 0, 0, 0);
    const r = await call(
      "POST",
      "/v1/stock/movements",
      { partId: p.id, kind: "consumption", quantity: qty, reference: "Line consumption (history)", occurredAt: when.toISOString() },
      { "idempotency-key": `seed-${p.id}-${d}` },
    );
    if (r.status !== 201 && r.status !== 200) throw new Error(`movement failed: ${JSON.stringify(r.body)}`);
    moves++;
  }
  console.log(`seeded ${p.id}`);
}
console.log(`done: ${parts.length} parts, ${moves} historical movements`);
