import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SubmissionDisplay } from "./SubmissionDisplay";

afterEach(cleanup);

describe("SubmissionDisplay", () => {
  it("names the sub-mission, its reserved budget and where its work goes", () => {
    render(<SubmissionDisplay display={{ kind: "submission", childMissionId: "c", title: "Écrire les tests", reservedUsd: 0.2, integration: null }} />);
    expect(screen.getByText(/Sous-mission « Écrire les tests » · budget réservé : 0,20.*travaille dans sa propre copie du projet/)).toBeTruthy();
  });

  it("says unknown for an unknown budget and read-only for a child with nothing to integrate", () => {
    render(<SubmissionDisplay display={{ kind: "submission", childMissionId: "c", title: "Explorer", reservedUsd: null, integration: "not_needed" }} />);
    expect(screen.getByText(/budget réservé : inconnu · lecture seule/)).toBeTruthy();
  });
});
