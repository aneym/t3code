import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const skeletonVariants = cva("bg-muted-foreground/15", {
  variants: {
    shape: {
      block: "rounded-sm",
      card: "rounded-lg",
      pill: "rounded-full",
    },
    motion: {
      pulse: "motion-safe:animate-skeleton",
      still: "",
    },
  },
  defaultVariants: { shape: "block", motion: "pulse" },
});

function Skeleton({
  className,
  shape,
  motion,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof skeletonVariants>) {
  return (
    <div
      className={cn(skeletonVariants({ shape, motion }), className)}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };
