// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "@hyperfide/shared-ui/button";
import {
  ResourceCollectionPage,
  ResourceFilterMenu,
  ResourceMeta,
} from "@hyperfide/shared-ui/resource-list";
import type { FormEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
});

describe("shared resource components", () => {
  it("keeps an unspecified Button out of form submission", () => {
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <Button>Save</Button>
      </form>,
    );

    const button = screen.getByRole("button", { name: "Save" });
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("retains numeric zero in resource metadata", () => {
    render(<ResourceMeta items={[0, "Updated"]} />);

    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.getByText("Updated")).toBeTruthy();
  });

  it("does not render a filter control when every group is empty", () => {
    render(
      <ResourceFilterMenu
        groups={[
          {
            id: "empty",
            label: "Empty",
            options: [],
            selectedValues: [],
            onChange: vi.fn(),
          },
        ]}
      />,
    );

    expect(screen.queryByRole("button", { name: "Filters" })).toBeNull();
  });

  it("gives collection tabs a visible keyboard focus style", () => {
    render(
      <ResourceCollectionPage
        id="resources"
        description="Resource collection"
        modes={[
          { id: "all", label: "All" },
          { id: "owned", label: "Owned" },
        ]}
        activeMode="all"
        onModeChange={vi.fn()}
      >
        <div>Resources</div>
      </ResourceCollectionPage>,
    );

    const tab = screen.getByRole("tab", { name: "All" });
    expect(tab.className).toContain("focus-visible:outline-none");
    expect(tab.className).toContain("focus-visible:ring-1");
  });
});
