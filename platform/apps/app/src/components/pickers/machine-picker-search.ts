import type { Host } from "@hyperfide/domain";
import { searchPickerOptions } from "./picker-search";

export const MACHINE_SEARCH_MIN_OPTIONS = 5;

export function searchMachineHosts(
  hosts: readonly Host[],
  query: string,
): readonly Host[] {
  return searchPickerOptions({
    options: hosts,
    query,
    getLabel: (host) => host.name,
    getAliases: (host) => [host.id],
  });
}
