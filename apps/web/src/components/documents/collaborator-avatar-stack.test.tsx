import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CollaboratorAvatarStack } from "./collaborator-avatar-stack";
import type { Collaborator } from "@sync-flow/schemas";

function makeCollaborator(n: number): Collaborator {
  return {
    userId: `user-${n}`,
    username: `user${n}`,
    displayName: `User ${n}`,
    presenceColor: "#4f46e5",
    role: "editor",
  };
}

describe("CollaboratorAvatarStack", () => {
  it("renders one avatar per collaborator when at or under the max", () => {
    const collaborators = [1, 2, 3].map(makeCollaborator);
    render(<CollaboratorAvatarStack collaborators={collaborators} />);
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it("caps visible avatars at 4 and shows a +N overflow badge", () => {
    const collaborators = [1, 2, 3, 4, 5, 6].map(makeCollaborator);
    const { container } = render(<CollaboratorAvatarStack collaborators={collaborators} />);
    expect(screen.getByText("+2")).toBeInTheDocument();
    // 4 visible avatars + 1 overflow badge = 5 direct children.
    expect(container.firstElementChild?.children).toHaveLength(5);
  });
});
