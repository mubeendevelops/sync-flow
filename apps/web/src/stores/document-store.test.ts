import { describe, expect, it, beforeEach } from "vitest";
import { useDocumentStore } from "./document-store";

describe("useDocumentStore", () => {
  beforeEach(() => {
    useDocumentStore.setState({ activeDocumentId: null, connectionState: "offline" });
  });

  it("defaults to no active document and offline", () => {
    const state = useDocumentStore.getState();
    expect(state.activeDocumentId).toBeNull();
    expect(state.connectionState).toBe("offline");
  });

  it("tracks the active document id", () => {
    useDocumentStore.getState().setActiveDocumentId("doc-123");
    expect(useDocumentStore.getState().activeDocumentId).toBe("doc-123");
  });

  it("transitions connection state independently of the active document", () => {
    useDocumentStore.getState().setConnectionState("connected");
    expect(useDocumentStore.getState().connectionState).toBe("connected");
    expect(useDocumentStore.getState().activeDocumentId).toBeNull();
  });
});
