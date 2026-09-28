// L4 — « Chaîne » switch of the mission contract (MissionContract.harness.chain), with what it
// allows and what still applies. Rendered only when the mission's mode can offer run_chain: the
// sheet never shows a switch that would do nothing. Owned by L4; mounted by ContractSheet.
import { Switch } from "@nova/ui";
import { CHAIN_LIMITS } from "@nova/shared";
import { chainCopy } from "../../../copy/fr-chain";

const copy = chainCopy.option;

export interface ChainOptionProps {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  /** false when the mission's mode cannot offer run_chain (e.g. Discuter): nothing is rendered. */
  available: boolean;
}

export function ChainOption({ checked, onCheckedChange, available }: ChainOptionProps) {
  if (!available) return null;
  return (
    <div className="nova-contract__option">
      <Switch label={copy.label} description={copy.description} checked={checked} onCheckedChange={onCheckedChange} />
      <p className="nova-note">{copy.limits(CHAIN_LIMITS.maxToolCalls, CHAIN_LIMITS.timeoutMs / 60_000)}</p>
    </div>
  );
}
