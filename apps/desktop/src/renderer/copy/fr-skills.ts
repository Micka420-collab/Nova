// French copy of lane L3 (skills). Owned by L3.
export const skillsCopy = {
  display: {
    loaded: (name: string) => `Skill « ${name} » chargée`,
    file: (path: string) => `Fichier ${path}`,
    size: (chars: string) => `${chars} caractères`,
  },
} as const;
