import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Skeleton } from "./skeleton";

describe("Skeleton", () => {
  it("renders a pulsing placeholder and merges custom classes", () => {
    const { container } = render(<Skeleton className="h-4 w-4" />);
    const el = container.firstElementChild;
    expect(el).not.toBeNull();
    expect(el?.className).toContain("animate-pulse");
    expect(el?.className).toContain("h-4");
  });
});
