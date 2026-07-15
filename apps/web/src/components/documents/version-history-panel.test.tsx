import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@sync-flow/schemas";
import { VersionHistoryPanel } from "./version-history-panel";
import type { VersionListItem } from "@sync-flow/schemas";

const useVersionsInfinite = vi.fn();
const useRestoreVersion = vi.fn();
vi.mock("@/hooks/use-document-versions", () => ({
  useVersionsInfinite: (...args: unknown[]) => useVersionsInfinite(...args),
  useRestoreVersion: (...args: unknown[]) => useRestoreVersion(...args),
  useVersionPreview: () => ({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() }),
}));

function makeVersion(overrides: Partial<VersionListItem> = {}): VersionListItem {
  return {
    version: 5,
    createdAt: new Date().toISOString(),
    kind: "auto",
    label: null,
    createdBy: "user-1",
    preview: "Hello World",
    textLength: 11,
    truncated: false,
    contributors: [{ userId: "user-1", displayName: "Ada Lovelace" }],
    ...overrides,
  };
}

describe("VersionHistoryPanel", () => {
  const restoreMutate = vi.fn();

  beforeEach(() => {
    useVersionsInfinite.mockReset();
    useRestoreVersion.mockReset();
    restoreMutate.mockClear();
    useRestoreVersion.mockReturnValue({ mutate: restoreMutate, isPending: false });
  });

  it("shows the empty state when there are no versions", () => {
    useVersionsInfinite.mockReturnValue({
      data: { pages: [{ versions: [], nextCursor: null }] },
      isLoading: false,
      isError: false,
      hasNextPage: false,
    });

    render(
      <VersionHistoryPanel documentId="doc-1" open onOpenChange={vi.fn()} canRestore={false} />,
    );

    expect(
      screen.getByText("No versions yet — versions are saved automatically every 100 edits"),
    ).toBeInTheDocument();
  });

  it("shows an error state with retry", async () => {
    const refetch = vi.fn();
    useVersionsInfinite.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new ApiError({ type: "about:blank", title: "Server Error", status: 500 }),
      refetch,
      hasNextPage: false,
    });

    const user = userEvent.setup();
    render(
      <VersionHistoryPanel documentId="doc-1" open onOpenChange={vi.fn()} canRestore={false} />,
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("lists versions with contributor avatars and a View button", () => {
    useVersionsInfinite.mockReturnValue({
      data: { pages: [{ versions: [makeVersion()], nextCursor: null }] },
      isLoading: false,
      isError: false,
      hasNextPage: false,
    });

    render(
      <VersionHistoryPanel documentId="doc-1" open onOpenChange={vi.fn()} canRestore={false} />,
    );

    expect(screen.getByText("Hello World")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
    expect(screen.getByTitle("Ada Lovelace")).toBeInTheDocument();
  });

  it("shows the preview pane placeholder until a version is selected, then shows the preview after View", async () => {
    useVersionsInfinite.mockReturnValue({
      data: { pages: [{ versions: [makeVersion()], nextCursor: null }] },
      isLoading: false,
      isError: false,
      hasNextPage: false,
    });

    const user = userEvent.setup();
    render(
      <VersionHistoryPanel documentId="doc-1" open onOpenChange={vi.fn()} canRestore={false} />,
    );

    expect(screen.getByText("Select a version to preview it here.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(
      screen.queryByText("Select a version to preview it here."),
    ).not.toBeInTheDocument();
  });

  it("only shows the restore button when canRestore is true and a version is selected", async () => {
    useVersionsInfinite.mockReturnValue({
      data: { pages: [{ versions: [makeVersion()], nextCursor: null }] },
      isLoading: false,
      isError: false,
      hasNextPage: false,
    });

    const user = userEvent.setup();
    const { rerender } = render(
      <VersionHistoryPanel documentId="doc-1" open onOpenChange={vi.fn()} canRestore={false} />,
    );
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(screen.queryByRole("button", { name: /Restore this version/ })).not.toBeInTheDocument();

    rerender(
      <VersionHistoryPanel documentId="doc-1" open onOpenChange={vi.fn()} canRestore />,
    );
    expect(screen.getByRole("button", { name: /Restore this version/ })).toBeInTheDocument();
  });

  it("confirms before restoring and calls the mutation with the selected version", async () => {
    useVersionsInfinite.mockReturnValue({
      data: { pages: [{ versions: [makeVersion({ version: 7 })], nextCursor: null }] },
      isLoading: false,
      isError: false,
      hasNextPage: false,
    });

    const user = userEvent.setup();
    render(<VersionHistoryPanel documentId="doc-1" open onOpenChange={vi.fn()} canRestore />);

    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(screen.getByRole("button", { name: /Restore this version/ }));

    expect(
      screen.getByText(/This will restore the document to this version/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restore" }));

    expect(restoreMutate).toHaveBeenCalledWith(7, expect.anything());
  });

  it("labels restore-point and post-restore versions distinctly", () => {
    useVersionsInfinite.mockReturnValue({
      data: {
        pages: [
          {
            versions: [
              makeVersion({
                version: 3,
                kind: "restore_point",
                label: "Before restore to v1",
                preview: "Hello World!!!",
              }),
            ],
            nextCursor: null,
          },
        ],
      },
      isLoading: false,
      isError: false,
      hasNextPage: false,
    });

    render(
      <VersionHistoryPanel documentId="doc-1" open onOpenChange={vi.fn()} canRestore={false} />,
    );

    expect(screen.getByText("Restore point")).toBeInTheDocument();
    expect(screen.getByText("Before restore to v1")).toBeInTheDocument();
  });
});
