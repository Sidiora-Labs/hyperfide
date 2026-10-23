import type { HyperfideProjectOption } from "../../shared/contract.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NO_LINK = "__none__";

export function HyperfideProjectLinkPicker({
  value,
  onChange,
  hyperfideProjects,
  noneLabel = "Not linked",
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  hyperfideProjects: readonly HyperfideProjectOption[];
  noneLabel?: string;
}) {
  const unavailableSelection =
    value !== null && !hyperfideProjects.some((project) => project.id === value)
      ? value
      : null;
  return (
    <Select
      value={value ?? NO_LINK}
      onValueChange={(next) => onChange(next === NO_LINK ? null : next)}
    >
      <SelectTrigger aria-label="Linked hyperfide-platform project" className="h-8">
        <SelectValue>
          {hyperfideProjects.find((project) => project.id === value)?.name ??
            unavailableSelection ??
            noneLabel}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_LINK}>{noneLabel}</SelectItem>
        {unavailableSelection !== null ? (
          <SelectItem value={unavailableSelection}>
            Unavailable · {unavailableSelection}
          </SelectItem>
        ) : null}
        {hyperfideProjects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
