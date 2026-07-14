import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@sync-flow/schemas";
import { DocumentGrid } from "./document-grid";
import type { OptimisticDocumentListItem } from "@/hooks/use-documents";

const useDocumentsInfinite = vi.fn();
const create = vi.fn();
vi.mock("@/hooks/use-documents", () => ({
  useDocumentsInfinite: () => useDocumentsInfinite(),
  useCreateDocumentAndNavigate: () => ({ create, isPending: false }),
}));

vi.mock("./document-card", () => ({
  DocumentCard: ({ doc }: { doc: OptimisticDocumentListItem }) => <div>card:{doc.title}</div>,
}));

function makeDoc(title: string): OptimisticDocumentListItem {
  return {
    id: title,
    title,
    ownerId: "owner-1",
    isPublic: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    role: "owner",
    collaborators: [],
  };
}

describe("DocumentGrid", () => {
  beforeEach(() => {
    useDocumentsInfinite.mockReset();
    create.mockClear();
  });

  it("shows skeleton placeholders while loading", () => {
    useDocumentsInfinite.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    const { container } = render(<DocumentGrid />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("shows an error message with a retry button", async () => {
    const refetch = vi.fn();
    useDocumentsInfinite.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new ApiError({
        type: "about:blank",
        title: "Server Error",
        status: 500,
        detail: "Boom",
      }),
      refetch,
    });
    const user = userEvent.setup();
    render(<DocumentGrid />);
    expect(screen.getByText("Boom")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("shows the empty-state CTA when there are no documents", async () => {
    useDocumentsInfinite.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { pages: [{ documents: [], pagination: { page: 1, pageSize: 20, total: 0 } }] },
    });
    const user = userEvent.setup();
    render(<DocumentGrid />);
    const cta = screen.getByRole("button", { name: "Create your first document" });
    await user.click(cta);
    expect(create).toHaveBeenCalled();
  });

  it("renders documents alongside the create-document tile", () => {
    useDocumentsInfinite.mockReturnValue({
      isLoading: false,
      isError: false,
      hasNextPage: false,
      data: {
        pages: [
          {
            documents: [makeDoc("Doc A"), makeDoc("Doc B")],
            pagination: { page: 1, pageSize: 20, total: 2 },
          },
        ],
      },
    });
    render(<DocumentGrid />);
    expect(screen.getByText("card:Doc A")).toBeInTheDocument();
    expect(screen.getByText("card:Doc B")).toBeInTheDocument();
    expect(screen.getByText("New document")).toBeInTheDocument();
  });
});
