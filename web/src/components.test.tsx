import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Recommendation } from "./api";
import { RecommendationCard } from "./RecommendationCard";
import { StockGauge } from "./StockGauge";

const rec: Recommendation = {
  id: "rec-1",
  partId: "P-100",
  sku: "BM-4680-A",
  name: "Battery module",
  status: "pending",
  quantity: 240,
  reorderPoint: 300,
  position: 180,
  onHand: 180,
  onOrder: 0,
  daysOfCover: 6.2,
  leadTimeDays: 14,
  unitCostCents: 125000,
  risk: "high",
  advice: { summary: "Cover runs out before the next delivery.", risk_factors: ["Lead time exceeds cover"], planner_note: "" },
  adviceSource: "template",
  createdAt: "2026-10-12T12:00:00Z",
};

describe("StockGauge", () => {
  it("describes stock, open orders and the reorder point for screen readers", () => {
    render(<StockGauge onHand={80} onOrder={40} reorderPoint={120} risk="medium" />);
    expect(screen.getByRole("img")).toHaveAccessibleName("80 on hand, 40 on order, reorder point 120");
  });
});

describe("RecommendationCard", () => {
  it("approves with an edited quantity and shows the order value", async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    render(<RecommendationCard rec={rec} onApprove={onApprove} onReject={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Order 240 Battery module" })).toBeInTheDocument();
    const qty = screen.getByLabelText("Quantity");
    await userEvent.clear(qty);
    await userEvent.type(qty, "200");
    await userEvent.click(screen.getByRole("button", { name: "Approve order of $250,000" }));
    expect(onApprove).toHaveBeenCalledWith(rec, 200);
  });

  it("requires a reason to reject and surfaces API errors", async () => {
    const onReject = vi.fn().mockRejectedValue(new Error("Recommendation is no longer pending"));
    render(<RecommendationCard rec={rec} onApprove={vi.fn()} onReject={onReject} />);
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    const submit = screen.getByRole("button", { name: "Reject recommendation" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Reason for rejecting"), "Line 2 down for retooling");
    await userEvent.click(submit);
    expect(onReject).toHaveBeenCalledWith(rec, "Line 2 down for retooling");
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer pending");
  });
});
