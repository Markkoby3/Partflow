// Load test: concurrent consumption against one hot part plus spread across many parts.
//   INVENTORY_URL=http://localhost:8080 npx tsx bench/stock-movements.ts
// Each request is a full transaction: row lock, stock update, movement insert,
// outbox insert and NOTIFY.
import autocannon from "autocannon";

const BASE = process.env.INVENTORY_URL ?? "http://localhost:8080";
const DURATION = Number(process.env.DURATION ?? 15);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50);
const PARTS = 20;

async function call(method: string, path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status >= 400 && res.status !== 409) throw new Error(`${path}: ${res.status} ${await res.text()}`);
}

await call("PUT", "/v1/suppliers/SUP-BENCH", { name: "Bench supplier", leadTimeDays: 7 });
const run = Date.now().toString(36);
const ids = Array.from({ length: PARTS }, (_, i) => `BENCH-${run}-${i}`);
for (const id of ids) {
  await call("POST", "/v1/parts", { id, sku: id, name: "Bench part", supplierId: "SUP-BENCH", unitCostCents: 100, initialOnHand: 100_000_000 });
}

async function scenario(title: string, pick: () => string) {
  const result = await autocannon({
    url: `${BASE}/v1/stock/movements`,
    method: "POST",
    connections: CONNECTIONS,
    duration: DURATION,
    headers: { "content-type": "application/json" },
    requests: [{ setupRequest: (req) => ({ ...req, body: JSON.stringify({ partId: pick(), kind: "consumption", quantity: 1 }) }) }],
  });
  const ok = result["2xx"];
  console.log(
    `${title}: ${Math.round(ok / DURATION)} movements/s, p50 ${result.latency.p50} ms, p99 ${result.latency.p99} ms, ` +
      `${result.non2xx} non-2xx, ${result.errors} errors (${CONNECTIONS} connections, ${DURATION}s)`,
  );
}

let n = 0;
await scenario(`spread over ${PARTS} parts`, () => ids[n++ % PARTS]!);
await scenario("single hot part (worst-case lock contention)", () => ids[0]!);
