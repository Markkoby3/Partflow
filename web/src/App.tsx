import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Assessment, type Movement, type Part, type PurchaseOrder, type Recommendation } from "./api";
import { RecommendationCard } from "./RecommendationCard";
import { StockGauge } from "./StockGauge";

const PLANNER = "planner@plant";
const RISK_ORDER = { high: 0, medium: 1, low: 2 } as const;

/** Today's movements show a time; older ones show the date. */
function when(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

type Live = "connecting" | "live" | "offline";

interface Data {
  parts: Part[];
  assessments: Map<string, Assessment>;
  recommendations: Recommendation[];
  movements: Movement[];
  orders: PurchaseOrder[];
}

const EMPTY: Data = { parts: [], assessments: new Map(), recommendations: [], movements: [], orders: [] };

function useLiveData() {
  const [data, setData] = useState<Data>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Live>("connecting");
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const [parts, movements, orders] = await Promise.all([api.parts(), api.movements(), api.openOrders()]);
      // The reorder service can lag the inventory API by a moment (it reads from Kafka), and may be down;
      // the stock view still works without it.
      const [assessments, recommendations] = await Promise.all([
        api.assessments().catch(() => [] as Assessment[]),
        api.recommendations().catch(() => [] as Recommendation[]),
      ]);
      setData({ parts, movements, orders, recommendations, assessments: new Map(assessments.map((a) => [a.partId, a])) });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  // Coalesce bursts of change events into one refresh, then one more shortly after
  // so recommendations produced downstream by the consumer show up too.
  const schedule = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void refresh();
      timer.current = window.setTimeout(() => void refresh(), 1500);
    }, 250);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const es = new EventSource(api.streamUrl);
    es.onopen = () => setLive("live");
    es.onerror = () => setLive("offline");
    es.addEventListener("change", schedule);
    const poll = window.setInterval(() => void refresh(), 15_000);
    return () => {
      es.close();
      window.clearInterval(poll);
      window.clearTimeout(timer.current);
    };
  }, [refresh, schedule]);

  return { data, error, live, loaded, refresh };
}

