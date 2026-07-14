import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DocumentCard } from "./document-card";
import type { OptimisticDocumentListItem } from "@/hooks/use-documents";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const patchMutate = vi.fn();
vi.mock("@/hooks/use-documents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-documents")>();
  return {
    ...actual,
    usePatchDocument: () => ({ mutate: patchMutate }),
  };
});

vi.mock("./share-dialog", () => ({
  ShareDialog: ({ open }: { open: boolean }) => (open ? <div>share-dialog-open</div> : null),
}));
vi.mock("./delete-document-dialog", () => ({
  DeleteDocumentDialog: ({ open }: { open: boolean }) =>
    open ? <div>delete-dialog-open</div> : null,
}));

const baseDoc: OptimisticDocumentListItem = {
  id: "doc-1",
  title: "Product Roadmap",
  ownerId: "owner-1",
  isPublic: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  role: "owner",
  collaborators: [
    {
      userId: "owner-1",
      username: "owner",
      displayName: "Owner Person",
      presenceColor: "#4f46e5",
      role: "owner",
    },
  ],
};

describe("DocumentCard", () => {
  beforeEach(() => {
    push.mockClear();
    patchMutate.mockClear();
  });

  it("navigates to the document on click", async () => {
    const user = userEvent.setup();
    render(<DocumentCard doc={baseDoc} />);
    await user.click(screen.getByRole("link", { name: "Open Product Roadmap" }));
    expect(push).toHaveBeenCalledWith("/documents/doc-1");
  });

  it("does not navigate while the card is a pending optimistic placeholder", async () => {
    const user = userEvent.setup();
    render(<DocumentCard doc={{ ...baseDoc, pending: true }} />);
    await user.click(screen.getByText("Product Roadmap"));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByText("Creating…")).toBeInTheDocument();
  });

  it("shows a role badge for a non-owner but not for the owner", () => {
    const { rerender } = render(<DocumentCard doc={baseDoc} />);
    expect(screen.queryByText("owner")).not.toBeInTheDocument();

    rerender(<DocumentCard doc={{ ...baseDoc, role: "editor" }} />);
    expect(screen.getByText("editor")).toBeInTheDocument();
  });

  it("lets an owner click the title to rename, saving on blur", async () => {
    const user = userEvent.setup();
    render(<DocumentCard doc={baseDoc} />);

    await user.click(screen.getByRole("button", { name: "Product Roadmap" }));
    const input = screen.getByDisplayValue("Product Roadmap");
    await user.clear(input);
    await user.type(input, "Renamed Doc");
    await user.tab();

    await vi.waitFor(() => expect(patchMutate).toHaveBeenCalledWith({ title: "Renamed Doc" }));
  });

  it("does not let a non-owner click the title to rename", () => {
    render(<DocumentCard doc={{ ...baseDoc, role: "viewer" }} />);
    const title = screen.getByText("Product Roadmap");
    expect(title.tagName).toBe("BUTTON");
    expect(title).toBeDisabled();
  });

  it("hides Delete in the menu for a non-owner", async () => {
    const user = userEvent.setup();
    render(<DocumentCard doc={{ ...baseDoc, role: "editor" }} />);
    await user.click(screen.getByRole("button", { name: "Document actions" }));
    expect(screen.getByText("Share")).toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("shows Delete in the menu for the owner", async () => {
    const user = userEvent.setup();
    render(<DocumentCard doc={baseDoc} />);
    await user.click(screen.getByRole("button", { name: "Document actions" }));
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });
});
