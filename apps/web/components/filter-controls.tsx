"use client";

import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/** A labelled control. Every input says what it is. */
export function Field({
  label,
  hint,
  htmlFor,
  className,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-1", className)}>
      <Label
        htmlFor={htmlFor}
        className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
      >
        {label}
      </Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A row of options, all visible, one click each.
 *
 * These replaced `Select`s inside popovers, where a dropdown escapes the
 * popover's bounds and renders over the edge. For a handful of choices a
 * dropdown also hides the options and costs two clicks.
 */
export function Choices({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value || "__all__"}
      // Radix clears the value when the active item is clicked again; hold the
      // current one rather than dropping into an unrepresentable empty state.
      onValueChange={(v) => onChange(v === "__all__" ? "" : v || value)}
      className={cn("flex flex-wrap justify-start gap-1", className)}
      variant="outline"
      size="sm"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value || "__all__"}
          value={o.value || "__all__"}
          className="h-7 rounded-md border px-2 text-xs data-[state=on]:border-primary data-[state=on]:bg-primary/10"
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
