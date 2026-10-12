interface Props {
  onHand: number;
  onOrder: number;
  reorderPoint: number | null;
  risk: "low" | "medium" | "high" | null;
}

/**
 * One bar per part, drawn like floor marking on a plant aisle: the striped
 * zone is everything at or below the reorder point, the solid fill is stock on
 * hand and the outlined segment is stock already on order.
 */
export function StockGauge({ onHand, onOrder, reorderPoint, risk }: Props) {
  const rop = reorderPoint ?? 0;
  const max = Math.max(onHand + onOrder, rop * 2, 1);
  const pct = (n: number) => `${Math.min(100, (n / max) * 100)}%`;
  const label =
    `${onHand} on hand` + (onOrder ? `, ${onOrder} on order` : "") + (reorderPoint !== null ? `, reorder point ${rop}` : "");
  return (
    <div className="gauge" role="img" aria-label={label} data-risk={risk ?? "unknown"}>
      {reorderPoint !== null && <div className="gauge-zone" style={{ width: pct(rop) }} />}
      <div className="gauge-onhand" style={{ width: pct(onHand) }} />
      {onOrder > 0 && <div className="gauge-onorder" style={{ left: pct(onHand), width: pct(onOrder) }} />}
      {reorderPoint !== null && <div className="gauge-rop" style={{ left: pct(rop) }} />}
    </div>
  );
}
