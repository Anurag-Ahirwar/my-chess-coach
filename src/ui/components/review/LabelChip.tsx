import type { Label } from "@/core/classify";
import { LABEL_INFO } from "@/ui/review/presentation";

/** A move label: colour + symbol + name (never colour alone). Experimental labels say so. */
export function LabelChip({ label, size = "sm" }: { label: Label; size?: "xs" | "sm" }) {
  const info = LABEL_INFO[label];
  return (
    <span
      className={`label-chip ${info.className} inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 font-semibold leading-5 ${size === "xs" ? "text-[11px]" : "text-xs"}`}
      data-label={label}
    >
      <span aria-hidden="true">{info.symbol}</span>
      <span>{info.name}</span>
      {info.experimental && <span className="font-normal opacity-90">(experimental)</span>}
    </span>
  );
}