export function App() {
  const { data, error, live, loaded, refresh } = useLiveData();
  const [shiftRunning, setShiftRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const pending = data.recommendations.filter((r) => r.status === "pending" || r.status === "approving");
  const partName = useMemo(() => new Map(data.parts.map((p) => [p.id, p.name])), [data.parts]);

  const rows = useMemo(() => {
    return [...data.parts].sort((a, b) => {
      const ra = data.assessments.get(a.id)?.risk ?? "low";
      const rb = data.assessments.get(b.id)?.risk ?? "low";
      return RISK_ORDER[ra] - RISK_ORDER[rb] || a.sku.localeCompare(b.sku);
    });
  }, [data.parts, data.assessments]);

  const atRisk = rows.filter((p) => data.assessments.get(p.id)?.reorder).length;

  async function runShift() {
    setShiftRunning(true);
    setNotice(null);
    let used = 0;
    let short = 0;
    for (const p of data.parts) {
      const mean = data.assessments.get(p.id)?.demand.meanPerDay ?? 10;
      const qty = Math.max(1, Math.round(mean * (0.6 + Math.random() * 0.9)));
      try {
        await api.consume(p.id, qty, "Production shift");
        used += 1;
      } catch {
        short += 1;
      }
    }
    setShiftRunning(false);
    setNotice(short ? `Shift recorded for ${used} parts; ${short} parts were short of stock.` : `Shift recorded for ${used} parts.`);
    void refresh();
  }

  async function approve(rec: Recommendation, quantity: number) {
    await api.approve(rec.id, PLANNER, quantity);
    setNotice(`Approved: purchase order for ${quantity} ${rec.name} created.`);
    await refresh();
  }

  async function reject(rec: Recommendation, reason: string) {
    await api.reject(rec.id, PLANNER, reason);
    setNotice(`Rejected the order for ${rec.name}.`);
    await refresh();
  }

  async function receive(po: PurchaseOrder) {
    try {
      await api.receive(po.id);
      setNotice(`Received ${po.quantity} ${partName.get(po.partId) ?? po.partId}.`);
    } catch (err) {
      setNotice(`Couldn't receive that order: ${err instanceof Error ? err.message : String(err)}`);
    }
    await refresh();
  }

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <h1>PartFlow</h1>
          <p>Material planning, Plant 1</p>
        </div>
        <p className={`live live-${live}`} aria-live="polite">
          {live === "live" ? "Live" : live === "connecting" ? "Connecting" : "Reconnecting"}
        </p>
        <button className="btn btn-primary" onClick={() => void runShift()} disabled={shiftRunning || data.parts.length === 0}>
          {shiftRunning ? "Recording shift…" : "Run production shift"}
        </button>
      </header>

      {error && (
        <p className="banner banner-error" role="alert">
          Can't reach the inventory API: {error}. Check that it is running, then this page will retry.
        </p>
      )}
      {notice && (
        <p className="banner" role="status">
          {notice}
        </p>
      )}

      <main className="grid">
        <section className="parts" aria-labelledby="parts-h">
          <div className="section-head">
            <h2 id="parts-h">Stock</h2>
            <p>
              {data.parts.length} parts, {atRisk} at or below reorder point
            </p>
          </div>
          {loaded && data.parts.length === 0 && !error ? (
            <p className="empty">No parts yet. Load the demo plant with <code>npm run seed</code> in services/inventory-api.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Part</th>
                  <th scope="col" className="col-gauge">
                    Stock against reorder point
                  </th>
                  <th scope="col" className="col-n">
                    On hand
                  </th>
                  <th scope="col" className="col-n">
                    Cover
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const a = data.assessments.get(p.id);
                  return (
                    <tr key={p.id} data-risk={a?.risk ?? "unknown"}>
                      <th scope="row">
                        <span className="part-name">{p.name}</span>
                        <span className="part-sub">
                          {p.sku}, {p.supplierName}, {p.leadTimeDays}-day lead time
                        </span>
                      </th>
                      <td className="col-gauge">
                        <StockGauge onHand={p.onHand} onOrder={p.onOrder} reorderPoint={a?.reorderPoint ?? null} risk={a?.risk ?? null} />
                      </td>
                      <td className="col-n num col-onhand">
                        {p.onHand}
                        {p.onOrder > 0 && <span className="sub-num">+{p.onOrder}</span>}
                      </td>
                      <td className="col-n num">{a?.daysOfCover == null ? "–" : `${a.daysOfCover.toFixed(0)}d`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <aside className="queue" aria-labelledby="queue-h">
          <div className="section-head">
            <h2 id="queue-h">Needs a decision</h2>
            <p>{pending.length === 0 ? "Nothing to approve" : `${pending.length} reorder ${pending.length === 1 ? "recommendation" : "recommendations"}`}</p>
          </div>
          {pending.length === 0 ? (
            <p className="empty">
              When a part's stock plus open orders falls to its reorder point, a recommendation appears here with the
              quantity and the reasoning.
            </p>
          ) : (
            pending.map((r) => <RecommendationCard key={r.id} rec={r} onApprove={approve} onReject={reject} />)
          )}

          {data.orders.length > 0 && (
            <>
              <div className="section-head">
                <h2>Open purchase orders</h2>
              </div>
              <ul className="orders">
                {data.orders.map((po) => (
                  <li key={po.id}>
                    <span>
                      <span className="num">{po.quantity}</span> {partName.get(po.partId) ?? po.partId}
                      {po.source === "ai_recommendation" && <span className="tag">from recommendation</span>}
                    </span>
                    <button className="btn btn-quiet" onClick={() => void receive(po)}>
                      Receive
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>

        <section className="log" aria-labelledby="log-h">
          <div className="section-head">
            <h2 id="log-h">Latest movements</h2>
          </div>
          <ol className="moves">
            {data.movements.map((m) => (
              <li key={m.id} data-kind={m.kind}>
                <time dateTime={m.occurredAt}>{when(m.occurredAt)}</time>
                <span className="num move-q">{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</span>
                <span>{partName.get(m.partId) ?? m.partId}</span>
                <span className="move-ref">{(m.reference ?? m.kind).replace(/^PO ([0-9a-f]{8})-[0-9a-f-]+$/, "PO $1")}</span>
              </li>
            ))}
          </ol>
        </section>
      </main>
    </div>
  );
}
