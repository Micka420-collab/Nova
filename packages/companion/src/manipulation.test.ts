import { describe, expect, it } from "vitest";
import { NOMI_COPY } from "./copy";
import { collectCopyStrings, findManipulation } from "./manipulation";

describe("N11 anti-manipulation", () => {
  it("rejects the phrases Nomi never says", () => {
    for (const text of [
      "Tu m'as manqué",
      "Ça fait longtemps",
      "Tu n'as pas ouvert NOVA depuis 3 jours",
      "Reviens vite",
      "Nomi est triste",
      "Désolé, je suis nul",
      "Bravo, tu es rapide",
      "Tu as gagné 3 étoiles",
      "Ta série continue",
      "Prêt pour la production",
      "Terminé !",
      "Dernière chance",
      "Je pense que le bug vient d'ici",
    ]) {
      expect({ text, reasons: findManipulation(text).length > 0 }).toEqual({ text, reasons: true });
    }
  });

  it("does not flag ordinary words that contain a forbidden one", () => {
    expect(findManipulation("Évite les séquences inutiles ; le serveur a planté.")).toEqual([]);
    expect(findManipulation("Rien de nouveau depuis hier.")).toEqual([]);
  });

  it("all Nomi copy passes (every string and every template with sample values)", () => {
    const strings = collectCopyStrings(NOMI_COPY, "NOMI_COPY");
    expect(strings.length).toBeGreaterThan(100);
    const offenders = strings
      .map(({ path, text }) => ({ path, text, reasons: findManipulation(text) }))
      .filter(({ reasons }) => reasons.length > 0);
    expect(offenders).toEqual([]);
  });
});
