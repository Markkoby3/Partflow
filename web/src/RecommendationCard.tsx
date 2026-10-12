import { useEffect, useState } from "react";
import type { Recommendation } from "./api";

interface Props {
  rec: Recommendation;
  onApprove: (rec: Recommendation, quantity: number) => Promise<void>;
  onReject: (rec: Recommendation, reason: string) => Promise<void>;
}

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function RecommendationCard({ rec, onApprove, onReject }: Props) {
  const [qtyText, setQtyText] = useState(String(rec.quantity));
  const [edited, setEdited] = useState(false);
  // Follow the live recommendation until the planner types their own quantity.
  useEffect(() => {
    if (!edited) setQtyText(String(rec.quantity));
  }, [rec.quantity, edited]);
  const parsed = Number.parseInt(qtyText, 10);
  const quantity = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cover = rec.daysOfCover === null ? "no recent demand" : `${rec.daysOfCover.toFixed(1)} days of cover`;
  const fromModel = rec.adviceSource.startsWith("model:");

  return (
    <article className="rec" data-risk={rec.risk} aria-labelledby={`rec-${rec.id}`}>
      <header>
        <h3 id={`rec-${rec.id}`}>
          Order <span className="num">{rec.quantity}</span> {rec.name}
        </h3>
        <p className="rec-meta">
          {rec.sku}. Position {rec.position} against a reorder point of {rec.reorderPoint}; {cover} with a{" "}
          {rec.leadTimeDays}-day lead time.
        </p>
      </header>

      <p className="rec-summary">{rec.advice.summary}</p>
      {rec.advice.risk_factors.length > 0 && (
        <ul className="rec-risks">
          {rec.advice.risk_factors.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {rec.advice.planner_note && <p className="rec-note">{rec.advice.planner_note}</p>}
      <p className="rec-source">{fromModel ? `Explained by ${rec.adviceSource.slice(6)}` : "Explained by the policy template"}</p>

      {rec.status === "approving" ? (
        <p className="rec-status">Creating purchase order…</p>
      ) : rejecting ? (
        <form
          className="rec-actions"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => onReject(rec, reason.trim()));
          }}
        >
          <label className="field">
            <span>Reason for rejecting</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} autoFocus />
          </label>
          <button type="submit" className="btn" disabled={busy || reason.trim() === ""}>
            Reject recommendation
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => setRejecting(false)} disabled={busy}>
            Keep it
          </button>
        </form>
      ) : (
        <form
          className="rec-actions"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => onApprove(rec, quantity));
          }}
        >
          <label className="field field-qty">
            <span>Quantity</span>
            <input
              type="number"
              min={1}
              inputMode="numeric"
              value={qtyText}
              onChange={(e) => {
                setEdited(true);
                setQtyText(e.target.value);
              }}
              required
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || quantity === 0}>
            Approve order of {money(quantity * rec.unitCostCents)}
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => setRejecting(true)} disabled={busy}>
            Reject
          </button>
        </form>
      )}
      {error && (
        <p className="rec-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
